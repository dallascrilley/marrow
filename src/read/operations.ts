import { readFile } from "node:fs/promises";

import type { DatabaseSync } from "node:sqlite";

import {
  getDeletionCandidateBySessionId,
  getOperationalStats,
  getReviewQueueEntryBySessionId,
  getSourceSessionBySessionId,
  listPhaseCheckpoints,
  listReviewQueueEntries,
  listRunHistory,
} from "../db/ledger.js";
import type {
  DeletionCandidateRow,
  PhaseCheckpointRow,
  ReviewQueueEntryRow,
  RunHistoryRow,
  SourceSessionRow,
} from "../db/queries.js";
import { getSessionSummaryJsonPath } from "../writers/summary-writer.js";
import type { HarnessBreakdownSnapshot } from "./harness-breakdown.js";
import { listHarnessBreakdown } from "./harness-breakdown.js";

export type PipelineStatus = {
  blockedReasons: Record<string, number>;
  deletionCandidates: Record<string, number>;
  reviewQueue: Record<string, number>;
  sessionsByLifecycle: Record<string, number>;
  totalSessions: number;
};

export function listPipelineStatus(database: DatabaseSync): PipelineStatus {
  return getOperationalStats(database);
}

export function listReviewItems(database: DatabaseSync): ReviewQueueEntryRow[] {
  return listReviewQueueEntries(database);
}

export async function listHarnessComparison(
  database: DatabaseSync,
): Promise<HarnessBreakdownSnapshot> {
  return listHarnessBreakdown(database);
}

export async function getExplainBundle(
  database: DatabaseSync,
  sessionId: string,
): Promise<{
  deletion_candidate: DeletionCandidateRow | null;
  phase_checkpoints: PhaseCheckpointRow[];
  review_queue: ReviewQueueEntryRow | null;
  run_history: RunHistoryRow[];
  session: SourceSessionRow;
  summary_preview: Record<string, unknown> | null;
}> {
  const session = getSourceSessionBySessionId(database, sessionId);

  if (session === null) {
    throw new Error(`Unknown session: ${sessionId}`);
  }

  return {
    deletion_candidate: getDeletionCandidateBySessionId(database, sessionId),
    phase_checkpoints: listPhaseCheckpoints(database, session.id),
    review_queue: getReviewQueueEntryBySessionId(database, sessionId),
    run_history: listRunHistory(database, session.id),
    session,
    summary_preview: await readSummaryPreview(sessionId),
  };
}

async function readSummaryPreview(sessionId: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(
      await readFile(getSessionSummaryJsonPath(sessionId), "utf8"),
    ) as Record<string, unknown>;

    return {
      deletion_readiness: parsed.deletion_readiness ?? null,
      next_step: parsed.next_step ?? null,
      topic: parsed.topic ?? null,
      what_failed_count: Array.isArray(parsed.what_failed) ? parsed.what_failed.length : null,
      what_worked_count: Array.isArray(parsed.what_worked) ? parsed.what_worked.length : null,
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }

    throw error;
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
