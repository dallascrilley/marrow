import type { DatabaseSync } from "node:sqlite";

import type { CommandContext } from "../cli.js";
import {
  assessSessionIntegrity,
  formatSessionIntegritySummary,
  sessionIntegrityExitCode,
} from "../pipeline/session-integrity.js";

export async function executeCheckSessions(
  context: CommandContext,
  database: DatabaseSync,
): Promise<number> {
  const options = parseCheckSessionsOptions(context.args);
  const report = await assessSessionIntegrity(database);

  if (options.json) {
    context.output.info(JSON.stringify(report, null, 2));
  } else {
    context.output.info(formatSessionIntegritySummary(report));
  }

  return sessionIntegrityExitCode(report);
}

function parseCheckSessionsOptions(args: readonly string[]): { json: boolean } {
  let json = false;

  for (const arg of args) {
    if (arg === "--json") {
      json = true;
      continue;
    }

    throw new Error(`Unknown check option: ${arg}`);
  }

  return { json };
}
