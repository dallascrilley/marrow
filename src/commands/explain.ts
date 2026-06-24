import type { DatabaseSync } from "node:sqlite";

import type { CommandContext } from "../cli.js";
import { getExplainBundle } from "../read/operations.js";

export async function executeExplain(
  context: CommandContext,
  database: DatabaseSync,
): Promise<number> {
  const sessionId = context.args[0];

  if (!sessionId) {
    throw new Error("explain requires a session id argument");
  }

  context.output.info(JSON.stringify(await getExplainBundle(database, sessionId), null, 2));
  return 0;
}
