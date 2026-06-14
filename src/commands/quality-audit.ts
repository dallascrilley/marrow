import type { DatabaseSync } from "node:sqlite";

import type { CommandContext } from "../cli.js";
import { auditQuality } from "../pipeline/quality-audit.js";

export async function executeQualityAudit(
  context: CommandContext,
  database: DatabaseSync,
): Promise<number> {
  const limit = parseLimit(context.args);
  const report = await auditQuality(database, limit === undefined ? {} : { limit });

  context.output.info(JSON.stringify(report, null, 2));
  return 0;
}

function parseLimit(args: readonly string[]): number | undefined {
  const limitFlagIndex = args.findIndex((arg) => arg === "--limit");

  if (limitFlagIndex === -1) {
    return undefined;
  }

  const rawLimit = args[limitFlagIndex + 1];
  const limit = Number(rawLimit);

  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error("quality audit --limit requires a non-negative integer");
  }

  return limit;
}
