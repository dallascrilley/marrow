import type { DatabaseSync } from "node:sqlite";

import type { CommandContext } from "../cli.js";
import { listPipelineStatus } from "../read/operations.js";

export async function executeStats(
  context: CommandContext,
  database: DatabaseSync,
): Promise<number> {
  context.output.info(JSON.stringify(listPipelineStatus(database), null, 2));

  return 0;
}
