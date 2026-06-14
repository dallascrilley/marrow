import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createLedger } from "../dist/db/ledger.js";
import { executeQualityReviewLearnings } from "../dist/commands/quality-review-learnings.js";

const runtimeOverrideEnvVar = "AGENT_SESSION_DISTILLERY_ROOT";

async function withRuntimeRoot(run) {
  const sandboxBase = await mkdtemp(join(tmpdir(), "asd-review-learnings-gate-"));
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
