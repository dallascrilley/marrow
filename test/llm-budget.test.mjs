import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assessLlmBudget,
  assessUsdBudget,
  getDefaultMaxPerWindow,
  parseMaxPerWindow,
  parseMaxUsdWindow,
  recordLlmBudgetUse,
} from "../dist/pipeline/llm-budget.js";

function telemetryRecord({ cost, costIsKnown = true, createdAt }) {
  return JSON.stringify({
    "gen_ai.provider.name": "openrouter",
    "gen_ai.operation.name": "learning_review",
    "gen_ai.request.model": "openai/gpt-5-nano",
    "gen_ai.usage.input_tokens": 100,
    "gen_ai.usage.output_tokens": 20,
    "gen_ai.usage.total_tokens": 120,
    "gen_ai.usage.reasoning_tokens": 5,
    "gen_ai.usage.cached_tokens": 0,
    "gen_ai.usage.cost": cost,
    "gen_ai.usage.cost_is_known": costIsKnown,
    "gen_ai.client.operation.duration_ms": 10,
    "asd.cost_source": "upstream",
    "asd.session_id": "ses-1",
    "asd.learning_id": "learning-1",
    "asd.cache_hit": false,
    "asd.missing_reason": null,
    "asd.batch_size": 1,
    "asd.created_at": createdAt,
  });
}

async function withTelemetryFile(lines, run) {
  const dir = await mkdtemp(join(tmpdir(), "asd-usd-budget-"));
  const path = join(dir, "llm-telemetry.jsonl");
  await writeFile(path, lines.length === 0 ? "" : `${lines.join("\n")}\n`, "utf8");
  try {
    await run(path);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

const runtimeOverrideEnvVar = "AGENT_SESSION_DISTILLERY_ROOT";

async function withRuntimeRoot(run) {
  const sandboxBase = await mkdtemp(join(tmpdir(), "asd-llm-budget-"));
  const runtimeRoot = join(sandboxBase, "runtime-root");
  const previousOverride = process.env[runtimeOverrideEnvVar];
  const previousMaxPer = process.env.ASD_LLM_MAX_PER;

  process.env[runtimeOverrideEnvVar] = runtimeRoot;
  delete process.env.ASD_LLM_MAX_PER;

  try {
    await run();
  } finally {
    if (previousOverride === undefined) {
      delete process.env[runtimeOverrideEnvVar];
    } else {
      process.env[runtimeOverrideEnvVar] = previousOverride;
    }

    if (previousMaxPer === undefined) {
      delete process.env.ASD_LLM_MAX_PER;
    } else {
      process.env.ASD_LLM_MAX_PER = previousMaxPer;
    }

    await rm(sandboxBase, { force: true, recursive: true });
  }
}

test("parseMaxPerWindow accepts hour and minute windows", () => {
  const hours = parseMaxPerWindow("5/24h");
  assert.equal(hours.max, 5);
  assert.equal(hours.windowAmount, 24);
  assert.equal(hours.windowMs, 24 * 60 * 60 * 1000);

  const minutes = parseMaxPerWindow("2/30m");
  assert.equal(minutes.max, 2);
  assert.equal(minutes.windowMs, 30 * 60 * 1000);
});

test("parseMaxPerWindow rejects invalid specs", () => {
  assert.throws(() => parseMaxPerWindow("five/24h"), /Invalid max-per window/);
  assert.throws(() => parseMaxPerWindow("5/24"), /Invalid max-per window/);
});

test("getDefaultMaxPerWindow reads ASD_LLM_MAX_PER and falls back to 5/24h", () => {
  const previous = process.env.ASD_LLM_MAX_PER;

  try {
    delete process.env.ASD_LLM_MAX_PER;
    assert.equal(getDefaultMaxPerWindow(), "5/24h");

    process.env.ASD_LLM_MAX_PER = "12/24h";
    assert.equal(getDefaultMaxPerWindow(), "12/24h");
  } finally {
    if (previous === undefined) {
      delete process.env.ASD_LLM_MAX_PER;
    } else {
      process.env.ASD_LLM_MAX_PER = previous;
    }
  }
});

test("parseMaxUsdWindow accepts fractional USD amounts", () => {
  const whole = parseMaxUsdWindow("1/24h");
  assert.equal(whole.maxUsd, 1);
  assert.equal(whole.windowMs, 24 * 60 * 60 * 1000);

  const fractional = parseMaxUsdWindow("0.50/30m");
  assert.equal(fractional.maxUsd, 0.5);
  assert.equal(fractional.windowMs, 30 * 60 * 1000);
});

test("parseMaxUsdWindow rejects invalid specs", () => {
  assert.throws(() => parseMaxUsdWindow("$1/24h"), /Invalid max-usd window/);
  assert.throws(() => parseMaxUsdWindow("1/24"), /Invalid max-usd window/);
});

test("assessUsdBudget allows under the cap and blocks over it", async () => {
  const now = Date.parse("2026-06-14T12:00:00.000Z");
  const recent = new Date(now - 60 * 60 * 1000).toISOString(); // 1h ago, in window

  await withTelemetryFile([telemetryRecord({ cost: 0.4, createdAt: recent })], async (path) => {
    const under = await assessUsdBudget("1/24h", { now, telemetryPath: path });
    assert.equal(under.allowed, true);
    assert.equal(under.spent_usd, 0.4);
    assert.equal(under.remaining_usd, 0.6);
  });

  await withTelemetryFile(
    [
      telemetryRecord({ cost: 0.7, createdAt: recent }),
      telemetryRecord({ cost: 0.5, createdAt: recent }),
    ],
    async (path) => {
      const over = await assessUsdBudget("1/24h", { now, telemetryPath: path });
      assert.equal(over.allowed, false, "spend of 1.2 over a 1.0 cap blocks");
      assert.equal(over.spent_usd, 1.2);
      assert.equal(over.remaining_usd, 0);
    },
  );
});

test("assessUsdBudget releases budget once spend ages out of the window", async () => {
  const now = Date.parse("2026-06-14T12:00:00.000Z");
  const old = new Date(now - 26 * 60 * 60 * 1000).toISOString(); // 26h ago, outside 24h

  await withTelemetryFile([telemetryRecord({ cost: 5, createdAt: old })], async (path) => {
    const status = await assessUsdBudget("1/24h", { now, telemetryPath: path });
    assert.equal(status.allowed, true, "spend older than the window does not count");
    assert.equal(status.spent_usd, 0);
  });
});

test("assessUsdBudget ignores unknown-cost calls", async () => {
  const now = Date.parse("2026-06-14T12:00:00.000Z");
  const recent = new Date(now - 60 * 1000).toISOString();

  await withTelemetryFile(
    [telemetryRecord({ cost: null, costIsKnown: false, createdAt: recent })],
    async (path) => {
      const status = await assessUsdBudget("1/24h", { now, telemetryPath: path });
      assert.equal(status.spent_usd, 0, "never estimate spend from unknown-cost calls");
      assert.equal(status.allowed, true);
    },
  );
});

test("assessLlmBudget tracks sliding-window uses", async () => {
  await withRuntimeRoot(async () => {
    const maxPer = "2/1h";
    let status = await assessLlmBudget(maxPer);
    assert.equal(status.allowed, true);
    assert.equal(status.remaining, 2);

    status = await recordLlmBudgetUse(maxPer);
    assert.equal(status.used_in_window, 1);
    assert.equal(status.remaining, 1);

    status = await recordLlmBudgetUse(maxPer);
    assert.equal(status.used_in_window, 2);
    assert.equal(status.remaining, 0);
    assert.equal(status.allowed, false);
  });
});
