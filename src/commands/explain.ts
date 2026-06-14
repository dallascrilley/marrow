import { readFile } from "node:fs/promises";

import type { DatabaseSync } from "node:sqlite";

import type { CommandContext } from "../cli.js";
import {
  getDeletionCandidateBySessionId,
  getReviewQueueEntryBySessionId,
  getSourceSessionBySessionId,
  listPhaseCheckpoints,
  listRunHistory,
} from "../db/ledger.js";
import { getSessionSummaryJsonPath } from "../writers/summary-writer.js";

export async function executeExplain(
  context: CommandContext,
  database: DatabaseSync,
): Promise<number> {
  const sessionId = context.args[0];

  if (!sessionId) {
    throw new Error("explain requires a session id argument");
  }

  const session = getSourceSessionBySessionId(database, sessionId);

  if (session === null) {
    throw new Error(`Unknown session: ${sessionId}`);
  }

  const deletionCandidate = getDeletionCandidateBySessionId(database, sessionId);
  const summaryPreview = await readSummaryPreview(sessionId);

  context.output.info(
    JSON.stringify(
      {
        deletion_candidate: deletionCandidate,
        phase_checkpoints: listPhaseCheckpoints(database, session.id),
        review_queue: getReviewQueueEntryBySessionId(database, sessionId),
        run_history: listRunHistory(database, session.id),
        session,
        summary_preview: summaryPreview,
      },
      null,
      2,
    ),
  );
  return 0;
}

async function readSummaryPreview(sessionId: string): Promise<Record<string, unknown> | null> {
  try {
    const contents = await readFile(getSessionSummaryJsonPath(sessionId), "utf8");
    const parsed = JSON.parse(contents) as Record<string, unknown>;

    return {
      deletion_readiness: parsed.deletion_readiness ?? null,
      next_step: parsed.next_step ?? null,
      topic: parsed.topic ?? null,
      what_failed_count: Array.isArray(parsed.what_failed) ? parsed.what_failed.length : null,
      what_worked_count: Array.isArray(parsed.what_worked) ? parsed.what_worked.length : null,
    };
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null;
    }

    throw error;
  }
}
