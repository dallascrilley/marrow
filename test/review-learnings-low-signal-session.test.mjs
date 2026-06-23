import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { executeQualityReviewLearnings } from "../dist/commands/quality-review-learnings.js";
import { createLedger, upsertSourceSession } from "../dist/db/ledger.js";
import { learningFixture, sourceSessionFixture, summaryFixture } from "../dist/models/canonical.js";
import { getProjectKnowledgeSessionPath } from "../dist/writers/knowledge-writer.js";
import { getSessionSummaryJsonPath } from "../dist/writers/summary-writer.js";

const runtimeOverrideEnvVar = "AGENT_SESSION_DISTILLERY_ROOT";

// A whole low-signal session (its summary topic is a chief-of-staff heartbeat)
// must be skipped before any paid review: none of its learnings reach OpenRouter,
// so the run spends nothing and reports them as `low_signal_session` skips.
test("review-learnings skips a low-signal-topic session without any LLM call", async () => {
  const sandboxBase = await mkdtemp(join(tmpdir(), "asd-review-low-signal-"));
  const runtimeRoot = join(sandboxBase, "runtime-root");
  const previousOverride = process.env[runtimeOverrideEnvVar];
  const previousKey = process.env.OPENROUTER_API_KEY;
  const previousFetch = globalThis.fetch;

  process.env[runtimeOverrideEnvVar] = runtimeRoot;
  process.env.OPENROUTER_API_KEY = "test-key";
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("LLM must not be called for a low-signal session");
  };

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

    // Summary topic flags the session as junk -> the session-level gate fires.
    const summaryPath = getSessionSummaryJsonPath(sourceSessionFixture.session_id);
    await mkdir(dirname(summaryPath), { recursive: true });
    await writeFile(
      summaryPath,
      JSON.stringify({
        ...summaryFixture,
        session_id: sourceSessionFixture.session_id,
        topic: "Heartbeat. Run one bounded operating loop now. This is a recurring control loop",
      }),
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
    assert.equal(fetchCalls, 0, "no OpenRouter call for a low-signal session");

    const payloadLine = messages.find((message) => message.includes("skipped_pre_llm_breakdown"));
    assert.ok(payloadLine, "expected JSON payload on info output");
    const payload = JSON.parse(payloadLine);
    assert.equal(payload.total_reviewed_learnings, 0, "nothing reviewed");
    assert.equal(
      payload.skipped_pre_llm_breakdown.low_signal_session,
      1,
      "the session's learning is skipped as low_signal_session",
    );
  } finally {
    globalThis.fetch = previousFetch;
    database.close();
    if (previousOverride === undefined) {
      delete process.env[runtimeOverrideEnvVar];
    } else {
      process.env[runtimeOverrideEnvVar] = previousOverride;
    }
    if (previousKey === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = previousKey;
    }
    await rm(sandboxBase, { force: true, recursive: true });
  }
});
