import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assessLlmBudget,
  parseMaxPerWindow,
  recordLlmBudgetUse,
} from "../dist/pipeline/llm-budget.js";

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
