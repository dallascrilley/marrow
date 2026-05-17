import type { DatabaseSync } from "node:sqlite";

import type { CommandContext } from "../cli.js";
import {
  getDeletionCandidateBySessionId,
  getReviewQueueEntryBySessionId,
  getSourceSessionBySessionId,
  listPhaseCheckpoints,
  listRunHistory
} from "../db/ledger.js";

export async function executeExplain(context: CommandContext, database: DatabaseSync): Promise<number> {
  const sessionId = context.args[0];

  if (!sessionId) {
    throw new Error("explain requires a session id argument");
  }

  const session = getSourceSessionBySessionId(database, sessionId);

  if (session === null) {
    throw new Error(`Unknown session: ${sessionId}`);
  }

  context.output.info(
    JSON.stringify(
      {
        deletion_candidate: getDeletionCandidateBySessionId(database, sessionId),
        phase_checkpoints: listPhaseCheckpoints(database, session.id),
        review_queue: getReviewQueueEntryBySessionId(database, sessionId),
        run_history: listRunHistory(database, session.id),
        session
      },
      null,
      2
    )
  );
  return 0;
}
