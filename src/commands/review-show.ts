import type { DatabaseSync } from "node:sqlite";

import type { CommandContext } from "../cli.js";
import { getReviewQueueEntryBySessionId } from "../db/ledger.js";

export async function executeReviewShow(context: CommandContext, database: DatabaseSync): Promise<number> {
  const sessionId = context.args[0];

  if (!sessionId) {
    throw new Error("review show requires a session id argument");
  }

  const entry = getReviewQueueEntryBySessionId(database, sessionId);

  if (entry === null) {
    throw new Error(`No review queue entry found for session: ${sessionId}`);
  }

  context.output.info(JSON.stringify(entry, null, 2));
  return 0;
}
