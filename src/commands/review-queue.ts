import type { DatabaseSync } from "node:sqlite";

import type { CommandContext } from "../cli.js";
import { ensureRuntimePath } from "../config/paths.js";
import { listReviewQueueEntries } from "../db/ledger.js";

export async function executeReviewQueue(context: CommandContext, database: DatabaseSync): Promise<number> {
  await ensureRuntimePath("reviews");
  const entries = listReviewQueueEntries(database);
  context.output.info(JSON.stringify({ entries }, null, 2));
  return 0;
}
