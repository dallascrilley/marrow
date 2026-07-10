import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

import type { Learning } from "../models/canonical.js";
import { learningSchema } from "../models/canonical.js";
import {
  learningReviewCacheSchemaVersion,
  learningReviewPromptVersion,
  learningReviewValidatorVersion,
} from "./llm-learning-review.js";

export const learningReviewBatchSchemaVersion = "llm-learning-review-batch-v1";
export const learningReviewBatchStatus = "generated" as const;

const ledgerWatermarkSchema = z.object({
  entry_count: z.number().int().nonnegative(),
  last_learning_id: z.string().nullable(),
  last_reviewed_at: z.string().nullable(),
});

const sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

const batchReviewSchema = z.object({
  durability: z.string(),
  input_content_hash: sha256Schema,
  keep: z.boolean(),
  learning_id: z.string().min(1),
  reason: z.string(),
  scope_key: z.string(),
  session_id: z.string().min(1),
  statement: z.string(),
  suggested_statement: z.string(),
  trigger: z.string().optional(),
  verdict: z.enum(["keep", "reject", "rewrite"]),
});

export const learningReviewBatchSchema = z.object({
  schema_version: z.literal(learningReviewBatchSchemaVersion),
  batch_id: sha256Schema,
  run_id: z.string().regex(/^[A-Za-z0-9._-]+$/),
  created_at: z.iso.datetime(),
  status: z.literal(learningReviewBatchStatus),
  model: z.string().min(1),
  prompt_version: z.string().min(1),
  validator_version: z.string().min(1),
  cache_schema_version: z.string().min(1),
  source_ledger_watermark: ledgerWatermarkSchema,
  count: z.number().int().nonnegative(),
  verdict_counts: z.object({
    keep: z.number().int().nonnegative(),
    reject: z.number().int().nonnegative(),
    rewrite: z.number().int().nonnegative(),
  }),
  reviews: z.array(batchReviewSchema),
});

export type LearningReviewLedgerWatermark = z.infer<typeof ledgerWatermarkSchema>;
export type LearningReviewBatchReview = z.infer<typeof batchReviewSchema>;
export type LearningReviewBatch = z.infer<typeof learningReviewBatchSchema>;

export function buildLearningReviewInputContentHash(learningInput: Learning): string {
  const learning = learningSchema.parse(learningInput);
  return `sha256:${sha256Hex(
    stableStringify({
      evidence: learning.evidence,
      kind: learning.kind,
      learning_id: learning.learning_id,
      promotion_basis: learning.promotion_basis,
      scope: learning.scope,
      scope_key: learning.scope_key,
      source_refs: learning.source_refs,
      statement: learning.statement,
      title: learning.title,
      trigger: learning.trigger,
    }),
  )}`;
}

export function buildLearningReviewBatch(input: {
  createdAt: string;
  model: string;
  reviews: readonly LearningReviewBatchReview[];
  runId: string;
  sourceLedgerWatermark: LearningReviewLedgerWatermark;
  promptVersion?: string | undefined;
  validatorVersion?: string | undefined;
  cacheSchemaVersion?: string | undefined;
}): LearningReviewBatch {
  const promptVersion = input.promptVersion ?? learningReviewPromptVersion;
  const validatorVersion = input.validatorVersion ?? learningReviewValidatorVersion;
  const cacheSchemaVersion = input.cacheSchemaVersion ?? learningReviewCacheSchemaVersion;
  const reviews = input.reviews.map((review) => batchReviewSchema.parse(review));
  const verdictCounts = {
    keep: reviews.filter((review) => review.verdict === "keep").length,
    reject: reviews.filter((review) => review.verdict === "reject").length,
    rewrite: reviews.filter((review) => review.verdict === "rewrite").length,
  };
  const batchId = `sha256:${sha256Hex(
    stableStringify({
      schema_version: learningReviewBatchSchemaVersion,
      model: input.model,
      prompt_version: promptVersion,
      validator_version: validatorVersion,
      cache_schema_version: cacheSchemaVersion,
      ordered_inputs: reviews.map((review) => ({
        learning_id: review.learning_id,
        input_content_hash: review.input_content_hash,
      })),
    }),
  )}`;

  return learningReviewBatchSchema.parse({
    schema_version: learningReviewBatchSchemaVersion,
    batch_id: batchId,
    run_id: input.runId,
    created_at: input.createdAt,
    status: learningReviewBatchStatus,
    model: input.model,
    prompt_version: promptVersion,
    validator_version: validatorVersion,
    cache_schema_version: cacheSchemaVersion,
    source_ledger_watermark: input.sourceLedgerWatermark,
    count: reviews.length,
    verdict_counts: verdictCounts,
    reviews,
  });
}

export function serializeLearningReviewBatch(batchInput: LearningReviewBatch): string {
  const batch = learningReviewBatchSchema.parse(batchInput);
  return `${JSON.stringify(batch, null, 2)}\n`;
}

export function parseLearningReviewBatch(contents: string): LearningReviewBatch {
  return learningReviewBatchSchema.parse(JSON.parse(contents));
}

export async function writeLearningReviewBatch(input: {
  batch: LearningReviewBatch;
  reportsDir: string;
}): Promise<{
  batch: LearningReviewBatch;
  batchPath: string;
  latestPointerPath: string;
}> {
  const batch = learningReviewBatchSchema.parse(input.batch);
  const batchPath = join(input.reportsDir, "llm-learning-review-batches", `${batch.run_id}.json`);
  const latestPointerPath = join(input.reportsDir, "llm-learning-review-latest.json");
  await mkdir(dirname(batchPath), { recursive: true });
  await writeFile(batchPath, serializeLearningReviewBatch(batch), {
    encoding: "utf8",
    flag: "wx",
  });

  const pointer = {
    schema_version: learningReviewBatchSchemaVersion,
    batch_id: batch.batch_id,
    run_id: batch.run_id,
    batch_path: batchPath,
    created_at: batch.created_at,
  };
  const tempPointerPath = `${latestPointerPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPointerPath, `${JSON.stringify(pointer, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(tempPointerPath, latestPointerPath);
  } catch (error) {
    await rm(tempPointerPath, { force: true });
    throw error;
  }

  return { batch, batchPath, latestPointerPath };
}

export async function listLearningReviewBatches(
  reportsDir: string,
): Promise<Array<{ batch: LearningReviewBatch; batchPath: string }>> {
  const batchDir = join(reportsDir, "llm-learning-review-batches");
  let files: string[];
  try {
    files = (await readdir(batchDir)).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw error;
  }

  const batches = [];
  const reviewsByBatchId = new Map<string, string>();
  for (const file of files) {
    const batchPath = join(batchDir, file);
    const batch = parseLearningReviewBatch(await readFile(batchPath, "utf8"));
    const serializedReviews = stableStringify(batch.reviews);
    const existing = reviewsByBatchId.get(batch.batch_id);
    if (existing !== undefined && existing !== serializedReviews) {
      throw new Error(`Conflicting immutable batches share batch_id ${batch.batch_id}`);
    }
    if (existing !== undefined) {
      continue;
    }
    reviewsByBatchId.set(batch.batch_id, serializedReviews);
    batches.push({ batch, batchPath });
  }
  return batches;
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}
