import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { getRuntimePath } from "../config/paths.js";
import { listSourceSessions } from "../db/ledger.js";
import {
  getLatestLlmLearningReviewApplyEntry,
  readLlmLearningReviewApplyLedger,
} from "../pipeline/llm-learning-review-apply-ledger.js";
import { listLearningReviewBatches } from "../pipeline/llm-learning-review-batch.js";

export const defaultReportRetentionHistory = 10;

export type ReportRetentionCandidate = {
  bytes: number;
  category: "archive" | "review";
  device: number;
  inode: number;
  modified_at: string;
  path: string;
  reason: string;
};

export type ReportRetentionOptions = {
  history?: number | undefined;
};

/**
 * Select only redundant generated reports. Audit receipts, telemetry, ledgers,
 * latest pointers, and any report without an explicit terminal state remain
 * outside this destructive policy.
 */
export async function listReportRetentionCandidates(
  database: DatabaseSync,
  options: ReportRetentionOptions = {},
): Promise<ReportRetentionCandidate[]> {
  const history = options.history ?? defaultReportRetentionHistory;
  const retainedHistory = Math.max(1, history);
  const reportsRoot = getRuntimePath("reports");
  const sessionsById = new Map(
    listSourceSessions(database).map((session) => [session.session_id, session]),
  );
  const [archiveReports, reviewReports] = await Promise.all([
    listArchiveReportCandidates(reportsRoot, sessionsById, retainedHistory),
    listReviewBatchCandidates(reportsRoot, retainedHistory),
  ]);

  return [...archiveReports, ...reviewReports].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
}

async function listArchiveReportCandidates(
  reportsRoot: string,
  sessionsById: ReadonlyMap<string, { current_lifecycle_state: string }>,
  history: number,
): Promise<ReportRetentionCandidate[]> {
  const files = await listFiles(reportsRoot);
  const terminal = new Map<string, { paths: string[]; modifiedAt: Date }>();

  for (const file of files) {
    const match = /^archive-(.+)\.(json|md)$/.exec(file);
    if (!match) continue;
    const sessionId = match[1];
    if (!sessionId) continue;
    const session = sessionsById.get(sessionId);
    if (!session || !isTerminalArchiveLifecycle(session.current_lifecycle_state)) continue;
    const path = join(reportsRoot, file);
    const metadata = await stat(path);
    const group = terminal.get(sessionId);
    if (group) {
      group.paths.push(path);
      if (metadata.mtime > group.modifiedAt) group.modifiedAt = metadata.mtime;
    } else {
      terminal.set(sessionId, { paths: [path], modifiedAt: metadata.mtime });
    }
  }

  return Promise.all(
    [...terminal.values()]
      .sort((left, right) => right.modifiedAt.getTime() - left.modifiedAt.getTime())
      .slice(history)
      .flatMap((group) =>
        group.paths.map((path) => candidateFromPath(path, "archive", "terminal_history")),
      ),
  );
}

async function listReviewBatchCandidates(
  reportsRoot: string,
  history: number,
): Promise<ReportRetentionCandidate[]> {
  const batches = await listLearningReviewBatches(reportsRoot);
  const entries = await readLlmLearningReviewApplyLedger();
  const successful = batches
    .filter(
      (entry) =>
        getLatestLlmLearningReviewApplyEntry(entries, entry.batch.batch_id)?.status === "applied",
    )
    .sort((left, right) => right.batch.created_at.localeCompare(left.batch.created_at));

  return Promise.all(
    successful
      .slice(history)
      .map((entry) => candidateFromPath(entry.batchPath, "review", "applied_history")),
  );
}

async function candidateFromPath(
  path: string,
  category: ReportRetentionCandidate["category"],
  reason: string,
): Promise<ReportRetentionCandidate> {
  const metadata = await stat(path);
  return {
    bytes: metadata.size,
    category,
    device: metadata.dev,
    inode: metadata.ino,
    modified_at: metadata.mtime.toISOString(),
    path,
    reason,
  };
}

async function listFiles(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch (error) {
    if (isMissingPathError(error)) return [];
    throw error;
  }
}

function isTerminalArchiveLifecycle(lifecycleState: string): boolean {
  return (
    lifecycleState === "archived" ||
    lifecycleState === "deletion_candidate" ||
    lifecycleState === "deleted"
  );
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
