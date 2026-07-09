import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getRuntimePath } from "../config/paths.js";
import type { LearningReviewVerdict } from "./llm-learning-review.js";

export type LlmLearningReviewLedgerEntry = {
  learning_id: string;
  verdict: LearningReviewVerdict;
  reviewed_at: string;
  session_id: string;
};

export function getLlmLearningReviewLedgerPath(): string {
  return join(getRuntimePath("reports"), "llm-learning-review-ledger.jsonl");
}

export async function readLlmLearningReviewLedgerIds(): Promise<Set<string>> {
  try {
    const contents = await readFile(getLlmLearningReviewLedgerPath(), "utf8");
    const ids = new Set<string>();
    for (const line of contents.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }

      const parsed = JSON.parse(trimmed) as { learning_id?: unknown };
      if (typeof parsed.learning_id === "string") {
        ids.add(parsed.learning_id);
      }
    }

    return ids;
  } catch (error) {
    if (isMissingFileError(error)) {
      return new Set<string>();
    }

    throw error;
  }
}

export async function appendLlmLearningReviewLedgerEntries(
  entries: readonly LlmLearningReviewLedgerEntry[],
): Promise<void> {
  if (entries.length === 0) {
    return;
  }

  const ledgerPath = getLlmLearningReviewLedgerPath();
  await mkdir(dirname(ledgerPath), { recursive: true });
  await appendFile(
    ledgerPath,
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf8",
  );
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
