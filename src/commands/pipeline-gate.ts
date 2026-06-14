import type { DatabaseSync } from "node:sqlite";

import type { CommandContext } from "../cli.js";
import { type SupportedSource, supportedSources } from "../pipeline/discover.js";
import { getDefaultMaxPerWindow } from "../pipeline/llm-budget.js";
import { assessPipelineGate } from "../pipeline/pipeline-gate.js";

export async function executePipelineGate(
  context: CommandContext,
  database: DatabaseSync,
): Promise<number> {
  const options = parsePipelineGateOptions(context.args);
  const report = await assessPipelineGate(database, {
    maxPer: options.maxPer,
    ...(options.sources === undefined ? {} : { sources: options.sources }),
  });

  context.output.info(JSON.stringify(report, null, 2));
  return 0;
}

function parsePipelineGateOptions(args: readonly string[]): {
  maxPer: string;
  sources?: SupportedSource[];
} {
  let maxPer: string | undefined;
  const sources: SupportedSource[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      continue;
    }

    if (arg === "--max-per") {
      const value = args[index + 1];
      if (value === undefined || value.trim().length === 0) {
        throw new Error("pipeline gate --max-per requires a value like 5/24h");
      }
      maxPer = value;
      index += 1;
      continue;
    }

    if (arg === "--source") {
      const value = args[index + 1];
      if (value === undefined || value.trim().length === 0) {
        throw new Error("pipeline gate --source requires an adapter name");
      }
      if (!supportedSources.includes(value as SupportedSource)) {
        throw new Error(
          `Unsupported source "${value}". Expected one of: ${supportedSources.join(", ")}`,
        );
      }
      sources.push(value as SupportedSource);
      index += 1;
      continue;
    }

    if (arg.startsWith("--")) {
      throw new Error(`Unknown pipeline gate flag: ${arg}`);
    }

    throw new Error(`Unexpected argument for pipeline gate: ${arg}`);
  }

  return {
    maxPer: maxPer ?? getDefaultMaxPerWindow(),
    ...(sources.length > 0 ? { sources } : {}),
  };
}
