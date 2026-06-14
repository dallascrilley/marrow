import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type { CommandContext } from "../cli.js";
import { getRuntimePath } from "../config/paths.js";
import { listSourceSessions } from "../db/ledger.js";
import { type Learning, learningSchema } from "../models/canonical.js";
import {
  assessLlmBudget,
  getDefaultMaxPerWindow,
  recordLlmBudgetUse,
} from "../pipeline/llm-budget.js";
import {
  type ReviewedLearning,
  reviewProjectLearningsWithOpenRouter,
} from "../pipeline/llm-learning-review.js";
import { countPendingLlmReview } from "../pipeline/pipeline-gate.js";
import { getProjectKnowledgeSessionPath } from "../writers/knowledge-writer.js";

export async function executeQualityReviewLearnings(
  context: CommandContext,
  database: DatabaseSync,
): Promise<number> {
  const options = parseOptions(context.args);

  if (options.ifNew) {
    const pending = await countPendingLlmReview();
    if (pending.pending_learnings === 0) {
      context.output.info(
        JSON.stringify(
          {
            count: 0,
            skipped: true,
            skip_reason: "no_unreviewed_project_learnings",
            total_reviewed_learnings: 0,
          },
          null,
          2,
        ),
      );
      return 0;
    }
  }

  const maxPer = options.maxPer ?? getDefaultMaxPerWindow();
  const budget = await assessLlmBudget(maxPer);
  if (!budget.allowed) {
    context.output.info(
      JSON.stringify(
        {
          count: 0,
          llm_budget: budget,
          skipped: true,
          skip_reason: "llm_budget_exhausted",
          total_reviewed_learnings: 0,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  const sessions = listSourceSessions(database).slice(0, options.limit);
  const reviewed = [];
  let reviewedLearningCount = 0;

  for (const session of sessions) {
    if (
      options.maxTotalLearnings !== undefined &&
      reviewedLearningCount >= options.maxTotalLearnings
    ) {
      break;
    }
    const learnings = await readProjectLearnings(session.project_key, session.session_id);
    if (learnings.length === 0) {
      continue;
    }

    const remainingLearningBudget =
      options.maxTotalLearnings === undefined
        ? undefined
        : options.maxTotalLearnings - reviewedLearningCount;
    const selectedLearnings = learnings.slice(
      0,
      Math.min(
        learnings.length,
        options.maxLearnings ?? learnings.length,
        remainingLearningBudget ?? learnings.length,
      ),
    );
    let sessionReviews: ReviewedLearning[];
    try {
      sessionReviews = await reviewProjectLearningsWithOpenRouter({
        cacheDir:
          options.noCache === true
            ? undefined
            : (options.cacheDir ?? join(getRuntimePath("root"), "cache", "llm-learning-review")),
        learnings: selectedLearnings,
        model: options.model,
        noCache: options.noCache,
        projectKey: session.project_key,
        refreshLlm: options.refreshLlm,
      });
    } catch (error) {
      for (const learning of selectedLearnings) {
        reviewed.push({
          learning_id: learning.learning_id,
          reason: error instanceof Error ? error.message : String(error),
          scope_key: learning.scope_key,
          session_id: session.session_id,
          statement: learning.statement,
          suggested_statement: learning.statement,
          verdict: "reject",
          durability: "unclear",
          keep: false,
        });
      }
      reviewedLearningCount += selectedLearnings.length;
      continue;
    }

    for (const review of sessionReviews) {
      reviewed.push({
        learning_id: review.learning.learning_id,
        reason: review.review.reason,
        scope_key: review.learning.scope_key,
        session_id: session.session_id,
        statement: review.learning.statement,
        suggested_statement: review.review.statement,
        verdict: review.review.verdict,
        durability: review.review.durability,
        keep: review.review.keep,
      });
    }
    reviewedLearningCount += sessionReviews.length;
  }

  if (reviewedLearningCount > 0) {
    await recordLlmBudgetUse(maxPer);
  }

  const outputPath = join(getRuntimePath("reports"), "llm-learning-review.jsonl");
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(
    outputPath,
    reviewed.length === 0 ? "" : `${reviewed.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf8",
  );

  context.output.info(
    JSON.stringify(
      {
        count: reviewed.length,
        cache:
          options.noCache === true
            ? "disabled"
            : (options.cacheDir ?? join(getRuntimePath("root"), "cache", "llm-learning-review")),
        model: options.model ?? process.env.OPENROUTER_MODEL ?? "openai/gpt-5-nano",
        path: outputPath,
        rejected: reviewed.filter((entry) => !entry.keep).length,
        rewrites: reviewed.filter((entry) => entry.verdict === "rewrite").length,
        total_sessions: sessions.length,
        total_reviewed_learnings: reviewedLearningCount,
      },
      null,
      2,
    ),
  );

  return 0;
}

type ReviewLearningsOptions = {
  ifNew?: boolean | undefined;
  limit?: number | undefined;
  cacheDir?: string | undefined;
  maxLearnings?: number | undefined;
  maxPer?: string | undefined;
  maxTotalLearnings?: number | undefined;
  model?: string | undefined;
  noCache?: boolean | undefined;
  refreshLlm?: boolean | undefined;
};

function parseOptions(args: readonly string[]): ReviewLearningsOptions {
  return {
    cacheDir: parseStringOption(args, "--cache-dir"),
    ifNew: args.includes("--if-new"),
    limit: parseIntegerOption(args, "--limit"),
    maxLearnings: parseIntegerOption(args, "--max-learnings"),
    maxPer: parseStringOption(args, "--max-per"),
    maxTotalLearnings: parseIntegerOption(args, "--max-total-learnings"),
    model: parseStringOption(args, "--model"),
    noCache: args.includes("--no-cache"),
    refreshLlm: args.includes("--refresh-llm"),
  };
}

function parseIntegerOption(args: readonly string[], flag: string): number | undefined {
  const value = parseStringOption(args, flag);
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`quality review-learnings ${flag} requires a non-negative integer`);
  }

  return parsed;
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

async function readProjectLearnings(projectKey: string, sessionId: string): Promise<Learning[]> {
  try {
    const contents = await readFile(getProjectKnowledgeSessionPath(projectKey, sessionId), "utf8");
    return contents
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => learningSchema.parse(JSON.parse(line)));
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }

    throw error;
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
