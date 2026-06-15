import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildCostReport, executeQualityCostReport } from "../dist/commands/quality-cost-report.js";
import { buildLlmTelemetryRecord } from "../dist/pipeline/llm-telemetry.js";

function usage(overrides = {}) {
  return {
    model: "openai/gpt-5-nano",
    input_tokens: 100,
    output_tokens: 20,
    total_tokens: 120,
    cost: 0.001,
    cost_is_known: true,
    missing_reason: null,
    duration_ms: 300,
    cache_hit: false,
    ...overrides,
  };
}

function record(input) {
  return buildLlmTelemetryRecord({ createdAt: "2026-06-14T00:00:00.000Z", ...input });
}

const FIXTURE = [
  record({
    usage: usage({ cost: 0.001 }),
    operation: "learning_review",
    sessionId: "A",
    learningId: "L1",
  }),
  record({
    usage: usage({ cost: 0.003 }),
    operation: "learning_review",
    sessionId: "A",
    learningId: "L2",
  }),
  record({
    usage: usage({ cost: 0, cache_hit: true }),
    operation: "learning_review",
    sessionId: "B",
    learningId: "L3",
  }),
  record({
    usage: usage({ cost: null, cost_is_known: false, missing_reason: "openrouter_usage_absent" }),
    operation: "learning_review",
    sessionId: "B",
    learningId: "L4",
  }),
  record({
    usage: usage({ cost: 0.002 }),
    operation: "topic_generation",
    sessionId: "B",
    learningId: null,
  }),
];

test("buildCostReport aggregates cost per session, cache-hit rate, and unknown cost", () => {
  const report = buildCostReport(FIXTURE, { backlogLearnings: 1000, path: "fixture.jsonl" });

  assert.equal(report.totals.calls, 5);
  assert.equal(report.totals.real_calls, 4);
  assert.equal(report.totals.cache_hits, 1);
  assert.equal(report.totals.cache_hit_rate, 0.2);
  assert.equal(report.totals.unknown_cost_calls, 1);
  assert.equal(report.totals.total_cost_usd, 0.006);

  assert.equal(report.cost_by_operation_usd.learning_review, 0.004);
  assert.equal(report.cost_by_operation_usd.topic_generation, 0.002);

  // Session A = 0.004, Session B = 0.002 (cache hit adds 0).
  assert.equal(report.cost_per_session_usd.sessions, 2);
  assert.equal(report.cost_per_session_usd.mean, 0.003);
  assert.equal(report.cost_per_session_usd.p50, 0.003);
  assert.equal(report.cost_per_session_usd.max, 0.004);

  // 3 known review learnings (L1, L2, L3) totalling 0.004 → 0.001333.
  assert.equal(report.cost_per_learning_usd, 0.001333);
  assert.equal(report.projection.backlog_learnings, 1000);
  assert.equal(report.projection.projected_cost_usd, 1.333333);
});

test("buildCostReport handles an empty corpus without dividing by zero", () => {
  const report = buildCostReport([], { path: "empty.jsonl" });
  assert.equal(report.totals.calls, 0);
  assert.equal(report.totals.cache_hit_rate, 0);
  assert.equal(report.cost_per_session_usd.mean, 0);
  assert.equal(report.cost_per_learning_usd, 0);
  assert.equal(report.projection, null);
});

test("executeQualityCostReport reads telemetry and emits JSON", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "asd-cost-report-"));
  const runtimeRoot = join(sandbox, "runtime-root");
  const previous = process.env.AGENT_SESSION_DISTILLERY_ROOT;
  process.env.AGENT_SESSION_DISTILLERY_ROOT = runtimeRoot;
  const messages = [];
  try {
    const reportsDir = join(runtimeRoot, "reports");
    await mkdir(reportsDir, { recursive: true });
    await writeFile(
      join(reportsDir, "llm-telemetry.jsonl"),
      `${FIXTURE.map((r) => JSON.stringify(r)).join("\n")}\n`,
      "utf8",
    );

    const exitCode = await executeQualityCostReport({
      args: ["--json"],
      commandPath: ["quality", "cost-report"],
      output: { error: (m) => messages.push(m), info: (m) => messages.push(m) },
    });

    assert.equal(exitCode, 0);
    const payload = JSON.parse(messages.find((m) => m.includes('"totals"')));
    assert.equal(payload.totals.calls, 5);
    assert.equal(payload.cost_per_session_usd.max, 0.004);
  } finally {
    if (previous === undefined) {
      delete process.env.AGENT_SESSION_DISTILLERY_ROOT;
    } else {
      process.env.AGENT_SESSION_DISTILLERY_ROOT = previous;
    }
    await rm(sandbox, { force: true, recursive: true });
  }
});
