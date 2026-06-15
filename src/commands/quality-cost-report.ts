import { readFile } from "node:fs/promises";

import type { CommandContext } from "../cli.js";
import {
  getLlmTelemetryPath,
  type LlmTelemetryOperation,
  type LlmTelemetryRecord,
} from "../pipeline/llm-telemetry.js";

type CostReportOptions = {
  json: boolean;
  since?: string | undefined;
  backlogLearnings?: number | undefined;
};

export async function executeQualityCostReport(context: CommandContext): Promise<number> {
  const options = parseOptions(context.args);
  const path = getLlmTelemetryPath();
  const records = filterSince(await readTelemetry(path), options.since);

  const report = buildCostReport(records, { backlogLearnings: options.backlogLearnings, path });

  if (options.json) {
    context.output.info(JSON.stringify(report, null, 2));
  } else {
    context.output.info(renderHuman(report));
  }
  return 0;
}

export type CostReport = ReturnType<typeof buildCostReport>;

export function buildCostReport(
  records: readonly LlmTelemetryRecord[],
  meta: { backlogLearnings?: number | undefined; path: string },
) {
  const realCalls = records.filter((r) => r["asd.cache_hit"] === false);
  const cacheHits = records.length - realCalls.length;
  const knownCost = records.filter((r) => r["gen_ai.usage.cost_is_known"] === true);
  const unknownCostCalls = realCalls.filter(
    (r) => r["gen_ai.usage.cost_is_known"] === false,
  ).length;

  const totalCost = sum(knownCost.map((r) => r["gen_ai.usage.cost"] ?? 0));

  const costByOperation: Record<string, number> = {};
  for (const r of knownCost) {
    const op = r["gen_ai.operation.name"];
    costByOperation[op] = round((costByOperation[op] ?? 0) + (r["gen_ai.usage.cost"] ?? 0));
  }

  // Cost per session: sum known cost grouped by session, then describe the spread.
  const perSession = new Map<string, number>();
  for (const r of knownCost) {
    const id = r["asd.session_id"];
    perSession.set(id, (perSession.get(id) ?? 0) + (r["gen_ai.usage.cost"] ?? 0));
  }
  const sessionCosts = [...perSession.values()];

  const reviewLearnings = records.filter(
    (r) =>
      r["gen_ai.operation.name"] === ("learning_review" satisfies LlmTelemetryOperation) &&
      r["asd.learning_id"] !== null,
  );
  const reviewLearningsKnown = reviewLearnings.filter(
    (r) => r["gen_ai.usage.cost_is_known"] === true,
  );
  const reviewLearningsCost = sum(reviewLearningsKnown.map((r) => r["gen_ai.usage.cost"] ?? 0));
  const costPerLearning =
    reviewLearningsKnown.length === 0 ? 0 : reviewLearningsCost / reviewLearningsKnown.length;

  const projection =
    meta.backlogLearnings === undefined
      ? null
      : {
          backlog_learnings: meta.backlogLearnings,
          projected_cost_usd: round(costPerLearning * meta.backlogLearnings),
          basis: "cost_per_learning_usd × backlog_learnings (known-cost calls only)",
        };

  return {
    source: meta.path,
    totals: {
      calls: records.length,
      real_calls: realCalls.length,
      cache_hits: cacheHits,
      cache_hit_rate: records.length === 0 ? 0 : round(cacheHits / records.length),
      unknown_cost_calls: unknownCostCalls,
      total_cost_usd: round(totalCost),
    },
    cost_by_operation_usd: costByOperation,
    cost_per_session_usd: describe(sessionCosts),
    cost_per_learning_usd: round(costPerLearning),
    tokens_per_call: {
      input_mean: meanField(knownCost, "gen_ai.usage.input_tokens"),
      output_mean: meanField(knownCost, "gen_ai.usage.output_tokens"),
      total_mean: meanField(knownCost, "gen_ai.usage.total_tokens"),
    },
    projection,
  };
}

function describe(values: readonly number[]) {
  if (values.length === 0) {
    return { sessions: 0, mean: 0, p50: 0, p90: 0, max: 0 };
  }
  return {
    sessions: values.length,
    mean: round(sum(values) / values.length),
    p50: round(percentile(values, 50)),
    p90: round(percentile(values, 90)),
    max: round(Math.max(...values)),
  };
}

function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0] as number;
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  const weight = rank - low;
  return (sorted[low] as number) * (1 - weight) + (sorted[high] as number) * weight;
}

function meanField(
  records: readonly LlmTelemetryRecord[],
  field: "gen_ai.usage.input_tokens" | "gen_ai.usage.output_tokens" | "gen_ai.usage.total_tokens",
): number | null {
  const present = records.map((r) => r[field]).filter((v): v is number => typeof v === "number");
  return present.length === 0 ? null : round(sum(present) / present.length);
}

function sum(values: readonly number[]): number {
  return values.reduce((acc, value) => acc + value, 0);
}

function round(value: number): number {
  // 6 significant decimals is enough for per-call USD costs.
  return Math.round(value * 1e6) / 1e6;
}

async function readTelemetry(path: string): Promise<LlmTelemetryRecord[]> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }
    throw error;
  }
  return contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as LlmTelemetryRecord);
}

function filterSince(
  records: readonly LlmTelemetryRecord[],
  since: string | undefined,
): LlmTelemetryRecord[] {
  if (since === undefined) {
    return [...records];
  }
  const cutoff = Date.parse(since);
  if (Number.isNaN(cutoff)) {
    throw new Error(`quality cost-report --since requires an ISO timestamp, got "${since}"`);
  }
  return records.filter((r) => Date.parse(r["asd.created_at"]) >= cutoff);
}

function renderHuman(report: CostReport): string {
  const t = report.totals;
  const s = report.cost_per_session_usd;
  const lines = [
    `LLM cost report  (${report.source})`,
    `  calls: ${t.calls}  (real ${t.real_calls}, cache hits ${t.cache_hits}, hit-rate ${(t.cache_hit_rate * 100).toFixed(1)}%)`,
    `  total cost: $${t.total_cost_usd.toFixed(6)}   unknown-cost calls: ${t.unknown_cost_calls}`,
    `  cost/session: mean $${s.mean.toFixed(6)}  p50 $${s.p50.toFixed(6)}  p90 $${s.p90.toFixed(6)}  max $${s.max.toFixed(6)}  (${s.sessions} sessions)`,
    `  cost/learning: $${report.cost_per_learning_usd.toFixed(6)}`,
  ];
  if (report.projection) {
    lines.push(
      `  projected drain of ${report.projection.backlog_learnings} learnings: $${report.projection.projected_cost_usd.toFixed(4)}`,
    );
  }
  return lines.join("\n");
}

function parseOptions(args: readonly string[]): CostReportOptions {
  const since = parseStringOption(args, "--since");
  const backlogRaw = parseStringOption(args, "--backlog-learnings");
  let backlogLearnings: number | undefined;
  if (backlogRaw !== undefined) {
    const parsed = Number(backlogRaw);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new Error("quality cost-report --backlog-learnings requires a non-negative integer");
    }
    backlogLearnings = parsed;
  }
  return {
    json: args.includes("--json"),
    since,
    backlogLearnings,
  };
}

function parseStringOption(args: readonly string[], flag: string): string | undefined {
  const flagIndex = args.indexOf(flag);
  if (flagIndex === -1) {
    return undefined;
  }
  const value = args[flagIndex + 1];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
