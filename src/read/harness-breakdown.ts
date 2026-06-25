import { readFile } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";

import {
  buildCostReport,
  type CostPerSessionUsd,
  type CostReportMeta,
} from "../commands/quality-cost-report.js";
import { listSourceSessions } from "../db/ledger.js";
import { getLlmTelemetryPath, type LlmTelemetryRecord } from "../pipeline/llm-telemetry.js";
import { isLowSignalTopic, isWrapperLeakTopic } from "../pipeline/summarize.js";
import { readSessionSummary } from "./session-detail.js";

export type HarnessBreakdownRow = {
  source_tool: string;
  sessions: number;
  deterministic_topics: number;
  llm_rescued_topics: number;
  low_signal_topics: number;
  wrapper_leak_topics: number;
  project_learnings: number;
  user_learnings: number;
  telemetry_calls: number;
  real_telemetry_calls: number;
  cache_hits: number;
  unknown_cost_calls: number;
  total_cost_usd: number;
  cost_per_session_usd: CostPerSessionUsd;
};

export type HarnessBreakdownSnapshot = {
  by_source_tool: HarnessBreakdownRow[];
  totals: HarnessBreakdownRow;
};

type HarnessAccumulator = {
  source_tool: string;
  sessions: number;
  deterministic_topics: number;
  llm_rescued_topics: number;
  low_signal_topics: number;
  wrapper_leak_topics: number;
  project_learnings: number;
  user_learnings: number;
  telemetry: LlmTelemetryRecord[];
};

export async function listHarnessBreakdown(
  database: DatabaseSync,
): Promise<HarnessBreakdownSnapshot> {
  const sessions = listSourceSessions(database);
  const summaries = await Promise.all(
    sessions.map(async (session) => ({
      session,
      summary: (await readSessionSummary(session.session_id)).value,
    })),
  );
  const toolBySessionId = new Map(
    sessions.map((session) => [session.session_id, session.source_tool]),
  );
  const telemetry = await readTelemetryRecords();
  const telemetryByTool = new Map<string, LlmTelemetryRecord[]>();

  for (const record of telemetry) {
    const sourceTool = toolBySessionId.get(record["asd.session_id"]);
    if (!sourceTool) {
      continue;
    }
    const bucket = telemetryByTool.get(sourceTool);
    if (bucket) {
      bucket.push(record);
    } else {
      telemetryByTool.set(sourceTool, [record]);
    }
  }

  const accumulators = new Map<string, HarnessAccumulator>();
  for (const entry of summaries) {
    const accumulator = getHarnessAccumulator(accumulators, entry.session.source_tool);
    accumulator.sessions += 1;

    if (!entry.summary) {
      continue;
    }

    if (entry.summary.topic_source === "llm") {
      accumulator.llm_rescued_topics += 1;
    } else {
      accumulator.deterministic_topics += 1;
    }

    if (isLowSignalTopic(entry.summary.topic)) {
      accumulator.low_signal_topics += 1;
    }
    if (isWrapperLeakTopic(entry.summary.topic)) {
      accumulator.wrapper_leak_topics += 1;
    }

    accumulator.project_learnings += entry.summary.project_learnings.length;
    accumulator.user_learnings += entry.summary.user_learnings.length;
  }

  for (const [sourceTool, records] of telemetryByTool) {
    getHarnessAccumulator(accumulators, sourceTool).telemetry.push(...records);
  }

  const bySourceTool = [...accumulators.values()]
    .map((accumulator) => materializeHarnessRow(accumulator))
    .sort((left, right) => {
      if (right.sessions !== left.sessions) {
        return right.sessions - left.sessions;
      }
      return left.source_tool.localeCompare(right.source_tool);
    });

  return {
    by_source_tool: bySourceTool,
    totals: materializeHarnessRow({
      source_tool: "all-harnesses",
      sessions: bySourceTool.reduce((sum, row) => sum + row.sessions, 0),
      deterministic_topics: bySourceTool.reduce((sum, row) => sum + row.deterministic_topics, 0),
      llm_rescued_topics: bySourceTool.reduce((sum, row) => sum + row.llm_rescued_topics, 0),
      low_signal_topics: bySourceTool.reduce((sum, row) => sum + row.low_signal_topics, 0),
      wrapper_leak_topics: bySourceTool.reduce((sum, row) => sum + row.wrapper_leak_topics, 0),
      project_learnings: bySourceTool.reduce((sum, row) => sum + row.project_learnings, 0),
      user_learnings: bySourceTool.reduce((sum, row) => sum + row.user_learnings, 0),
      telemetry: telemetry,
    }),
  };
}

function getHarnessAccumulator(
  accumulators: Map<string, HarnessAccumulator>,
  sourceTool: string,
): HarnessAccumulator {
  const existing = accumulators.get(sourceTool);
  if (existing) {
    return existing;
  }

  const created: HarnessAccumulator = {
    source_tool: sourceTool,
    sessions: 0,
    deterministic_topics: 0,
    llm_rescued_topics: 0,
    low_signal_topics: 0,
    wrapper_leak_topics: 0,
    project_learnings: 0,
    user_learnings: 0,
    telemetry: [],
  };
  accumulators.set(sourceTool, created);
  return created;
}

function materializeHarnessRow(accumulator: HarnessAccumulator): HarnessBreakdownRow {
  const report = buildCostReport(accumulator.telemetry, costMeta(accumulator.source_tool));
  return {
    source_tool: accumulator.source_tool,
    sessions: accumulator.sessions,
    deterministic_topics: accumulator.deterministic_topics,
    llm_rescued_topics: accumulator.llm_rescued_topics,
    low_signal_topics: accumulator.low_signal_topics,
    wrapper_leak_topics: accumulator.wrapper_leak_topics,
    project_learnings: accumulator.project_learnings,
    user_learnings: accumulator.user_learnings,
    telemetry_calls: report.totals.calls,
    real_telemetry_calls: report.totals.real_calls,
    cache_hits: report.totals.cache_hits,
    unknown_cost_calls: report.totals.unknown_cost_calls,
    total_cost_usd: report.totals.total_cost_usd,
    cost_per_session_usd: report.cost_per_session_usd,
  };
}

function costMeta(sourceTool: string): CostReportMeta {
  return {
    path: `harness:${sourceTool}`,
  };
}

async function readTelemetryRecords(): Promise<LlmTelemetryRecord[]> {
  try {
    const contents = await readFile(getLlmTelemetryPath(), "utf8");
    return contents
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as LlmTelemetryRecord);
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }
    throw error;
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
