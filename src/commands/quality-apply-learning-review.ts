import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type { CommandContext } from "../cli.js";
import { getRuntimePath, getRuntimeRoot } from "../config/paths.js";
import { listSourceSessions } from "../db/ledger.js";
import { type Learning, learningSchema, type SourceSession } from "../models/canonical.js";
import type { SupportedSource } from "../pipeline/discover.js";
import {
  appendLlmLearningReviewApplyLedgerEntry,
  getLatestLlmLearningReviewApplyEntry,
  type LlmLearningReviewApplyOutput,
  readLlmLearningReviewApplyLedger,
} from "../pipeline/llm-learning-review-apply-ledger.js";
import {
  buildLearningReviewInputContentHash,
  type LearningReviewBatch,
  readLatestLearningReviewBatch,
  readLearningReviewBatch,
} from "../pipeline/llm-learning-review-batch.js";
import { validateSuggestedStatement } from "../pipeline/prompt-sanitize.js";
import { syncReviewedLearningsToInstinctStore } from "../v2/learning/sync-reviewed.js";
import { resolveProjectIdForSession } from "../v2/project/resolve.js";
import { refreshPromotionQueue } from "../v2/promotion/queue.js";

export type QualityApplyLearningReviewDependencies = {
  afterSessionApplied?: ((sessionId: string) => Promise<void>) | undefined;
};

export async function executeQualityApplyLearningReview(
  context: CommandContext,
  database: DatabaseSync,
  dependencies: QualityApplyLearningReviewDependencies = {},
): Promise<number> {
  const options = parseOptions(context.args);
  const selected = await selectBatch(options);
  const { batch, batchPath } = selected;
  const applyLedger = await readLlmLearningReviewApplyLedger();
  const latestApply = getLatestLlmLearningReviewApplyEntry(applyLedger, batch.batch_id);
  if (latestApply?.status === "applied") {
    return writeNoOpResult(context, batch, batchPath, latestApply.outputs);
  }

  const sessionsById = new Map(
    listSourceSessions(database).map((session) => [session.session_id, session]),
  );
  const originalLearnings = await readOriginalProjectLearnings(batch, sessionsById);
  const reviewedLearningsBySession = new Map<string, Learning[]>();
  const rejected = [];
  const skipped = [];

  for (const review of batch.reviews) {
    const original = originalLearnings.get(
      originalLearningKey(review.session_id, review.learning_id),
    );
    if (original === undefined) {
      skipped.push({ learning_id: review.learning_id, reason: "missing_original_learning" });
      continue;
    }
    if (buildLearningReviewInputContentHash(original) !== review.input_content_hash) {
      skipped.push({ learning_id: review.learning_id, reason: "input_content_hash_mismatch" });
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

  const applyId = `${batch.created_at.replace(/[:.]/g, "-")}-${randomUUID()}`;
  const affectedSessions = [...reviewedLearningsBySession.keys()].sort();
  await appendLlmLearningReviewApplyLedgerEntry({
    schema_version: "llm-learning-review-apply-ledger-v1",
    apply_id: applyId,
    batch_id: batch.batch_id,
    batch_path: batchPath,
    recorded_at: new Date().toISOString(),
    reviewed_at: batch.created_at,
    status: "applying",
    affected_sessions: affectedSessions,
  });

  const instinctSync: Array<{
    session_id: string;
    project_key: string;
    project_id: string;
    instinct_count: number;
  }> = [];
  const outputs: LlmLearningReviewApplyOutput[] = [];

  try {
    for (const sessionId of affectedSessions) {
      const newLearnings = reviewedLearningsBySession.get(sessionId) ?? [];
      const session = sessionsById.get(sessionId);
      if (session === undefined || newLearnings.length === 0) continue;

      const projectId = (await resolveProjectIdForSession(session)).id;
      const outputPath = getReviewedProjectKnowledgePath(projectId, sessionId);
      const priorLearnings = await readReviewedProjectLearnings(outputPath);
      const mergedLearnings = mergeLearningsById(priorLearnings, newLearnings);
      const serialized = serializeJsonl(mergedLearnings);
      await atomicWriteFile(outputPath, serialized);

      const syncResult = await syncReviewedLearningsToInstinctStore({
        session,
        learnings: mergedLearnings,
        sourceAdapter: session.source_tool as SupportedSource,
        reviewedAt: batch.created_at,
        reviewer: "quality-apply-learning-review",
      });
      instinctSync.push({
        session_id: sessionId,
        project_key: session.project_key,
        project_id: syncResult.projectId,
        instinct_count: syncResult.instinctCount,
      });
      outputs.push({
        content_hash: sha256(serialized),
        learning_count: mergedLearnings.length,
        path: outputPath,
        project_id: projectId,
        session_id: sessionId,
      });
      await dependencies.afterSessionApplied?.(sessionId);
    }

    if (instinctSync.length > 0) await refreshPromotionQueue(batch.created_at);

    const report = buildApplyReport({
      batch,
      batchPath,
      reviewedLearningsBySession,
      rejected,
      skipped,
      outputs,
      instinctSync,
    });
    const reportPath = await writeApplyReport(report);
    await appendLlmLearningReviewApplyLedgerEntry({
      schema_version: "llm-learning-review-apply-ledger-v1",
      apply_id: applyId,
      batch_id: batch.batch_id,
      batch_path: batchPath,
      recorded_at: new Date().toISOString(),
      reviewed_at: batch.created_at,
      status: "applied",
      affected_sessions: affectedSessions,
      outputs,
    });
    context.output.info(JSON.stringify({ ...report, report: reportPath }, null, 2));
  } catch (error) {
    await appendLlmLearningReviewApplyLedgerEntry({
      schema_version: "llm-learning-review-apply-ledger-v1",
      apply_id: applyId,
      batch_id: batch.batch_id,
      batch_path: batchPath,
      recorded_at: new Date().toISOString(),
      reviewed_at: batch.created_at,
      status: "failed",
      error: errorMessage(error),
    });
    throw error;
  }

  return 0;
}

type ApplyReviewOptions = {
  batch?: string | undefined;
  latest: boolean;
};

function parseOptions(args: readonly string[]): ApplyReviewOptions {
  if (args.includes("--input")) {
    throw new Error("--input is no longer supported; pass --batch <path> or --latest");
  }
  const batch = parseStringOption(args, "--batch");
  const latest = args.includes("--latest");
  if (batch !== undefined && latest) throw new Error("Pass either --batch or --latest, not both");
  return { batch, latest };
}

function parseStringOption(args: readonly string[], flag: string): string | undefined {
  const flagIndex = args.indexOf(flag);
  if (flagIndex === -1) return undefined;
  const value = args[flagIndex + 1];
  if (value === undefined || value.trim().length === 0) throw new Error(`${flag} requires a value`);
  return value;
}

async function selectBatch(
  options: ApplyReviewOptions,
): Promise<{ batch: LearningReviewBatch; batchPath: string }> {
  if (options.batch !== undefined) {
    return { batch: await readLearningReviewBatch(options.batch), batchPath: options.batch };
  }
  if (!options.latest) {
    throw new Error("quality apply-learning-review requires --batch <path> or --latest");
  }
  return readLatestLearningReviewBatch(getRuntimePath("reports"));
}

async function readOriginalProjectLearnings(
  batch: LearningReviewBatch,
  sessionsById: ReadonlyMap<
    string,
    Pick<SourceSession, "project_key" | "workspace_path" | "session_id">
  >,
): Promise<Map<string, Learning>> {
  const originalLearnings = new Map<string, Learning>();
  const sessionIds = [...new Set(batch.reviews.map((review) => review.session_id))];
  for (const sessionId of sessionIds) {
    const session = sessionsById.get(sessionId);
    if (session === undefined) continue;
    const projectId = (await resolveProjectIdForSession(session)).id;
    for (const learning of await readProjectLearningFile(
      session.project_key,
      projectId,
      session.session_id,
    )) {
      originalLearnings.set(originalLearningKey(sessionId, learning.learning_id), learning);
    }
  }
  return originalLearnings;
}

function originalLearningKey(sessionId: string, learningId: string): string {
  return `${sessionId}\u0000${learningId}`;
}

async function readProjectLearningFile(
  legacyProjectKey: string,
  resolvedProjectId: string,
  sessionId: string,
): Promise<Learning[]> {
  for (const projectKey of uniqueKeys(legacyProjectKey, resolvedProjectId)) {
    try {
      return parseLearningJsonl(
        await readFile(
          join(getRuntimePath("knowledgeProjects"), projectKey, `${sessionId}.jsonl`),
          "utf8",
        ),
      );
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
  }
  return [];
}

async function readReviewedProjectLearnings(path: string): Promise<Learning[]> {
  try {
    return parseLearningJsonl(await readFile(path, "utf8"));
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw error;
  }
}

function parseLearningJsonl(contents: string): Learning[] {
  return contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => learningSchema.parse(JSON.parse(line)));
}

function mergeLearningsById(
  priorLearnings: readonly Learning[],
  newLearnings: readonly Learning[],
): Learning[] {
  const merged = new Map(priorLearnings.map((learning) => [learning.learning_id, learning]));
  for (const learning of newLearnings) merged.set(learning.learning_id, learning);
  return [...merged.values()].sort((left, right) =>
    left.learning_id.localeCompare(right.learning_id),
  );
}

function normalizeReviewedTrigger(
  reviewedTrigger: string | undefined,
  originalTrigger: string,
): string {
  const trimmed = reviewedTrigger?.replace(/\s+/g, " ").trim();
  return trimmed && trimmed.length > 0 ? trimmed : originalTrigger;
}

function uniqueKeys(...keys: string[]): string[] {
  return [...new Set(keys)];
}

function getReviewedProjectKnowledgePath(projectKey: string, sessionId: string): string {
  return join(getRuntimeRoot(), "knowledge/projects-reviewed", projectKey, `${sessionId}.jsonl`);
}

function serializeJsonl(entries: readonly Learning[]): string {
  return entries.length === 0
    ? ""
    : `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

async function atomicWriteFile(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, contents, { encoding: "utf8", flag: "wx" });
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

function sha256(contents: string): string {
  return `sha256:${createHash("sha256").update(contents).digest("hex")}`;
}

function buildApplyReport(input: {
  batch: LearningReviewBatch;
  batchPath: string;
  reviewedLearningsBySession: ReadonlyMap<string, readonly Learning[]>;
  rejected: readonly unknown[];
  skipped: readonly unknown[];
  outputs: readonly LlmLearningReviewApplyOutput[];
  instinctSync: readonly unknown[];
}): object {
  return {
    batch_id: input.batch.batch_id,
    batch_path: input.batchPath,
    reviewed_at: input.batch.created_at,
    status: "applied",
    no_op: false,
    kept: [...input.reviewedLearningsBySession.values()].reduce(
      (sum, learnings) => sum + learnings.length,
      0,
    ),
    rejected: input.rejected.length,
    skipped: input.skipped.length,
    output_root: join(getRuntimeRoot(), "knowledge/projects-reviewed"),
    outputs: input.outputs,
    instinct_sync: input.instinctSync,
    rejected_details: input.rejected,
    skipped_details: input.skipped,
  };
}

async function writeApplyReport(report: object): Promise<string> {
  const reportPath = join(getRuntimePath("reports"), "llm-learning-review-apply.json");
  await atomicWriteFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return reportPath;
}

async function writeNoOpResult(
  context: CommandContext,
  batch: LearningReviewBatch,
  batchPath: string,
  outputs: readonly LlmLearningReviewApplyOutput[],
): Promise<number> {
  const report = {
    batch_id: batch.batch_id,
    batch_path: batchPath,
    reviewed_at: batch.created_at,
    status: "applied",
    no_op: true,
    outputs,
  };
  const reportPath = await writeApplyReport(report);
  context.output.info(JSON.stringify({ ...report, report: reportPath }, null, 2));
  return 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
