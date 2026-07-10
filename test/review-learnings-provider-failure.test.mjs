import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
      assert.equal(payload.generated_batch, false);
      assert.equal(payload.batch_path, null);

      // No review artifact is created for a failed run.
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

test("review-learnings records telemetry for successful calls before a later provider failure", async () => {
  await withRuntimeRoot(async (runtimeRoot) => {
    const database = await createLedger();
    const messages = [];
    const previousFetch = globalThis.fetch;
    let calls = 0;

    try {
      globalThis.fetch = async () => {
        calls += 1;
        if (calls === 1) {
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        reviews: [
                          {
                            id: "learning-1",
                            durability: "durable",
                            keep: true,
                            reason: "Useful durable learning.",
                            statement: "Keep telemetry for successful calls before failures.",
                            verdict: "rewrite",
                          },
                        ],
                      }),
                    },
                  },
                ],
                usage: {
                  prompt_tokens: 100,
                  completion_tokens: 20,
                  total_tokens: 120,
                  cost: 0.00042,
                },
              };
            },
            async text() {
              return "";
            },
          };
        }

        return {
          ok: false,
          status: 500,
          async json() {
            return {};
          },
          async text() {
            return "temporary upstream failure";
          },
        };
      };

      process.env.OPENROUTER_API_KEY = "test-key";
      upsertSourceSession(database, sourceSessionFixture);

      const learningPath = getProjectKnowledgeSessionPath(
        sourceSessionFixture.project_key,
        sourceSessionFixture.session_id,
      );
      await mkdir(dirname(learningPath), { recursive: true });
      await writeFile(
        learningPath,
        `${JSON.stringify({ ...learningFixture, learning_id: "learning-1" })}\n${JSON.stringify({
          ...learningFixture,
          learning_id: "learning-2",
          statement: "Second learning fails after the first succeeds.",
        })}\n`,
        "utf8",
      );

      // batch-size 1 keeps each learning a separate HTTP call so we can exercise
      // "first call succeeds, second call fails" with batched semantics.
      const exitCode = await executeQualityReviewLearnings(
        {
          args: ["--no-cache", "--batch-size", "1"],
          commandPath: ["quality", "review-learnings"],
          output: {
            error: (message) => messages.push(message),
            info: (message) => messages.push(message),
          },
        },
        database,
      );

      assert.equal(exitCode, 0);
      assert.equal(calls, 2);

      const payloadLine = messages.find((message) => message.includes('"failed"'));
      assert.ok(payloadLine, "expected JSON payload on info output");
      const payload = JSON.parse(payloadLine);
      assert.equal(payload.count, 1);
      assert.equal(payload.failed, 1);
      assert.equal(payload.total_reviewed_learnings, 1);
      assert.equal(payload.skipped, undefined);

      assert.equal(payload.generated_batch, true);
      const batch = JSON.parse(await readFile(payload.batch_path, "utf8"));
      assert.equal(batch.count, 1);
      assert.equal(batch.reviews[0].learning_id, "learning-1");

      const telemetryPath = join(runtimeRoot, "reports", "llm-telemetry.jsonl");
      const telemetryLines = (await readFile(telemetryPath, "utf8")).trim().split("\n");
      assert.equal(telemetryLines.length, 1);
      const telemetry = JSON.parse(telemetryLines[0]);
      assert.equal(telemetry["asd.learning_id"], "learning-1");
      assert.equal(telemetry["gen_ai.usage.cost"], 0.00042);
      assert.equal(telemetry["asd.batch_size"], 1);
    } finally {
      globalThis.fetch = previousFetch;
      database.close();
    }
  });
});
