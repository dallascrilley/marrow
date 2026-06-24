import type { DatabaseSync } from "node:sqlite";

import type { CommandContext } from "../cli.js";
import { listReviewItems } from "../read/operations.js";

export async function executeReviewQueue(
  context: CommandContext,
  database: DatabaseSync,
): Promise<number> {
  const entries = listReviewItems(database);
  context.output.info(JSON.stringify({ entries }, null, 2));

  return 0;
}
