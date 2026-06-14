import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { executeQualityReviewLearnings } from "../dist/commands/quality-review-learnings.js";
import { createLedger, upsertSourceSession } from "../dist/db/ledger.js";
import { learningFixture, sourceSessionFixture } from "../dist/models/canonical.js";
import { getProjectKnowledgeSessionPath } from "../dist/writers/knowledge-writer.js";

const runtimeOverrideEnvVar = "AGENT_SESSION_DISTILLERY_ROOT";

async function withRuntimeRoot(run) {
  const sandboxBase = await mkdtemp(join(tmpdir(), "asd-review-provider-fail-"));
  const runtimeRoot = join(sandboxBase, "runtime-root");
  const previousOverride = process.env[runtimeOverrideEnvVar];
  const previousKey = process.env.OPENROUTER_API_KEY;

  process.env[runtimeOverrideEnvVar] = runtimeRoot;
  // Force the OpenRouter reviewer to throw (no key) so we exercise the
  // provider-failure path deterministically and offline.
  delete process.env.OPENROUTER_API_KEY;

  try {
    await run(runtimeRoot);
  } finally {
    if (previousOverride === undefined) {
      delete process.env[runtimeOverrideEnvVar];
    } else {
      process.env[runtimeOverrideEnvVar] = previousOverride;
    }
    if (previousKey !== undefined) {
      process.env.OPENROUTER_API_KEY = previousKey;
    }
    await rm(sandboxBase, { force: true, recursive: true });
  }
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test("review-learnings does not poison the sidecar or budget when the provider fails", async () => {
  await withRuntimeRoot(async (runtimeRoot) => {
    const database = await createLedger();
    const messages = [];

    try {
      upsertSourceSession(database, sourceSessionFixture);

      const learningPath = getProjectKnowledgeSessionPath(
        sourceSessionFixture.project_key,
        sourceSessionFixture.session_id,
      );
      await mkdir(dirname(learningPath), { recursive: true });
      await writeFile(learningPath, `${JSON.stringify(learningFixture)}\n`, "utf8");

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

      const payloadLine = messages.find((message) => message.includes('"failed"'));
      assert.ok(payloadLine, "expected JSON payload on info output");
      const payload = JSON.parse(payloadLine);

      // Provider failure must surface loudly, not as a review verdict.
      assert.equal(payload.count, 0, "no learnings were successfully reviewed");
      assert.ok(payload.failed >= 1, "the failed call is reported");
      assert.equal(payload.skipped, true);
      assert.equal(payload.skip_reason, "llm_provider_error");
      assert.equal(payload.total_reviewed_learnings, 0, "budget counter not inflated by failures");

      // The sidecar must not be created/clobbered with fake rejections.
      const sidecarPath = join(runtimeRoot, "reports", "llm-learning-review.jsonl");
      assert.equal(await fileExists(sidecarPath), false, "sidecar not written on total failure");

      // The LLM budget window must not be consumed by a failed run.
      const budgetPath = join(runtimeRoot, "reports", "llm-budget.json");
      assert.equal(await fileExists(budgetPath), false, "budget not consumed on failure");
    } finally {
      database.close();
    }
  });
});
