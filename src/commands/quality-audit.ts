import type { DatabaseSync } from "node:sqlite";

import type { CommandContext } from "../cli.js";
import { auditQuality } from "../pipeline/quality-audit.js";
import { auditTopicDistribution } from "../pipeline/topic-distribution.js";

export async function executeQualityAudit(
  context: CommandContext,
  database: DatabaseSync,
): Promise<number> {
  const options = parseQualityAuditOptions(context.args);

  if (options.topicDistribution) {
    const report = await auditTopicDistribution(
      database,
      options.limit === undefined ? {} : { limit: options.limit },
    );
    context.output.info(JSON.stringify(report, null, 2));
    return 0;
  }

  const report = await auditQuality(
    database,
    options.limit === undefined ? {} : { limit: options.limit },
  );

  context.output.info(JSON.stringify(report, null, 2));
  return 0;
}

function parseQualityAuditOptions(args: readonly string[]): {
  limit?: number;
  topicDistribution: boolean;
} {
  let limit: number | undefined;
  let topicDistribution = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      continue;
    }

    if (arg === "--topic-distribution") {
      topicDistribution = true;
      continue;
    }

    if (arg === "--limit") {
      const rawLimit = args[index + 1];
      const parsed = Number(rawLimit);
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error("quality audit --limit requires a non-negative integer");
      }
      limit = parsed;
      index += 1;
      continue;
    }

    if (arg.startsWith("--")) {
      throw new Error(`Unknown quality audit flag: ${arg}`);
    }

    throw new Error(`Unexpected argument for quality audit: ${arg}`);
  }

  return limit === undefined ? { topicDistribution } : { limit, topicDistribution };
}
