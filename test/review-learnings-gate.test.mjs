import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { executeQualityReviewLearnings } from "../dist/commands/quality-review-learnings.js";
import { createLedger } from "../dist/db/ledger.js";

const runtimeOverrideEnvVar = "MARROW_ROOT";

async function withRuntimeRoot(run) {
  const sandboxBase = await mkdtemp(join(tmpdir(), "marrow-review-learnings-gate-"));
  const runtimeRoot = join(sandboxBase, "runtime-root");
  const previousOverride = process.env[runtimeOverrideEnvVar];

  process.env[runtimeOverrideEnvVar] = runtimeRoot;

  try {
    await run();
  } finally {
    if (previousOverride === undefined) {
      delete process.env[runtimeOverrideEnvVar];
    } else {
      process.env[runtimeOverrideEnvVar] = previousOverride;
    }

    await rm(sandboxBase, { force: true, recursive: true });
  }
}

test("review-learnings --if-new skips when no unreviewed project learnings exist", async () => {
  await withRuntimeRoot(async () => {
    const database = await createLedger();
    const messages = [];

    try {
      const exitCode = await executeQualityReviewLearnings(
        {
          args: ["--if-new"],
          commandPath: ["quality", "review-learnings"],
          output: {
            error: (message) => messages.push(message),
            info: (message) => messages.push(message),
          },
        },
        database,
      );

      assert.equal(exitCode, 0);
      const skipLine = messages.find((message) => message.includes('"skipped"'));
      assert.ok(skipLine, "expected skipped JSON on info output");
      const payload = JSON.parse(skipLine);
      assert.equal(payload.skipped, true);
      assert.equal(payload.skip_reason, "no_unreviewed_project_learnings");
      assert.equal(payload.count, 0);
    } finally {
      database.close();
    }
  });
});

test("review-learnings blocks when in-window telemetry spend exceeds ASD_LLM_MAX_USD", async () => {
  const sandboxBase = await mkdtemp(join(tmpdir(), "marrow-review-usd-gate-"));
  const runtimeRoot = join(sandboxBase, "runtime-root");
  const previousOverride = process.env[runtimeOverrideEnvVar];
  const previousMaxUsd = process.env.ASD_LLM_MAX_USD;

  process.env[runtimeOverrideEnvVar] = runtimeRoot;
  process.env.ASD_LLM_MAX_USD = "0.10/24h";

  const database = await createLedger();
  const messages = [];
  try {
    // Seed a telemetry receipt whose effective cost is over the cap, in-window.
    const telemetryPath = join(runtimeRoot, "reports", "llm-telemetry.jsonl");
    await mkdir(join(runtimeRoot, "reports"), { recursive: true });
    await writeFile(
      telemetryPath,
      `${JSON.stringify({
        "gen_ai.operation.name": "learning_review",
        "gen_ai.usage.cost": 0.5,
        "gen_ai.usage.cost_is_known": true,
        "asd.cache_hit": false,
        "asd.created_at": new Date().toISOString(),
      })}\n`,
      "utf8",
    );

    const exitCode = await executeQualityReviewLearnings(
      {
        args: [],
        commandPath: ["quality", "review-learnings"],
        output: {
          error: (message) => messages.push(message),
          info: (message) => messages.push(message),
        },
      },
      database,
    );

    assert.equal(exitCode, 0);
    const skipLine = messages.find((message) => message.includes('"skipped"'));
    assert.ok(skipLine, "expected skipped JSON on info output");
    const payload = JSON.parse(skipLine);
    assert.equal(payload.skipped, true);
    assert.equal(payload.skip_reason, "llm_usd_budget_exhausted");
    assert.equal(payload.usd_budget.allowed, false);
    assert.equal(payload.usd_budget.spent_usd, 0.5);
  } finally {
    database.close();
    if (previousOverride === undefined) {
      delete process.env[runtimeOverrideEnvVar];
    } else {
      process.env[runtimeOverrideEnvVar] = previousOverride;
    }
    if (previousMaxUsd === undefined) {
      delete process.env.ASD_LLM_MAX_USD;
    } else {
      process.env.ASD_LLM_MAX_USD = previousMaxUsd;
    }
    await rm(sandboxBase, { force: true, recursive: true });
  }
});
