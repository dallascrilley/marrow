import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

import { getRuntimePath } from "../config/paths.js";

export const llmLearningReviewApplyLedgerSchemaVersion = "llm-learning-review-apply-ledger-v1";

const outputSchema = z.object({
  content_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  learning_count: z.number().int().nonnegative(),
  path: z.string().min(1),
  project_id: z.string().min(1),
  session_id: z.string().min(1),
});

const baseEntrySchema = z.object({
  schema_version: z.literal(llmLearningReviewApplyLedgerSchemaVersion),
  apply_id: z.string().regex(/^[A-Za-z0-9._-]+$/),
  batch_id: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  batch_path: z.string().min(1),
  recorded_at: z.iso.datetime(),
  reviewed_at: z.iso.datetime(),
});

const applyingEntrySchema = baseEntrySchema.extend({
  status: z.literal("applying"),
  affected_sessions: z.array(z.string().min(1)),
});

const appliedEntrySchema = baseEntrySchema.extend({
  status: z.literal("applied"),
  affected_sessions: z.array(z.string().min(1)),
  outputs: z.array(outputSchema),
});

const failedEntrySchema = baseEntrySchema.extend({
  status: z.literal("failed"),
  error: z.string().min(1),
});

export const llmLearningReviewApplyLedgerEntrySchema = z.discriminatedUnion("status", [
  applyingEntrySchema,
  appliedEntrySchema,
  failedEntrySchema,
]);

export type LlmLearningReviewApplyOutput = z.infer<typeof outputSchema>;
export type LlmLearningReviewApplyLedgerEntry = z.infer<
  typeof llmLearningReviewApplyLedgerEntrySchema
>;

export function getLlmLearningReviewApplyLedgerPath(): string {
  return join(getRuntimePath("reports"), "llm-learning-review-apply-ledger.jsonl");
}

export async function readLlmLearningReviewApplyLedger(): Promise<
  LlmLearningReviewApplyLedgerEntry[]
> {
  try {
    const contents = await readFile(getLlmLearningReviewApplyLedgerPath(), "utf8");
    return contents
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => llmLearningReviewApplyLedgerEntrySchema.parse(JSON.parse(line)));
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw error;
  }
}

export async function appendLlmLearningReviewApplyLedgerEntry(
  entryInput: LlmLearningReviewApplyLedgerEntry,
): Promise<void> {
  const entry = llmLearningReviewApplyLedgerEntrySchema.parse(entryInput);
  const ledgerPath = getLlmLearningReviewApplyLedgerPath();
  await mkdir(dirname(ledgerPath), { recursive: true });
  await appendFile(ledgerPath, `${JSON.stringify(entry)}\n`, "utf8");
}

export function getLatestLlmLearningReviewApplyEntry(
  entries: readonly LlmLearningReviewApplyLedgerEntry[],
  batchId: string,
): LlmLearningReviewApplyLedgerEntry | undefined {
  return entries.findLast((entry) => entry.batch_id === batchId);
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
