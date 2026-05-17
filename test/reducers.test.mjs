import test from "node:test";
import assert from "node:assert/strict";

import { extractCommandsByTurn } from "../dist/reducers/command-extraction.js";
import { tagTurnEvents } from "../dist/reducers/event-tagging.js";
import { pruneTranscriptPayload } from "../dist/reducers/payload-pruning.js";
import { groupRecordsIntoTurns } from "../dist/reducers/turn-grouping.js";

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
      sourcePath: "/tmp/session.jsonl"
    },
    rawEvent: overrides.rawEvent ?? {
      type: overrides.rawType ?? kind,
      message: overrides.messageText ?? null,
      huge: {
        nested: Array.from({ length: 20 }, (_, index) => `item-${index}`)
      }
    },
    rawType: overrides.rawType ?? kind,
    timestampHint: overrides.timestampHint ?? null,
    toolUse: overrides.toolUse ?? null
  };
}

test("groups raw records into user-led turns and carries pre-user context into the next turn", () => {
  const records = [
    makeRecord({
      kind: "assistant_message",
      lineNumber: 1,
      messageText: "Loading prior context before the user asks."
    }),
    makeRecord({
      kind: "tool_result_stub",
      lineNumber: 2,
      filePaths: ["/Users/example/project/src/seed.ts"]
    }),
    makeRecord({
      kind: "user_message",
      lineNumber: 3,
      messageText: "Implement turn grouping."
    }),
    makeRecord({
      kind: "assistant_message",
      lineNumber: 4,
      messageText: "I decided to keep the reducer local for now.",
      timestampHint: "2026-05-16T20:00:04.000Z"
    }),
    makeRecord({
      kind: "user_message",
      lineNumber: 5,
      messageText: null,
      contentRedacted: true
    }),
    makeRecord({
      kind: "assistant_message",
      lineNumber: 6,
      messageText: "Next step is adding tests.",
      timestampHint: "2026-05-16T20:00:06.000Z"
    })
  ];

  const turns = groupRecordsIntoTurns({
    records,
    sessionId: "session-123"
  });

  assert.equal(turns.length, 2);
  assert.deepEqual(
    turns.map((turn) => ({
      assistantMessages: turn.assistantMessages,
      endedAtHint: turn.endedAtHint,
      lines: [turn.sourceLineStart, turn.sourceLineEnd],
      startedAtHint: turn.startedAtHint,
      turnId: turn.turnId,
      userPrompt: turn.userPrompt
    })),
    [
      {
        assistantMessages: [
          "Loading prior context before the user asks.",
          "I decided to keep the reducer local for now."
        ],
        endedAtHint: "2026-05-16T20:00:04.000Z",
        lines: [1, 4],
        startedAtHint: "2026-05-16T20:00:04.000Z",
        turnId: "session-123:turn-0000",
        userPrompt: "Implement turn grouping."
      },
      {
        assistantMessages: ["Next step is adding tests."],
        endedAtHint: "2026-05-16T20:00:06.000Z",
        lines: [5, 6],
        startedAtHint: "2026-05-16T20:00:06.000Z",
        turnId: "session-123:turn-0001",
        userPrompt: "[redacted user message]"
      }
    ]
  );
});

test("prunes bulky payloads, dedupes useful commands, and tags only explicit signals", () => {
  const hugeText = "x".repeat(500);
  const records = [
    makeRecord({
      kind: "user_message",
      lineNumber: 10,
      messageText: "Run npm test and then build."
    }),
    makeRecord({
      kind: "assistant_message",
      lineNumber: 11,
      messageText: "I decided to keep the reducer local for now."
    }),
    makeRecord({
      kind: "tool_use_stub",
      lineNumber: 12,
      commandStrings: ["npm test", "`npm test`", "plain english request"],
      toolUse: {
        callId: "tool-001",
        inputText: "npm test",
        name: "run_terminal_command",
        status: "started"
      },
      rawType: "tool_call"
    }),
    makeRecord({
      kind: "assistant_message",
      lineNumber: 13,
      messageText: "npm test failed with ENOENT while loading the fixture."
    }),
    makeRecord({
      kind: "assistant_message",
      lineNumber: 14,
      messageText: "I fixed the path and updated the parser to handle missing timestamps."
    }),
    makeRecord({
      kind: "assistant_message",
      lineNumber: 15,
      messageText: "Next step is wiring the reducer into the pipeline."
    }),
    makeRecord({
      kind: "assistant_message",
      lineNumber: 16,
      messageText: "We should maybe fix this later if tests fail."
    }),
    makeRecord({
      kind: "assistant_message",
      lineNumber: 17,
      messageText: "I can verify after lunch.",
      rawEvent: {
        type: "assistant",
        body: hugeText,
        nested: {
          giant: hugeText
        }
      }
    })
  ];

  const turns = groupRecordsIntoTurns({
    records,
    sessionId: "session-456"
  });
  const commandResult = extractCommandsByTurn(turns);
  const prunedPayload = pruneTranscriptPayload(
    makeRecord({
      kind: "assistant_message",
      lineNumber: 18,
      messageText: hugeText,
      rawEvent: {
        type: "assistant",
        body: hugeText,
        nested: {
          giant: hugeText
        }
      }
    })
  );
  const taggedEvents = tagTurnEvents(turns);

  assert.deepEqual(commandResult.allCommands, ["npm test"]);
  assert.deepEqual(commandResult.byTurn["session-456:turn-0000"], ["npm test"]);

  assert.equal("body" in prunedPayload, false);
  assert.equal("nested" in prunedPayload, false);
  assert.equal(prunedPayload.message_excerpt.endsWith("..."), true);
  assert.deepEqual(prunedPayload.raw_payload_stub, {
    approximate_bytes: JSON.stringify({
      type: "assistant",
      body: hugeText,
      nested: {
        giant: hugeText
      }
    }).length,
    has_nested_content: true,
    key_count: 3,
    kept_keys: ["body", "nested", "type"],
    omitted_key_count: 0
  });

  assert.deepEqual(
    taggedEvents.map((event) => ({
      line: event.source_offsets.start_line,
      summary: event.summary,
      type: event.type
    })),
    [
      {
        line: 11,
        summary: "I decided to keep the reducer local for now.",
        type: "decision"
      },
      {
        line: 12,
        summary: "Ran verification command: npm test",
        type: "verification"
      },
      {
        line: 13,
        summary: "npm test failed with ENOENT while loading the fixture.",
        type: "failure"
      },
      {
        line: 14,
        summary: "I fixed the path and updated the parser to handle missing timestamps.",
        type: "fix"
      },
      {
        line: 15,
        summary: "Next step is wiring the reducer into the pipeline.",
        type: "next_step"
      }
    ]
  );
});

test("does not promote user prompts or wrapper blobs into failures or next steps", () => {
  const records = [
    makeRecord({
      kind: "user_message",
      lineNumber: 30,
      messageText: "Fix the following issues. Verify each finding against the current code and only fix it if needed."
    }),
    makeRecord({
      kind: "assistant_message",
      lineNumber: 31,
      messageText: "<attached_files>\n<code_selection path=\"/tmp/plan.md\">1| remaining follow-up items</code_selection>\n</attached_files>"
    }),
    makeRecord({
      kind: "assistant_message",
      lineNumber: 32,
      messageText: "Next step is wiring the reducer into the pipeline."
    }),
    makeRecord({
      kind: "assistant_message",
      lineNumber: 33,
      messageText: "The command failed with ENOENT while loading the fixture."
    })
  ];

  const turns = groupRecordsIntoTurns({
    records,
    sessionId: "session-789"
  });
  const taggedEvents = tagTurnEvents(turns);

  assert.deepEqual(
    taggedEvents.map((event) => ({
      line: event.source_offsets.start_line,
      summary: event.summary,
      type: event.type
    })),
    [
      {
        line: 32,
        summary: "Next step is wiring the reducer into the pipeline.",
        type: "next_step"
      },
      {
        line: 33,
        summary: "The command failed with ENOENT while loading the fixture.",
        type: "failure"
      }
    ]
  );
});
