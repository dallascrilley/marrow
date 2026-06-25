import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  executePipelineReextract,
  parseReextractOptions,
} from "../dist/commands/pipeline-reextract.js";
import { createLedger, upsertSourceSession } from "../dist/db/ledger.js";
import { eventFixture, sourceSessionFixture, turnFixture } from "../dist/models/canonical.js";
import { hasProcessChatter } from "../dist/pipeline/artifact-heuristics.js";
import { getReducedArtifactPath } from "../dist/pipeline/reduce.js";
import { getSessionSummaryJsonPath } from "../dist/writers/summary-writer.js";

const runtimeOverrideEnvVar = "AGENT_SESSION_DISTILLERY_ROOT";

async function withRuntimeRoot(run) {
  const sandboxBase = await mkdtemp(join(tmpdir(), "asd-reextract-"));
  const runtimeRoot = join(sandboxBase, "runtime-root");
  const previousOverride = process.env[runtimeOverrideEnvVar];
  process.env[runtimeOverrideEnvVar] = runtimeRoot;
  try {
    await run(runtimeRoot);
  } finally {
    if (previousOverride === undefined) {
      delete process.env[runtimeOverrideEnvVar];
    } else {
      process.env[runtimeOverrideEnvVar] = previousOverride;
    }
    await rm(sandboxBase, { force: true, recursive: true });
  }
}

function makeOutput() {
  const lines = [];
  return {
    error: (message) => lines.push(String(message)),
    info: (message) => lines.push(String(message)),
    lines,
  };
}

test("parseReextractOptions parses selectors and flags", () => {
  assert.deepEqual(parseReextractOptions(["--dry-run", "--process-chatter-only"]), {
    dryRun: true,
    processChatterOnly: true,
    sessionIds: [],
  });
  assert.deepEqual(parseReextractOptions(["--session-id", "a", "--session-id", "b"]), {
    dryRun: false,
    processChatterOnly: false,
    sessionIds: ["a", "b"],
  });
});

test("parseReextractOptions rejects unknown flags and missing values", () => {
  assert.throws(() => parseReextractOptions(["--nope"]), /Unknown reextract option/);
  assert.throws(() => parseReextractOptions(["--session-id"]), /--session-id requires a value/);
});

test("executePipelineReextract refuses to run without an explicit selector", async () => {
  await withRuntimeRoot(async () => {
    const database = await createLedger();
    await assert.rejects(
      executePipelineReextract({ args: [], commandPath: [], output: makeOutput() }, database),
      /explicit selector/,
    );
    database.close();
  });
});

test("--process-chatter-only --dry-run matches only flagged sessions", async () => {
  await withRuntimeRoot(async () => {
    const database = await createLedger();
    for (const [id, decided] of [
      ["chatter-sess", ["Let me check the logs now."]],
      ["clean-sess", ["Use worker threads instead of forks."]],
    ]) {
      upsertSourceSession(database, {
        ...sourceSessionFixture,
        conversation_id: `demo:${id}`,
        ingest_status: "extracted",
        session_id: id,
        source_hash: `sha256:${id}`,
        source_path: `/nonexistent/${id}.jsonl`,
      });
      const summaryPath = getSessionSummaryJsonPath(id);
      await mkdir(dirname(summaryPath), { recursive: true });
      await writeFile(
        summaryPath,
        JSON.stringify({
          deletion_readiness: "not_ready",
          files_of_interest: [],
          next_step: "No explicit next step recorded.",
          project_learnings: [],
          session_id: id,
          topic: "t",
          topic_source: "deterministic",
          useful_commands: [],
          user_learnings: [],
          what_failed: [],
          what_was_decided: decided,
          what_worked: [],
        }),
        "utf8",
      );
    }

    const output = makeOutput();
    const rc = await executePipelineReextract(
      { args: ["--process-chatter-only", "--dry-run"], commandPath: [], output },
      database,
    );
    assert.equal(rc, 0);

    const result = JSON.parse(output.lines.join("\n"));
    assert.equal(result.dry_run, true);
    assert.equal(result.matched_count, 1);
    assert.deepEqual(result.matched_session_ids, ["chatter-sess"]);

    database.close();
  });
});

test("pipeline reextract regenerates the summary and drops process_chatter", async () => {
  await withRuntimeRoot(async () => {
    const database = await createLedger();
    const sessionId = "reextract-sess";
    // Register the session in the ledger so --session-id can resolve it.
    upsertSourceSession(database, {
      ...sourceSessionFixture,
      conversation_id: "demo:reextract",
      ingest_status: "extracted",
      session_id: sessionId,
      source_hash: "sha256:reextract",
      source_path: "/nonexistent/reextract.jsonl",
    });

    // Reduced artifact: one durable decision + one process-chatter decision.
    const turns = [
      { ...turnFixture, session_id: sessionId, user_prompt: "Fix the failing retention test." },
    ];
    const events = [
      {
        ...eventFixture,
        event_id: "ev-clean",
        turn_id: turnFixture.turn_id,
        type: "decision",
        summary: "Use worker threads instead of forks.",
      },
      {
        ...eventFixture,
        event_id: "ev-chatter",
        turn_id: turnFixture.turn_id,
        type: "decision",
        summary: "Let me check the logs now.",
      },
    ];
    const reducedPath = getReducedArtifactPath(sessionId);
    await mkdir(dirname(reducedPath), { recursive: true });
    await writeFile(reducedPath, JSON.stringify({ events, turns }), "utf8");

    // Stale summary carrying process_chatter (simulates a pre-filter artifact).
    const summaryPath = getSessionSummaryJsonPath(sessionId);
    await mkdir(dirname(summaryPath), { recursive: true });
    const staleSummary = {
      deletion_readiness: "not_ready",
      files_of_interest: [],
      next_step: "No explicit next step recorded.",
      project_learnings: [],
      session_id: sessionId,
      topic: "Retention test fix",
      topic_source: "deterministic",
      useful_commands: [],
      user_learnings: [],
      what_failed: [],
      what_was_decided: ["Let me check the logs now.", "Use worker threads instead of forks."],
      what_worked: [],
    };
    await writeFile(summaryPath, JSON.stringify(staleSummary), "utf8");
    assert.ok(
      hasProcessChatter(staleSummary.what_was_decided.join("\n")),
      "fixture summary should start out flagged as process_chatter",
    );

    const rc = await executePipelineReextract(
      { args: ["--session-id", sessionId], commandPath: [], output: makeOutput() },
      database,
    );
    assert.equal(rc, 0);

    const regenerated = JSON.parse(await readFile(summaryPath, "utf8"));
    const summaryText = [
      regenerated.topic,
      ...regenerated.what_worked,
      ...regenerated.what_failed,
      ...regenerated.what_was_decided,
      regenerated.next_step,
      ...regenerated.project_learnings,
      ...regenerated.user_learnings,
    ].join("\n");

    assert.ok(!hasProcessChatter(summaryText), "reextract must regenerate a chatter-free summary");
    assert.ok(
      regenerated.what_was_decided.includes("Use worker threads instead of forks."),
      "the durable decision must survive reextraction",
    );
    assert.ok(
      !regenerated.what_was_decided.some((line) => /let me check/i.test(line)),
      "the process-chatter decision must be dropped",
    );

    database.close();
  });
});
