import type { DatabaseSync } from "node:sqlite";

import type { CommandContext } from "../cli.js";
import { openRouterApiKeyEnvVar } from "../pipeline/llm-learning-review.js";
import { parseWorkflowJudgeLimit, runWorkflowJudge } from "../workflow/judge.js";

type WorkflowJudgeCommandOptions = {
  days: number;
  limit: number;
  source: string | null;
  maxPer?: string | undefined;
  maxUsd?: string | undefined;
  model?: string | undefined;
};

export async function executeWorkflowJudge(
  context: CommandContext,
  database: DatabaseSync,
): Promise<number> {
  const options = parseWorkflowJudgeArgs(context.args);
  const judgeOptions = {
    apiKey: process.env[openRouterApiKeyEnvVar],
    database,
    days: options.days,
    limit: options.limit,
    source: options.source,
    ...(options.maxPer ? { maxPer: options.maxPer } : {}),
    ...(options.maxUsd ? { maxUsd: options.maxUsd } : {}),
    ...(options.model ? { model: options.model } : {}),
  };
  const result = await runWorkflowJudge(judgeOptions);
  context.output.info(JSON.stringify(result, null, 2));
  return 0;
}

function parseWorkflowJudgeArgs(args: string[]): WorkflowJudgeCommandOptions {
  let days = 7;
  let limit = 5;
  let maxPer: string | undefined;
  let maxUsd: string | undefined;
  let model: string | undefined;
  let source: string | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;

    if (arg === "--days" || arg.startsWith("--days=")) {
      const value = arg === "--days" ? args[index + 1] : arg.slice("--days=".length);
      if (!value || value.startsWith("--")) throw new Error("--days requires a value");
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed < 1) {
        throw new Error("--days must be a positive integer");
      }
      days = parsed;
      if (arg === "--days") index += 1;
      continue;
    }

    if (arg === "--limit" || arg.startsWith("--limit=")) {
      const value = arg === "--limit" ? args[index + 1] : arg.slice("--limit=".length);
      if (!value || value.startsWith("--")) throw new Error("--limit requires a value");
      limit = parseWorkflowJudgeLimit(value);
      if (arg === "--limit") index += 1;
      continue;
    }

    if (arg === "--model" || arg.startsWith("--model=")) {
      const value = arg === "--model" ? args[index + 1] : arg.slice("--model=".length);
      if (!value || value.startsWith("--")) throw new Error("--model requires a value");
      model = value;
      if (arg === "--model") index += 1;
      continue;
    }

    if (arg === "--max-per" || arg.startsWith("--max-per=")) {
      const value = arg === "--max-per" ? args[index + 1] : arg.slice("--max-per=".length);
      if (!value || value.startsWith("--")) throw new Error("--max-per requires a value");
      maxPer = value;
      if (arg === "--max-per") index += 1;
      continue;
    }

    if (arg === "--max-usd" || arg.startsWith("--max-usd=")) {
      const value = arg === "--max-usd" ? args[index + 1] : arg.slice("--max-usd=".length);
      if (!value || value.startsWith("--")) throw new Error("--max-usd requires a value");
      maxUsd = value;
      if (arg === "--max-usd") index += 1;
      continue;
    }

    if (arg === "--source" || arg.startsWith("--source=")) {
      const value = arg === "--source" ? args[index + 1] : arg.slice("--source=".length);
      if (!value || value.startsWith("--")) throw new Error("--source requires a value");
      source = value;
      if (arg === "--source") index += 1;
      continue;
    }

    throw new Error(`Unknown flag: ${arg}`);
  }

  return { days, limit, maxPer, maxUsd, model, source };
}
