import type { DatabaseSync } from "node:sqlite";

import type { CommandContext } from "../cli.js";
import { getOperationalStats } from "../db/ledger.js";

export async function executeStats(
  context: CommandContext,
  database: DatabaseSync,
): Promise<number> {
  context.output.info(JSON.stringify(getOperationalStats(database), null, 2));
  return 0;
}
