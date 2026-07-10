import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type { CommandContext } from "../cli.js";
import { getRuntimePath } from "../config/paths.js";
import { listSourceSessions } from "../db/ledger.js";
import { type Learning, learningSchema, summarySchema } from "../models/canonical.js";
import { type PreLlmSkip, partitionLearningsForReview } from "../pipeline/learning-prefilter.js";
import {
  assessLlmBudget,
  assessUsdBudget,
  getDefaultMaxPerWindow,
  getDefaultMaxUsd,
  recordLlmBudgetUse,
} from "../pipeline/llm-budget.js";
import {
  defaultOpenRouterLearningReviewModel,
  reviewLearningsBatchedWithOpenRouter,
} from "../pipeline/llm-learning-review.js";
import {
  buildLearningReviewBatch,
  buildLearningReviewInputContentHash,
  listLearningReviewBatches,
  writeLearningReviewBatch,
} from "../pipeline/llm-learning-review-batch.js";
import {
  appendLlmLearningReviewLedgerEntries,
  readLlmLearningReviewLedgerIds,
  readLlmLearningReviewLedgerWatermark,
} from "../pipeline/llm-learning-review-ledger.js";
import { appendLlmTelemetry, buildLlmTelemetryRecord } from "../pipeline/llm-telemetry.js";
import { countPendingLlmReview } from "../pipeline/pipeline-gate.js";
import { isLowSignalTopic } from "../pipeline/summarize.js";
import { getProjectKnowledgeSessionPath } from "../writers/knowledge-writer.js";
import { getSessionSummaryJsonPath } from "../writers/summary-writer.js";

type QualityReviewLearningsDependencies = {
  appendLedgerEntries?: typeof appendLlmLearningReviewLedgerEntries;
  writeBatch?: typeof writeLearningReviewBatch;
};

export async function executeQualityReviewLearnings(
  context: CommandContext,
  database: DatabaseSync,
  dependencies: QualityReviewLearningsDependencies = {},
): Promise<number> {
  const appendLedgerEntries =
    dependencies.appendLedgerEntries ?? appendLlmLearningReviewLedgerEntries;
  const writeBatch = dependencies.writeBatch ?? writeLearningReviewBatch;
  const reportsDir = getRuntimePath("reports");
  await reconcilePublishedLearningReviewBatches({ appendLedgerEntries, reportsDir });
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
  const maxUsd = options.maxUsd ?? getDefaultMaxUsd();
  const budget = await assessLlmBudget(maxPer);
  const usdBudget = await assessUsdBudget(maxUsd);
  // Run only when BOTH the count cap and the hard USD ceiling allow it. The USD
  // gate budgets on effective (upstream) cost so it still fires for BYOK keys.
  if (!budget.allowed || !usdBudget.allowed) {
    context.output.info(
      JSON.stringify(
        {
          count: 0,
          llm_budget: budget,
          usd_budget: usdBudget,
          skipped: true,
          skip_reason: budget.allowed ? "llm_usd_budget_exhausted" : "llm_budget_exhausted",
          total_reviewed_learnings: 0,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  const sessions = listSourceSessions(database).slice(0, options.limit);
  const reviewedLearningIds = await readLlmLearningReviewLedgerIds();
  const sourceLedgerWatermark = await readLlmLearningReviewLedgerWatermark();
  const reviewed = [];
  const failures: Array<{ learning_id: string; reason: string; session_id: string }> = [];
  // Pre-LLM filter state: skips collected across the run, and a set of
  // normalized statements seen so far so cross-session duplicates are dropped.
  const prefilterSkipped: PreLlmSkip[] = [];
  const seenStatements = new Set<string>();
  let reviewedLearningCount = 0;
  let terminalFailureReason: string | undefined;

  for (const session of sessions) {
    if (
      options.maxTotalLearnings !== undefined &&
      reviewedLearningCount >= options.maxTotalLearnings
    ) {
      break;
    }
    // Skip whole low-signal sessions (e.g. chief-of-staff heartbeats, agent-driver
    // continuations) before paying to review any of their learnings. Their summary
    // topic flags them as junk, and their extracted learnings are near-uniformly
    // tool output and error dumps, so reviewing them wastes spend.
    const sessionTopic = await readSessionTopic(session.session_id);
    if (sessionTopic !== null && isLowSignalTopic(sessionTopic)) {
      const junkLearnings = await readProjectLearnings(session.project_key, session.session_id);
      for (const learning of junkLearnings) {
        prefilterSkipped.push({
          learning_id: learning.learning_id,
          session_id: session.session_id,
          reason: "low_signal_session",
        });
      }
      continue;
    }
    const learnings = await readProjectLearnings(session.project_key, session.session_id);
    const unreviewedLearnings = learnings.filter(
      (learning) => !reviewedLearningIds.has(learning.learning_id),
    );
    if (unreviewedLearnings.length === 0) {
      continue;
    }

    const remainingLearningBudget =
      options.maxTotalLearnings === undefined
        ? undefined
        : options.maxTotalLearnings - reviewedLearningCount;
    const selectedLearnings = unreviewedLearnings.slice(
      0,
      Math.min(
        unreviewedLearnings.length,
        options.maxLearnings ?? unreviewedLearnings.length,
        remainingLearningBudget ?? unreviewedLearnings.length,
      ),
    );
    // Drop deterministic junk + duplicates before paying for any review. These
    // never reach the OpenRouter fetch.
    const { toReview, skipped } = partitionLearningsForReview(
      selectedLearnings,
      session.session_id,
      seenStatements,
    );
    prefilterSkipped.push(...skipped);

    const cacheDir =
      options.noCache === true
        ? undefined
        : (options.cacheDir ?? join(getRuntimePath("root"), "cache", "llm-learning-review"));

    // Review the session's misses in bounded batches (one HTTP call each); the
    // batch function serves cache hits without a call and amortizes the system
    // prompt across the rest.
    const outcome = await reviewLearningsBatchedWithOpenRouter({
      batchSize: options.batchSize,
      cacheDir,
      learnings: toReview,
      model: options.model,
      noCache: options.noCache,
      projectKey: session.project_key,
      refreshLlm: options.refreshLlm,
    });
    const sessionReviews = outcome.reviewed;
    for (const failure of outcome.failures) {
      // A provider/transport failure is NOT a review verdict. Record it as a
      // failure (not a `reject` sidecar entry) and leave the learning unreviewed
      // so it remains pending for a later retry.
      failures.push({
        learning_id: failure.learning.learning_id,
        reason: failure.reason,
        session_id: session.session_id,
      });
    }
    if (outcome.terminalFailureReason !== undefined) {
      terminalFailureReason = outcome.terminalFailureReason;
    }

    for (const review of sessionReviews) {
      reviewed.push({
        input_content_hash: buildLearningReviewInputContentHash(review.learning),
        learning_id: review.learning.learning_id,
        reason: review.review.reason,
        scope_key: review.learning.scope_key,
        session_id: session.session_id,
        statement: review.learning.statement,
        suggested_statement: review.review.statement,
        verdict: review.review.verdict,
        durability: review.review.durability,
        keep: review.review.keep,
        trigger: review.review.trigger,
      });
      await appendLlmTelemetry(
        buildLlmTelemetryRecord({
          usage: review.usage,
          operation: "learning_review",
          sessionId: session.session_id,
          learningId: review.learning.learning_id,
          createdAt: new Date().toISOString(),
        }),
      );
    }
    for (const review of sessionReviews) {
      reviewedLearningIds.add(review.learning.learning_id);
    }
    reviewedLearningCount += sessionReviews.length;

    if (terminalFailureReason !== undefined) {
      break;
    }
  }

  const model =
    options.model ?? process.env.OPENROUTER_MODEL ?? defaultOpenRouterLearningReviewModel;
  let generatedBatch: Awaited<ReturnType<typeof writeLearningReviewBatch>> | undefined;
  if (reviewed.length > 0) {
    const createdAt = new Date().toISOString();
    generatedBatch = await writeBatch({
      batch: buildLearningReviewBatch({
        createdAt,
        model,
        reviews: reviewed,
        runId: `${createdAt.replace(/[:.]/g, "-")}-${randomUUID()}`,
        sourceLedgerWatermark,
      }),
      reportsDir,
    });
    const publishedBatch = generatedBatch.batch;
    await appendLedgerEntries(
      publishedBatch.reviews.map((review) => ({
        batch_id: publishedBatch.batch_id,
        learning_id: review.learning_id,
        verdict: review.verdict,
        reviewed_at: publishedBatch.created_at,
        session_id: review.session_id,
      })),
    );
    await recordLlmBudgetUse(maxPer, { usageId: generatedBatch.batch.batch_id });
  }

  const providerFailed = reviewed.length === 0 && failures.length > 0;

  context.output.info(
    JSON.stringify(
      {
        count: reviewed.length,
        cache:
          options.noCache === true
            ? "disabled"
            : (options.cacheDir ?? join(getRuntimePath("root"), "cache", "llm-learning-review")),
        failed: failures.length,
        ...(providerFailed
          ? {
              skipped: true,
              skip_reason: "llm_provider_error",
              failure_reason: (terminalFailureReason ?? failures[0]?.reason ?? "").slice(0, 200),
            }
          : {}),
        model,
        batch_id: generatedBatch?.batch.batch_id ?? null,
        batch_path: generatedBatch?.batchPath ?? null,
        batch_status: generatedBatch?.batch.status ?? null,
        generated_batch: generatedBatch !== undefined,
        latest_pointer: generatedBatch?.latestPointerPath ?? null,
        rejected: reviewed.filter((entry) => !entry.keep).length,
        rewrites: reviewed.filter((entry) => entry.verdict === "rewrite").length,
        skipped_pre_llm: prefilterSkipped.length,
        skipped_pre_llm_breakdown: {
          low_signal: prefilterSkipped.filter((entry) => entry.reason === "low_signal").length,
          duplicate: prefilterSkipped.filter((entry) => entry.reason === "duplicate").length,
          low_signal_session: prefilterSkipped.filter(
            (entry) => entry.reason === "low_signal_session",
          ).length,
        },
        usd_budget: usdBudget,
        total_sessions: sessions.length,
        total_reviewed_learnings: reviewedLearningCount,
      },
      null,
      2,
    ),
  );

  return 0;
}

async function reconcilePublishedLearningReviewBatches(input: {
  appendLedgerEntries: typeof appendLlmLearningReviewLedgerEntries;
  reportsDir: string;
}): Promise<void> {
  for (const { batch } of await listLearningReviewBatches(input.reportsDir)) {
    await input.appendLedgerEntries(
      batch.reviews.map((review) => ({
        batch_id: batch.batch_id,
        learning_id: review.learning_id,
        verdict: review.verdict,
        reviewed_at: batch.created_at,
        session_id: review.session_id,
      })),
    );
    await recordLlmBudgetUse(getDefaultMaxPerWindow(), {
      usageId: batch.batch_id,
      usedAt: batch.created_at,
    });
  }
}

type ReviewLearningsOptions = {
  batchSize?: number | undefined;
  ifNew?: boolean | undefined;
  limit?: number | undefined;
  cacheDir?: string | undefined;
  maxLearnings?: number | undefined;
  maxPer?: string | undefined;
  maxTotalLearnings?: number | undefined;
  maxUsd?: string | undefined;
  model?: string | undefined;
  noCache?: boolean | undefined;
  refreshLlm?: boolean | undefined;
};

function parseOptions(args: readonly string[]): ReviewLearningsOptions {
  return {
    batchSize: parseIntegerOption(args, "--batch-size"),
    cacheDir: parseStringOption(args, "--cache-dir"),
    ifNew: args.includes("--if-new"),
    limit: parseIntegerOption(args, "--limit"),
    maxLearnings: parseIntegerOption(args, "--max-learnings"),
    maxPer: parseStringOption(args, "--max-per"),
    maxTotalLearnings: parseIntegerOption(args, "--max-total-learnings"),
    maxUsd: parseStringOption(args, "--max-usd"),
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

// Best-effort read of a session's summary topic for the low-signal-session gate.
// Returns null when the summary is missing or unreadable, so a missing summary
// never causes a session to be skipped (fail open: review rather than drop).
async function readSessionTopic(sessionId: string): Promise<string | null> {
  try {
    const contents = await readFile(getSessionSummaryJsonPath(sessionId), "utf8");
    return summarySchema.parse(JSON.parse(contents)).topic;
  } catch {
    return null;
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
