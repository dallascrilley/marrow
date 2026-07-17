import assert from "node:assert/strict";
import test from "node:test";

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
      sourcePath: "/tmp/session.jsonl",
    },
    rawEvent: overrides.rawEvent ?? {
      type: overrides.rawType ?? kind,
      message: overrides.messageText ?? null,
      huge: {
        nested: Array.from({ length: 20 }, (_, index) => `item-${index}`),
      },
    },
    rawType: overrides.rawType ?? kind,
    timestampHint: overrides.timestampHint ?? null,
    toolUse: overrides.toolUse ?? null,
  };
}

test("groups raw records into user-led turns and carries pre-user context into the next turn", () => {
  const records = [
    makeRecord({
      kind: "assistant_message",
      lineNumber: 1,
      messageText: "Loading prior context before the user asks.",
    }),
    makeRecord({
      kind: "tool_result_stub",
      lineNumber: 2,
      filePaths: ["/Users/example/project/src/seed.ts"],
    }),
    makeRecord({
      kind: "user_message",
      lineNumber: 3,
      messageText: "Implement turn grouping.",
    }),
    makeRecord({
      kind: "assistant_message",
      lineNumber: 4,
      messageText: "I decided to keep the reducer local for now.",
      timestampHint: "2026-05-16T20:00:04.000Z",
    }),
    makeRecord({
      kind: "user_message",
      lineNumber: 5,
      messageText: null,
      contentRedacted: true,
    }),
    makeRecord({
      kind: "assistant_message",
      lineNumber: 6,
      messageText: "Next step is adding tests.",
      timestampHint: "2026-05-16T20:00:06.000Z",
    }),
  ];

  const turns = groupRecordsIntoTurns({
    records,
    sessionId: "session-123",
  });

  assert.equal(turns.length, 2);
  assert.deepEqual(
    turns.map((turn) => ({
      assistantMessages: turn.assistantMessages,
      endedAtHint: turn.endedAtHint,
      lines: [turn.sourceLineStart, turn.sourceLineEnd],
      startedAtHint: turn.startedAtHint,
      turnId: turn.turnId,
      userPrompt: turn.userPrompt,
    })),
    [
      {
        assistantMessages: [
          "Loading prior context before the user asks.",
          "I decided to keep the reducer local for now.",
        ],
        endedAtHint: "2026-05-16T20:00:04.000Z",
        lines: [1, 4],
        startedAtHint: "2026-05-16T20:00:04.000Z",
        turnId: "session-123:turn-0000",
        userPrompt: "Implement turn grouping.",
      },
      {
        assistantMessages: ["Next step is adding tests."],
        endedAtHint: "2026-05-16T20:00:06.000Z",
        lines: [5, 6],
        startedAtHint: "2026-05-16T20:00:06.000Z",
        turnId: "session-123:turn-0001",
        userPrompt: "[redacted user message]",
      },
    ],
  );
});

test("prunes bulky payloads, dedupes useful commands, and tags only explicit signals", () => {
  const hugeText = "x".repeat(500);
  const records = [
    makeRecord({
      kind: "user_message",
      lineNumber: 10,
      messageText: "Run npm test and then build.",
    }),
    makeRecord({
      kind: "assistant_message",
      lineNumber: 11,
      messageText: "I decided to keep the reducer local for now.",
    }),
    makeRecord({
      kind: "tool_use_stub",
      lineNumber: 12,
      commandStrings: ["npm test", "`npm test`", "plain english request"],
      toolUse: {
        callId: "tool-001",
        inputText: "npm test",
        name: "run_terminal_command",
        status: "started",
      },
      rawType: "tool_call",
    }),
    makeRecord({
      kind: "assistant_message",
      lineNumber: 13,
      messageText: "npm test failed with ENOENT while loading the fixture.",
    }),
    makeRecord({
      kind: "assistant_message",
      lineNumber: 14,
      messageText: "I fixed the path and updated the parser to handle missing timestamps.",
    }),
    makeRecord({
      kind: "assistant_message",
      lineNumber: 15,
      messageText: "Next step is wiring the reducer into the pipeline.",
    }),
    makeRecord({
      kind: "assistant_message",
      lineNumber: 16,
      messageText: "We should maybe fix this later if tests fail.",
    }),
    makeRecord({
      kind: "assistant_message",
      lineNumber: 17,
      messageText: "I can verify after lunch.",
      rawEvent: {
        type: "assistant",
        body: hugeText,
        nested: {
          giant: hugeText,
        },
      },
    }),
  ];

  const turns = groupRecordsIntoTurns({
    records,
    sessionId: "session-456",
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
          giant: hugeText,
        },
      },
    }),
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
        giant: hugeText,
      },
    }).length,
    has_nested_content: true,
    key_count: 3,
    kept_keys: ["body", "nested", "type"],
    omitted_key_count: 0,
  });

  assert.deepEqual(
    taggedEvents.map((event) => ({
      line: event.source_offsets.start_line,
      summary: event.summary,
      type: event.type,
    })),
    [
      {
        line: 11,
        summary: "I decided to keep the reducer local for now.",
        type: "decision",
      },
      {
        line: 12,
        summary: "Ran verification command: npm test",
        type: "verification",
      },
      {
        line: 13,
        summary: "npm test failed with ENOENT while loading the fixture.",
        type: "failure",
      },
      {
        line: 14,
        summary: "I fixed the path and updated the parser to handle missing timestamps.",
        type: "fix",
      },
      {
        line: 15,
        summary: "Next step is wiring the reducer into the pipeline.",
        type: "next_step",
      },
    ],
  );
});

test("does not promote user prompts or wrapper blobs into failures or next steps", () => {
  const records = [
    makeRecord({
      kind: "user_message",
      lineNumber: 30,
      messageText:
        "Fix the following issues. Verify each finding against the current code and only fix it if needed.",
    }),
    makeRecord({
      kind: "assistant_message",
      lineNumber: 31,
      messageText:
        '<attached_files>\n<code_selection path="/tmp/plan.md">1| remaining follow-up items</code_selection>\n</attached_files>',
    }),
    makeRecord({
      kind: "assistant_message",
      lineNumber: 32,
      messageText: "Next step is wiring the reducer into the pipeline.",
    }),
    makeRecord({
      kind: "assistant_message",
      lineNumber: 33,
      messageText: "The command failed with ENOENT while loading the fixture.",
    }),
  ];

  const turns = groupRecordsIntoTurns({
    records,
    sessionId: "session-789",
  });
  const taggedEvents = tagTurnEvents(turns);

  assert.deepEqual(
    taggedEvents.map((event) => ({
      line: event.source_offsets.start_line,
      summary: event.summary,
      type: event.type,
    })),
    [
      {
        line: 32,
        summary: "Next step is wiring the reducer into the pipeline.",
        type: "next_step",
      },
      {
        line: 33,
        summary: "The command failed with ENOENT while loading the fixture.",
        type: "failure",
      },
    ],
  );
});

test("does not classify completed verification summaries as next steps", () => {
  const records = [
    makeRecord({
      kind: "user_message",
      lineNumber: 50,
      messageText: "Implement the review fixes.",
    }),
    makeRecord({
      kind: "assistant_message",
      lineNumber: 51,
      messageText:
        "**Done:** All 7 blocking fixes implemented and verified. **Verified:** `./scripts/qa` - 1247 passed, 2 skipped, 0 failures. Follow-up items are complete.",
    }),
  ];
  const turns = groupRecordsIntoTurns({
    records,
    sessionId: "session-complete",
  });
  const commandResult = extractCommandsByTurn(turns);
  const taggedEvents = tagTurnEvents(turns);

  assert.deepEqual(commandResult.allCommands, ["./scripts/qa"]);
  assert.deepEqual(
    taggedEvents.map((event) => event.type),
    ["verification"],
  );
});

test("tags recommendation and evaluation language as decision events", () => {
  const records = [
    makeRecord({
      kind: "user_message",
      lineNumber: 1,
      messageText: "search for a pi extension manager extension",
    }),
    makeRecord({
      kind: "assistant_message",
      lineNumber: 2,
      messageText:
        "Here is a tight comparison from READMEs, package.json, stars, last push, and pi-search traffic. ### 1. `pi-extmgr` (ayagmar) — **best default** - **Why:** Most complete surface: unified TUI, staged enable/disable + save, per-package extension entrypoint config, remote install/browse, bulk update, auto-update wizard, history with filters, cache clear, non-interactive /extensions subset, explicit RPC / no-UI behavior.",
    }),
    makeRecord({
      kind: "user_message",
      lineNumber: 3,
      messageText: "review each. which looks the best",
    }),
    makeRecord({
      kind: "assistant_message",
      lineNumber: 4,
      messageText:
        "### Ranking 1. `pi-extmgr` (ayagmar) — winner. 2. `@vanillagreen/pi-extension-manager` — runner-up. I recommend pi-extmgr for new projects.",
    }),
  ];

  const turns = groupRecordsIntoTurns({
    records,
    sessionId: "session-eval",
  });
  const taggedEvents = tagTurnEvents(turns);
  const decisions = taggedEvents.filter((event) => event.type === "decision");

  assert.equal(decisions.length, 2);
  assert.ok(decisions[0].summary.includes("best default"));
  assert.ok(decisions[1].summary.includes("winner") || decisions[1].summary.includes("recommend"));
});

test("tags architecture and roadmap language as decision events", () => {
  const records = [
    makeRecord({
      kind: "user_message",
      lineNumber: 10,
      messageText: "what should the v2 and v3 of this pi harness look like?",
    }),
    makeRecord({
      kind: "assistant_message",
      lineNumber: 11,
      messageText:
        "Below is a delivery-shaped split: v2 epic tightens the current extension lane; v3 epic adds new wires and distance. v3 assumes v2 fundamentals so you do not debug transport and policy at the same time.",
    }),
    makeRecord({
      kind: "assistant_message",
      lineNumber: 12,
      messageText:
        "The approach is to keep Pi managed session + phone steer only for v2, then add opt-in steer memory and receipts MVP in v3.",
    }),
  ];

  const turns = groupRecordsIntoTurns({
    records,
    sessionId: "session-roadmap",
  });
  const taggedEvents = tagTurnEvents(turns);
  const decisions = taggedEvents.filter((event) => event.type === "decision");

  assert.equal(decisions.length, 2);
  assert.ok(decisions[0].summary.includes("v2 epic"));
  assert.ok(decisions[1].summary.includes("approach is"));
});

test("tags spec and design decisions as decision events", () => {
  const records = [
    makeRecord({
      kind: "user_message",
      lineNumber: 20,
      messageText: "/speckit-specify create a hub wrapper around the skills cli",
    }),
    makeRecord({
      kind: "assistant_message",
      lineNumber: 21,
      messageText:
        "Architecture decision: the hub wrapper uses a thin CLI adapter that delegates to the skills CLI internally. The spec for the wrapper is in hub-spec.md.",
    }),
  ];

  const turns = groupRecordsIntoTurns({
    records,
    sessionId: "session-spec",
  });
  const taggedEvents = tagTurnEvents(turns);
  const decisions = taggedEvents.filter((event) => event.type === "decision");

  assert.equal(decisions.length, 1);
  assert.ok(decisions[0].summary.includes("Architecture decision"));
});

test("tags comparison and verdict language as decision events", () => {
  const records = [
    makeRecord({
      kind: "user_message",
      lineNumber: 29,
      messageText: "Compare SQLite vs PostgreSQL for our local-first deployment.",
    }),
    makeRecord({
      kind: "assistant_message",
      lineNumber: 30,
      messageText:
        "Comparison: Option A uses SQLite, Option B uses PostgreSQL. Verdict: go with SQLite for local-first deployments.",
    }),
  ];

  const turns = groupRecordsIntoTurns({
    records,
    sessionId: "session-verdict",
  });
  const taggedEvents = tagTurnEvents(turns);
  const decisions = taggedEvents.filter((event) => event.type === "decision");

  assert.equal(decisions.length, 1);
  assert.ok(decisions[0].summary.includes("go with"));
});

test("does not promote embedded question-form wrapper markup into decisions", () => {
  const records = [
    makeRecord({
      kind: "assistant_message",
      lineNumber: 40,
      messageText:
        'Got it — a logo identity exploration for Throughline.\n\n<question-form id="discovery" title="Brief">\n{ "options": ["Recommended default"] }\n</question-form>',
    }),
  ];

  const turns = groupRecordsIntoTurns({
    records,
    sessionId: "session-question-form",
  });
  const taggedEvents = tagTurnEvents(turns);

  assert.deepEqual(taggedEvents, []);
});

test("extracts operator CLI commands beyond the original starter whitelist", () => {
  const records = [
    makeRecord({
      kind: "user_message",
      lineNumber: 1,
      messageText: "Check the PR, the queue, and the search index.",
    }),
    makeRecord({
      kind: "tool_use_stub",
      lineNumber: 2,
      commandStrings: [
        "gh pr checks 42",
        'td create "fix the thing" -p P2',
        "hubctl dispatch run lint",
        "qa --json",
        "rg pattern src/",
        "curl -s https://example.com",
        "kubectl get pods",
        "brew install jq",
        "wt switch --create fix",
        "op item get GitHub",
        "gog gmail search newer_than:1d",
        "jq . package.json",
        "ls test/fixtures",
        "cat README.md",
        "ssh deploy@example.com",
        "mise current node",
        "tar -tzf dist.tgz",
        "grep -r TODO src",
        "wget https://example.com/archive.tgz",
        "sed -n 1,5p README.md",
        "awk '{print $1}' report.txt",
      ],
      toolUse: {
        callId: "tool-cli",
        inputText: null,
        name: "run_terminal_command",
        status: "started",
      },
    }),
  ];

  const turns = groupRecordsIntoTurns({
    records,
    sessionId: "session-cli",
  });
  const commandResult = extractCommandsByTurn(turns);

  assert.deepEqual(commandResult.allCommands, [
    "gh pr checks 42",
    'td create "fix the thing" -p P2',
    "hubctl dispatch run lint",
    "qa --json",
    "rg pattern src/",
    "curl -s https://example.com",
    "kubectl get pods",
    "brew install jq",
    "wt switch --create fix",
    "op item get GitHub",
    "gog gmail search newer_than:1d",
    "jq . package.json",
    "ls test/fixtures",
    "cat README.md",
    "ssh deploy@example.com",
    "mise current node",
    "tar -tzf dist.tgz",
    "grep -r TODO src",
    "wget https://example.com/archive.tgz",
    "sed -n 1,5p README.md",
    "awk '{print $1}' report.txt",
  ]);
});

test("keeps only the first line of multi-line command inputs", () => {
  const records = [
    makeRecord({
      kind: "user_message",
      lineNumber: 1,
      messageText: "Run the checks.",
    }),
    makeRecord({
      kind: "tool_use_stub",
      lineNumber: 2,
      commandStrings: ["git status\ngit diff --stat\n\nnpm test"],
      toolUse: {
        callId: "tool-multiline",
        inputText: "npm test -- --filter=slow\nrm -rf /tmp/scratch",
        name: "run_terminal_command",
        status: "started",
      },
    }),
  ];

  const turns = groupRecordsIntoTurns({
    records,
    sessionId: "session-multiline",
  });
  const commandResult = extractCommandsByTurn(turns);

  assert.deepEqual(commandResult.allCommands, ["git status", "npm test -- --filter=slow"]);
});

test("tags just/script/qa task-runner invocations as verification commands", () => {
  const records = [
    makeRecord({
      kind: "user_message",
      lineNumber: 1,
      messageText: "Verify everything before merging.",
    }),
    makeRecord({
      kind: "tool_use_stub",
      lineNumber: 2,
      commandStrings: ["just test"],
      toolUse: {
        callId: "tool-just-test",
        inputText: "just test",
        name: "run_terminal_command",
        status: "started",
      },
    }),
    makeRecord({
      kind: "tool_use_stub",
      lineNumber: 3,
      commandStrings: ["script/cibuild"],
      toolUse: {
        callId: "tool-cibuild",
        inputText: "script/cibuild",
        name: "run_terminal_command",
        status: "started",
      },
    }),
    makeRecord({
      kind: "tool_use_stub",
      lineNumber: 4,
      commandStrings: ["qa --json"],
      toolUse: {
        callId: "tool-qa",
        inputText: "qa --json",
        name: "run_terminal_command",
        status: "started",
      },
    }),
    makeRecord({
      kind: "tool_use_stub",
      lineNumber: 5,
      commandStrings: ["just install"],
      toolUse: {
        callId: "tool-just-install",
        inputText: "just install",
        name: "run_terminal_command",
        status: "started",
      },
    }),
  ];

  const turns = groupRecordsIntoTurns({
    records,
    sessionId: "session-verify-runners",
  });
  const taggedEvents = tagTurnEvents(turns);
  const verificationCommands = taggedEvents
    .filter((event) => event.type === "verification")
    .map((event) => event.payload_small.verification_command);

  assert.deepEqual(verificationCommands, ["just test", "script/cibuild", "qa --json"]);
});

test("centers failure excerpts on the matched marker in long records", () => {
  const leadIn = "Checkpoint update: all migrations applied cleanly. ".repeat(10);
  const records = [
    makeRecord({
      kind: "user_message",
      lineNumber: 1,
      messageText: "Continue the migration.",
    }),
    makeRecord({
      kind: "assistant_message",
      lineNumber: 2,
      messageText: `${leadIn}Then the final backfill failed with a unique-constraint error on session_id.`,
    }),
  ];

  const turns = groupRecordsIntoTurns({
    records,
    sessionId: "session-long-failure",
  });
  const failures = tagTurnEvents(turns).filter((event) => event.type === "failure");

  assert.equal(failures.length, 1);
  assert.ok(failures[0].summary.includes("failed with a unique-constraint error"));
  assert.ok(failures[0].summary.length <= 240);
  assert.ok(
    failures[0].summary.startsWith("..."),
    "an excerpt cut away from the record head should signal elision",
  );
});

test("keeps the head excerpt for fix events on markdown-heavy change summaries", () => {
  const records = [
    makeRecord({
      kind: "user_message",
      lineNumber: 1,
      messageText: "Make the tests faster.",
    }),
    makeRecord({
      kind: "assistant_message",
      lineNumber: 2,
      messageText: [
        "Summary of changes:",
        "",
        "## Implemented",
        "",
        "**Vitest config** ([`desktop/vitest.config.ts`](desktop/vitest.config.ts))",
        "- `pool: 'threads'` – use worker threads instead of forks",
        "- `environment: 'happy-dom'` – lighter DOM env than jsdom",
        "",
        "**Fixes for test compatibility**",
        "1. **PreProductionView.tsx** – corrected empty-state expectations.",
        `2. **Other.test.tsx** – ${"padding ".repeat(60)}patched the snapshot.`,
      ].join("\n"),
    }),
  ];

  const turns = groupRecordsIntoTurns({
    records,
    sessionId: "session-markdown-fix",
  });
  const fixes = tagTurnEvents(turns).filter((event) => event.type === "fix");

  assert.equal(fixes.length, 1);
  assert.ok(fixes[0].summary.startsWith("Summary of changes:"));
  assert.ok(fixes[0].summary.includes("use worker threads instead of forks"));
});

test("excerpts the line containing the marker rather than the record head", () => {
  const records = [
    makeRecord({
      kind: "user_message",
      lineNumber: 1,
      messageText: "status?",
    }),
    makeRecord({
      kind: "assistant_message",
      lineNumber: 2,
      messageText: [
        "Progress so far:",
        "- parsed 120 sessions without issues",
        "- archived 118",
        "",
        `Backfill failed on session 119: ${"x".repeat(300)}`,
      ].join("\n"),
    }),
  ];

  const turns = groupRecordsIntoTurns({
    records,
    sessionId: "session-marker-line",
  });
  const failures = tagTurnEvents(turns).filter((event) => event.type === "failure");

  assert.equal(failures.length, 1);
  assert.ok(failures[0].summary.includes("Backfill failed on session 119"));
  assert.ok(!failures[0].summary.startsWith("Progress so far:"));
});
