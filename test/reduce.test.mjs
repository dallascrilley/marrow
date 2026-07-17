import assert from "node:assert/strict";
import test from "node:test";

import { tagTurnEvents } from "../dist/reducers/event-tagging.js";
import { groupRecordsIntoTurns } from "../dist/reducers/turn-grouping.js";
import {
  buildAssistantSummary,
  defaultAssistantSummaryBudget,
} from "../dist/pipeline/reduce.js";

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

function singleTurn(records, sessionId) {
  const turns = groupRecordsIntoTurns({ records, sessionId });
  assert.equal(turns.length, 1);
  const events = tagTurnEvents(turns);
  return { events, turn: turns[0] };
}

test("keeps the 240-char budget for turns without failure or verification signal", () => {
  const { events, turn } = singleTurn(
    [
      makeRecord({ kind: "user_message", lineNumber: 1, messageText: "Tidy up the README." }),
      makeRecord({
        kind: "assistant_message",
        lineNumber: 2,
        messageText: `Updated the docs. ${"Routine detail. ".repeat(80)}`,
      }),
    ],
    "session-calm",
  );

  const summary = buildAssistantSummary(turn, events);

  assert.ok(summary.length <= defaultAssistantSummaryBudget);
  assert.ok(summary.endsWith("..."));
});

test("keeps failure-adjacent root-cause text for turns with a failed tool result", () => {
  const rootCause =
    "The root cause was the missing fixture path: the loader resolved fixtures relative to " +
    "the worktree, not the primary checkout, so every read after the switch returned ENOENT.";
  const { events, turn } = singleTurn(
    [
      makeRecord({ kind: "user_message", lineNumber: 1, messageText: "Fix the failing test." }),
      makeRecord({
        kind: "tool_use_stub",
        lineNumber: 2,
        commandStrings: ["npm test"],
        toolUse: {
          callId: "tool-1",
          inputText: "npm test",
          name: "run_terminal_command",
          status: "started",
        },
      }),
      makeRecord({
        kind: "tool_result_stub",
        lineNumber: 3,
        messageText: "npm test failed: 1 failing",
        toolUse: { callId: "tool-1", inputText: null, name: "run_terminal_command", status: "error" },
      }),
      makeRecord({
        kind: "assistant_message",
        lineNumber: 4,
        messageText: `${"Investigating the failure output. ".repeat(30)}${rootCause}`,
      }),
    ],
    "session-failure",
  );

  const summary = buildAssistantSummary(turn, events);

  assert.ok(summary.length > defaultAssistantSummaryBudget);
  assert.ok(summary.includes("The root cause was the missing fixture path"));
});

test("gives verification turns the high-signal budget so the verdict context survives", () => {
  const tail = "All 47 integration suites passed, including the cursor live-regression fixture.";
  const { events, turn } = singleTurn(
    [
      makeRecord({ kind: "user_message", lineNumber: 1, messageText: "Verify the ingest change." }),
      makeRecord({
        kind: "assistant_message",
        lineNumber: 2,
        messageText: `${"Walked through each suite in turn. ".repeat(30)}Verified: tests pass. ${tail}`,
      }),
    ],
    "session-verified",
  );

  const summary = buildAssistantSummary(turn, events);

  assert.ok(summary.length > defaultAssistantSummaryBudget);
  assert.ok(summary.includes(tail));
});

test("does not duplicate the focus message in the head remainder", () => {
  const rootCause = "The root cause was a stale checkpoint left by the interrupted run.";
  const { events, turn } = singleTurn(
    [
      makeRecord({ kind: "user_message", lineNumber: 1, messageText: "Why did resume fail?" }),
      makeRecord({
        kind: "tool_result_stub",
        lineNumber: 2,
        messageText: "asd ingest sync failed: checkpoint mismatch",
        toolUse: { callId: "tool-9", inputText: null, name: "run_terminal_command", status: "failed" },
      }),
      makeRecord({
        kind: "assistant_message",
        lineNumber: 3,
        messageText: `Short lead-in. ${rootCause}`,
      }),
    ],
    "session-dedupe",
  );

  const summary = buildAssistantSummary(turn, events);

  assert.equal(summary.split("root cause").length - 1, 1);
});

test("falls back to the placeholder when no assistant text exists", () => {
  const { events, turn } = singleTurn(
    [makeRecord({ kind: "user_message", lineNumber: 1, messageText: "Ping." })],
    "session-empty",
  );

  assert.equal(buildAssistantSummary(turn, events), "No assistant summary captured.");
});
