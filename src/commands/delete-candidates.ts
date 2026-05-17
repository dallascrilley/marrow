import type { DatabaseSync } from "node:sqlite";

import type { CommandContext } from "../cli.js";
import { listDeletionCandidates } from "../db/ledger.js";

export async function executeDeleteCandidates(context: CommandContext, database: DatabaseSync): Promise<number> {
  const candidates = listDeletionCandidates(database);
  context.output.info(JSON.stringify({ candidates }, null, 2));
  return 0;
}
