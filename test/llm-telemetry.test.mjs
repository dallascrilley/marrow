import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { appendLlmTelemetry, buildLlmTelemetryRecord } from "../dist/pipeline/llm-telemetry.js";

function usage(overrides = {}) {
  return {
    model: "openai/gpt-5-nano",
    input_tokens: 100,
    output_tokens: 20,
    total_tokens: 120,
    reasoning_tokens: 12,
    cached_tokens: 0,
    cost: 0.00035,
    cost_source: "upstream",
    cost_is_known: true,
    missing_reason: null,
    duration_ms: 412,
    cache_hit: false,
    ...overrides,
  };
}

test("buildLlmTelemetryRecord maps usage to OTel GenAI + marrow fields", () => {
  const record = buildLlmTelemetryRecord({
    usage: usage(),
    operation: "learning_review",
    sessionId: "sess-1",
    learningId: "learn-1",
    createdAt: "2026-06-14T00:00:00.000Z",
  });

  assert.equal(record["gen_ai.provider.name"], "openrouter");
  assert.equal(record["gen_ai.operation.name"], "learning_review");
  assert.equal(record["gen_ai.request.model"], "openai/gpt-5-nano");
  assert.equal(record["gen_ai.usage.total_tokens"], 120);
  assert.equal(record["gen_ai.usage.cost"], 0.00035);
  assert.equal(record["gen_ai.usage.cost_is_known"], true);
  assert.equal(record["gen_ai.client.operation.duration_ms"], 412);
  assert.equal(record["asd.session_id"], "sess-1");
  assert.equal(record["asd.learning_id"], "learn-1");
  assert.equal(record["asd.cache_hit"], false);
});

test("buildLlmTelemetryRecord preserves unknown cost (fail-closed)", () => {
  const record = buildLlmTelemetryRecord({
    usage: usage({ cost: null, cost_is_known: false, missing_reason: "openrouter_usage_absent" }),
    operation: "learning_review",
    sessionId: "sess-1",
    createdAt: "2026-06-14T00:00:00.000Z",
  });

  assert.equal(record["gen_ai.usage.cost"], null);
  assert.equal(record["gen_ai.usage.cost_is_known"], false);
  assert.equal(record["asd.missing_reason"], "openrouter_usage_absent");
  assert.equal(record["asd.learning_id"], null);
});

test("appendLlmTelemetry appends JSONL receipts without clobbering", async () => {
  const dir = await mkdtemp(join(tmpdir(), "marrow-telemetry-"));
  const path = join(dir, "nested", "llm-telemetry.jsonl");
  const costs = [0.0001, 0.0002, 0.0003];
  try {
    for (let i = 0; i < costs.length; i += 1) {
      await appendLlmTelemetry(
        buildLlmTelemetryRecord({
          usage: usage({ cost: costs[i] }),
          operation: "learning_review",
          sessionId: `sess-${i}`,
          learningId: `learn-${i}`,
          createdAt: "2026-06-14T00:00:00.000Z",
        }),
        { path },
      );
    }

    const lines = (await readFile(path, "utf8")).trim().split("\n");
    assert.equal(lines.length, 3);
    const parsed = lines.map((line) => JSON.parse(line));
    assert.deepEqual(
      parsed.map((r) => r["asd.session_id"]),
      ["sess-0", "sess-1", "sess-2"],
    );
    assert.equal(parsed[2]["gen_ai.usage.cost"], 0.0003);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("appendLlmTelemetry swallows write errors so the pipeline is unaffected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "marrow-telemetry-fail-"));
  // Make a regular file where a directory is expected so mkdir/append fails.
  const blocker = join(dir, "blocker");
  await writeFile(blocker, "x", "utf8");
  const path = join(blocker, "llm-telemetry.jsonl");
  try {
    await assert.doesNotReject(
      appendLlmTelemetry(
        buildLlmTelemetryRecord({
          usage: usage(),
          operation: "topic_generation",
          sessionId: "sess-err",
          createdAt: "2026-06-14T00:00:00.000Z",
        }),
        { path },
      ),
    );
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});
