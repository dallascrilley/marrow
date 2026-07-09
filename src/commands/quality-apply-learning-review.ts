import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import type { CommandContext } from "../cli.js";
import { getRuntimePath, getRuntimeRoot } from "../config/paths.js";
import { listSourceSessions } from "../db/ledger.js";
import { type Learning, learningSchema, type SourceSession } from "../models/canonical.js";
import type { SupportedSource } from "../pipeline/discover.js";
import { validateSuggestedStatement } from "../pipeline/prompt-sanitize.js";
import { syncReviewedLearningsToInstinctStore } from "../v2/learning/sync-reviewed.js";
import { resolveProjectIdForSession } from "../v2/project/resolve.js";

export async function executeQualityApplyLearningReview(
  context: CommandContext,
  _database: DatabaseSync,
): Promise<number> {
  const options = parseOptions(context.args);
  const inputPath = options.input ?? join(getRuntimePath("reports"), "llm-learning-review.jsonl");
  const reviews = await readReviewSidecar(inputPath);
  const sessionsById = new Map(
    listSourceSessions(_database).map((session) => [session.session_id, session]),
  );
  const originalLearnings = await readOriginalProjectLearnings(reviews, sessionsById);
  const reviewedLearningsBySession = new Map<string, Learning[]>();
  const rejected = [];
  const skipped = [];

  for (const review of reviews) {
    const original = originalLearnings.get(review.learning_id);
    if (original === undefined) {
      skipped.push({
        learning_id: review.learning_id,
        reason: "missing_original_learning",
      });
      continue;
    }

    const validationFlags = validateSuggestedStatement(review.suggested_statement);
    if (!review.keep || review.durability !== "durable" || validationFlags.length > 0) {
      rejected.push({
        learning_id: review.learning_id,
        reason: review.reason,
        validation_flags: validationFlags,
        verdict: review.verdict,
        durability: review.durability,
      });
      continue;
    }

    const rewritten = learningSchema.parse({
      ...original,
      statement: review.suggested_statement,
      title: original.title,
      trigger: normalizeReviewedTrigger(review.trigger, original.trigger),
      promotion_basis: `${original.promotion_basis} LLM-reviewed with ${review.verdict} verdict.`,
    });
    const sessionLearnings = reviewedLearningsBySession.get(review.session_id) ?? [];
    sessionLearnings.push(rewritten);
    reviewedLearningsBySession.set(review.session_id, sessionLearnings);
  }

  const instinctSync: Array<{
    session_id: string;
    project_key: string;
    project_id: string;
    instinct_count: number;
  }> = [];

  for (const [sessionId, learnings] of reviewedLearningsBySession) {
    const session = sessionsById.get(sessionId);
    if (session === undefined || learnings.length === 0) {
      continue;
    }

    const projectId = (await resolveProjectIdForSession(session)).id;
    const outputPath = getReviewedProjectKnowledgePath(projectId, sessionId);
    await writeJsonlFile(outputPath, learnings);

    const reviewedAt = new Date().toISOString();
    const syncResult = await syncReviewedLearningsToInstinctStore({
      session,
      learnings,
      sourceAdapter: session.source_tool as SupportedSource,
      reviewedAt,
      reviewer: "quality-apply-learning-review",
    });
    instinctSync.push({
      session_id: sessionId,
      project_key: session.project_key,
      project_id: syncResult.projectId,
      instinct_count: syncResult.instinctCount,
    });
  }

  const reportPath = join(getRuntimePath("reports"), "llm-learning-review-apply.json");
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(
    reportPath,
    `${JSON.stringify(
      {
        input: inputPath,
        kept: [...reviewedLearningsBySession.values()].reduce(
          (sum, learnings) => sum + learnings.length,
          0,
        ),
        rejected: rejected.length,
        skipped: skipped.length,
        output_root: join(getRuntimeRoot(), "knowledge/projects-reviewed"),
        instinct_sync: instinctSync,
        rejected_details: rejected,
        skipped_details: skipped,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  context.output.info(
    JSON.stringify(
      {
        input: inputPath,
        kept: [...reviewedLearningsBySession.values()].reduce(
          (sum, learnings) => sum + learnings.length,
          0,
        ),
        rejected: rejected.length,
        skipped: skipped.length,
        output_root: join(getRuntimeRoot(), "knowledge/projects-reviewed"),
        report: reportPath,
      },
      null,
      2,
    ),
  );

  return 0;
}

type ApplyReviewOptions = {
  input?: string | undefined;
};

type ReviewSidecarEntry = {
  durability: string;
  keep: boolean;
  learning_id: string;
  reason: string;
  scope_key: string;
  session_id: string;
  statement: string;
  suggested_statement: string;
  verdict: string;
  trigger?: string | undefined;
};

function parseOptions(args: readonly string[]): ApplyReviewOptions {
  return {
    input: parseStringOption(args, "--input"),
  };
}

function parseStringOption(args: readonly string[], flag: string): string | undefined {
  const flagIndex = args.indexOf(flag);
  if (flagIndex === -1) {
    return undefined;
  }

  const value = args[flagIndex + 1];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${flag} requires a value`);
  }

  return value;
}

const reviewSidecarEntrySchema = z.object({
  durability: z.string(),
  keep: z.boolean(),
  learning_id: z.string(),
  reason: z.string(),
  scope_key: z.string(),
  session_id: z.string(),
  statement: z.string(),
  suggested_statement: z.string(),
  trigger: z.string().optional(),
  verdict: z.string(),
});

async function readReviewSidecar(path: string): Promise<ReviewSidecarEntry[]> {
  const contents = await readFile(path, "utf8");
  return contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => reviewSidecarEntrySchema.parse(JSON.parse(line)));
}

function normalizeReviewedTrigger(
  reviewedTrigger: string | undefined,
  originalTrigger: string,
): string {
  const trimmed = reviewedTrigger?.replace(/\s+/g, " ").trim();
  return trimmed && trimmed.length > 0 ? trimmed : originalTrigger;
}

async function readOriginalProjectLearnings(
  reviews: readonly ReviewSidecarEntry[],
  sessionsById: ReadonlyMap<
    string,
    Pick<SourceSession, "project_key" | "workspace_path" | "session_id">
  >,
): Promise<Map<string, Learning>> {
  const originalLearnings = new Map<string, Learning>();
  const sessionIds = [...new Set(reviews.map((review) => review.session_id))];
  for (const sessionId of sessionIds) {
    const session = sessionsById.get(sessionId);
    if (session === undefined) {
      continue;
    }

    const projectId = (await resolveProjectIdForSession(session)).id;
    for (const learning of await readProjectLearningFile(
      session.project_key,
      projectId,
      session.session_id,
    )) {
      originalLearnings.set(learning.learning_id, learning);
    }
  }

  return originalLearnings;
}

async function readProjectLearningFile(
  legacyProjectKey: string,
  resolvedProjectId: string,
  sessionId: string,
): Promise<Learning[]> {
  for (const projectKey of uniqueKeys(legacyProjectKey, resolvedProjectId)) {
    try {
      const contents = await readFile(
        join(getRuntimePath("knowledgeProjects"), projectKey, `${sessionId}.jsonl`),
        "utf8",
      );
      return contents
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => learningSchema.parse(JSON.parse(line)));
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }
  }

  return [];
}

function uniqueKeys(...keys: string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const key of keys) {
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(key);
  }
  return ordered;
}

function getReviewedProjectKnowledgePath(projectKey: string, sessionId: string): string {
  return join(getRuntimeRoot(), "knowledge/projects-reviewed", projectKey, `${sessionId}.jsonl`);
}

async function writeJsonlFile(path: string, entries: readonly Learning[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
