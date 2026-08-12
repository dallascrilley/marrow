import type { DatabaseSync } from "node:sqlite";

import type { CommandContext } from "../cli.js";
import type { LlmCallUsage } from "../pipeline/llm-learning-review.js";
import { appendLlmTelemetry, buildLlmTelemetryRecord } from "../pipeline/llm-telemetry.js";
import { resummarizeSessions } from "../pipeline/resummarize.js";
import { executeExportIndex } from "./export-index.js";

export async function executeQualityResummarize(
  context: CommandContext,
  database: DatabaseSync,
): Promise<number> {
  const options = parseResummarizeOptions(context.args);
  if (options.maxPer !== undefined && options.llmTopic !== true) {
    console.warn("[marrow] quality resummarize: --max-per has no effect without --llm-topic");
  }

  const result = await resummarizeSessions(database, {
    ...options,
    onUsage: async (usage: LlmCallUsage, sessionId?: string) => {
      await appendLlmTelemetry(
        buildLlmTelemetryRecord({
          usage,
          operation: "topic_generation",
          sessionId: sessionId ?? "unknown",
          createdAt: new Date().toISOString(),
        }),
      );
    },
  });

  if (options.exportIndex === true && !options.dryRun && result.processed_count > 0) {
    await executeExportIndex(context, database);
  }

  context.output.info(JSON.stringify(result, null, 2));
  return result.failed_count > 0 ? 1 : 0;
}

function parseResummarizeOptions(args: readonly string[]): {
  dryRun?: boolean;
  exportIndex?: boolean;
  limit?: number;
  llmTopic?: boolean;
  leakedTopicOnly?: boolean;
  lowSignalOnly?: boolean;
  maxPer?: string;
  overExtractedOnly?: boolean;
  projectKeys?: string[];
  sessionIds?: string[];
} {
  let dryRun = false;
  let exportIndex = false;
  let llmTopic = false;
  let leakedTopicOnly = false;
  let lowSignalOnly = false;
  let overExtractedOnly = false;
  let limit: number | undefined;
  let maxPer: string | undefined;
  const projectKeys: string[] = [];
  const sessionIds: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (arg === "--export-index") {
      exportIndex = true;
      continue;
    }

    if (arg === "--llm-topic") {
      llmTopic = true;
      continue;
    }

    if (arg === "--max-per") {
      maxPer = requireOptionValue("--max-per", args[index + 1]);
      index += 1;
      continue;
    }

    if (arg === "--leaked-topic-only") {
      leakedTopicOnly = true;
      continue;
    }

    if (arg === "--low-signal-only") {
      lowSignalOnly = true;
      continue;
    }

    if (arg === "--over-extracted-only") {
      overExtractedOnly = true;
      continue;
    }

    if (arg === "--session-id") {
      sessionIds.push(requireOptionValue("--session-id", args[index + 1]));
      index += 1;
      continue;
    }

    if (arg === "--project-key") {
      projectKeys.push(requireOptionValue("--project-key", args[index + 1]));
      index += 1;
      continue;
    }

    if (arg === "--limit") {
      const parsedLimit = Number.parseInt(requireOptionValue("--limit", args[index + 1]), 10);
      if (!Number.isFinite(parsedLimit) || parsedLimit <= 0) {
        throw new Error(`Invalid --limit value: ${args[index + 1] ?? "<missing>"}`);
      }
      limit = parsedLimit;
      index += 1;
      continue;
    }

    throw new Error(`Unknown resummarize option: ${arg}`);
  }

  if (leakedTopicOnly && lowSignalOnly) {
    throw new Error("Use only one of --leaked-topic-only or --low-signal-only");
  }

  return {
    ...(dryRun ? { dryRun: true } : {}),
    ...(exportIndex ? { exportIndex: true } : {}),
    ...(llmTopic ? { llmTopic: true } : {}),
    ...(leakedTopicOnly ? { leakedTopicOnly: true } : {}),
    ...(lowSignalOnly ? { lowSignalOnly: true } : {}),
    ...(overExtractedOnly ? { overExtractedOnly: true } : {}),
    ...(maxPer === undefined ? {} : { maxPer }),
    ...(limit === undefined ? {} : { limit }),
    ...(projectKeys.length > 0 ? { projectKeys } : {}),
    ...(sessionIds.length > 0 ? { sessionIds } : {}),
  };
}

function requireOptionValue(flag: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing value for ${flag}`);
  }

  return value;
}
