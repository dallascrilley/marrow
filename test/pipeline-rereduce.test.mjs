import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  executePipelineRereduce,
  parseRereduceOptions,
} from "../dist/commands/pipeline-rereduce.js";
import { createLedger, getSourceSessionBySessionId, upsertSourceSession } from "../dist/db/ledger.js";
import { sourceSessionFixture } from "../dist/models/canonical.js";
import { getParsedArtifactPath } from "../dist/pipeline/parse.js";
import { getReducedArtifactPath } from "../dist/pipeline/reduce.js";
import { runSummarizePhase } from "../dist/pipeline/summarize-phase.js";
import { getSessionSummaryJsonPath } from "../dist/writers/summary-writer.js";

const runtimeOverrideEnvVar = "AGENT_SESSION_DISTILLERY_ROOT";

async function withRuntimeRoot(run) {
  const sandboxBase = await mkdtemp(join(tmpdir(), "asd-rereduce-"));
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

function makeRecord(overrides = {}) {
  const kind = overrides.kind ?? "event";

  return {
    commandStrings: overrides.commandStrings ?? [],
    contentRedacted: overrides.contentRedacted ?? false,
    filePaths: overrides.filePaths ?? [],
    kind,
    messageText: overrides.messageText ?? null,
    provenance: {
      lineNumber: overrides.lineNumber ?? 1,
      sourceHash: "sha256:test-source",
      sourcePath: "/tmp/session.jsonl",
    },
    rawEvent: overrides.rawEvent ?? { type: overrides.rawType ?? kind },
    rawType: overrides.rawType ?? kind,
    timestampHint: overrides.timestampHint ?? null,
    toolUse: overrides.toolUse ?? null,
  };
}

function registerSession(database, sessionId) {
  upsertSourceSession(database, {
    ...sourceSessionFixture,
    conversation_id: `demo:${sessionId}`,
    ingest_status: "extracted",
    session_id: sessionId,
    source_hash: `sha256:${sessionId}`,
    source_path: `/nonexistent/${sessionId}.jsonl`,
  });
}

const failureTurnRecords = [
  makeRecord({ kind: "user_message", lineNumber: 1, messageText: "Fix the failing ingest." }),
  makeRecord({
    kind: "tool_result_stub",
    lineNumber: 2,
    messageText: "asd ingest sync failed: checkpoint mismatch",
    toolUse: { callId: "tool-9", inputText: null, name: "run_terminal_command", status: "failed" },
  }),
  makeRecord({
    kind: "assistant_message",
    lineNumber: 3,
    messageText:
      `${"Walking the ledger state. ".repeat(40)}The root cause was a stale checkpoint ` +
      "left by the interrupted run; clearing it lets resume proceed.",
  }),
];

test("parseRereduceOptions parses selectors and flags", () => {
  assert.deepEqual(parseRereduceOptions(["--dry-run", "--all-with-parsed"]), {
    allWithParsed: true,
    dryRun: true,
    sessionIds: [],
  });
  assert.deepEqual(parseRereduceOptions(["--session-id", "a", "--session-id", "b"]), {
    allWithParsed: false,
    dryRun: false,
    sessionIds: ["a", "b"],
  });
});

test("parseRereduceOptions rejects unknown flags and missing values", () => {
  assert.throws(() => parseRereduceOptions(["--nope"]), /Unknown rereduce option/);
  assert.throws(() => parseRereduceOptions(["--session-id"]), /--session-id requires a value/);
});

test("executePipelineRereduce refuses to run without an explicit selector", async () => {
  await withRuntimeRoot(async () => {
    const database = await createLedger();
    await assert.rejects(
      executePipelineRereduce({ args: [], commandPath: [], output: makeOutput() }, database),
      /explicit selector/,
    );
    database.close();
  });
});

test("--all-with-parsed --dry-run partitions sessions by parsed-record survival", async () => {
  await withRuntimeRoot(async () => {
    const database = await createLedger();
    registerSession(database, "has-parsed");
    registerSession(database, "locked-sess");

    const parsedPath = getParsedArtifactPath("has-parsed");
    await mkdir(dirname(parsedPath), { recursive: true });
    await writeFile(parsedPath, JSON.stringify(failureTurnRecords), "utf8");

    const output = makeOutput();
    const rc = await executePipelineRereduce(
      { args: ["--all-with-parsed", "--dry-run"], commandPath: [], output },
      database,
    );
    assert.equal(rc, 0);

    const result = JSON.parse(output.lines.join("\n"));
    assert.equal(result.dry_run, true);
    assert.deepEqual(result.candidate_session_ids, ["has-parsed"]);
    assert.deepEqual(result.locked_session_ids, ["locked-sess"]);

    database.close();
  });
});

test("pipeline rereduce re-reduces from parsed records with current fidelity", async () => {
  await withRuntimeRoot(async () => {
    const database = await createLedger();
    registerSession(database, "rereduce-sess");
    registerSession(database, "locked-sess");

    const parsedPath = getParsedArtifactPath("rereduce-sess");
    await mkdir(dirname(parsedPath), { recursive: true });
    await writeFile(parsedPath, JSON.stringify(failureTurnRecords), "utf8");

    const output = makeOutput();
    const rc = await executePipelineRereduce(
      { args: ["--all-with-parsed"], commandPath: [], output },
      database,
    );
    assert.equal(rc, 0);

    const result = JSON.parse(output.lines.join("\n"));
    assert.equal(result.rereduced_count, 1);
    assert.deepEqual(result.locked_session_ids, ["locked-sess"]);

    const reduced = JSON.parse(await readFile(getReducedArtifactPath("rereduce-sess"), "utf8"));
    assert.equal(reduced.turns.length, 1);
    assert.ok(
      reduced.turns[0].assistant_summary.includes("The root cause was a stale checkpoint"),
      "re-reduced artifact must keep failure-adjacent root-cause text",
    );

    const summary = JSON.parse(await readFile(getSessionSummaryJsonPath("rereduce-sess"), "utf8"));
    assert.equal(summary.session_id, "rereduce-sess");
    assert.equal(
      summary.deletion_readiness,
      "ready",
      "archive phase must write the retention verdict into the persisted summary",
    );

    database.close();
  });
});

test("summarize phase preserves the ledger deletion verdict when regenerating", async () => {
  await withRuntimeRoot(async () => {
    const database = await createLedger();
    registerSession(database, "verdict-sess");

    const parsedPath = getParsedArtifactPath("verdict-sess");
    await mkdir(dirname(parsedPath), { recursive: true });
    await writeFile(parsedPath, JSON.stringify(failureTurnRecords), "utf8");

    const rc = await executePipelineRereduce(
      { args: ["--session-id", "verdict-sess"], commandPath: [], output: makeOutput() },
      database,
    );
    assert.equal(rc, 0);
    const afterArchive = JSON.parse(
      await readFile(getSessionSummaryJsonPath("verdict-sess"), "utf8"),
    );
    assert.equal(afterArchive.deletion_readiness, "ready");

    // Regenerating the summary (the resummarize path) must not clobber the
    // verdict back to "not_ready" — it threads the ledger's latest state.
    const session = getSourceSessionBySessionId(database, "verdict-sess");
    const reduced = JSON.parse(await readFile(getReducedArtifactPath("verdict-sess"), "utf8"));
    await runSummarizePhase(database, session, reduced.turns, reduced.events, false, false, true);

    const regenerated = JSON.parse(
      await readFile(getSessionSummaryJsonPath("verdict-sess"), "utf8"),
    );
    assert.equal(regenerated.deletion_readiness, "ready");

    database.close();
  });
});

test("pipeline rereduce exits non-zero when every matched session is locked", async () => {
  await withRuntimeRoot(async () => {
    const database = await createLedger();
    registerSession(database, "locked-sess");

    const output = makeOutput();
    const rc = await executePipelineRereduce(
      { args: ["--all-with-parsed"], commandPath: [], output },
      database,
    );
    assert.equal(rc, 1);

    const result = JSON.parse(output.lines.join("\n"));
    assert.equal(result.rereduced_count, 0);
    assert.deepEqual(result.locked_session_ids, ["locked-sess"]);

    database.close();
  });
});
