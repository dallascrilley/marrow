import test from "node:test";
import assert from "node:assert/strict";

import {
  eventSchema,
  sourceSessionFixture,
  turnSchema
} from "../dist/models/canonical.js";
import {
  isLowSignalTopic,
  summarizeSession,
  summarizeSessionWithOptionalLlmTopic
} from "../dist/pipeline/summarize.js";

test("summary synthesis skips prompt noise, prefers the latest next step, and filters weak commands", () => {
  const sourceSession = {
    ...sourceSessionFixture,
    project_key: "agent-session-distillery",
    session_id: "summary-quality"
  };
  const turns = [
    turnSchema.parse({
      assistant_summary: "Investigated Vitest speed and wrote the optimization plan.",
      commands_seen: ["python", "pnpm add -D happy-dom", "pnpm test:run"],
      ended_at: "2026-05-16T12:05:00Z",
      files_touched: ["desktop/vitest.config.ts"],
      index: 0,
      session_id: sourceSession.session_id,
      started_at: "2026-05-16T12:00:00Z",
      tool_stub_count: 0,
      turn_id: `${sourceSession.session_id}:turn-0000`,
      user_prompt: [
        "✓ src/App.test.tsx (3 tests) 162ms",
        "Test Files 17 passed (17)",
        "Duration 9.93s",
        "surely we can make these tests go faster"
      ].join("\n"),
      verification_seen: true
    })
  ];
  const events = [
    eventSchema.parse({
      confidence: "high",
      event_id: "summary-quality:verification:1",
      payload_small: {
        matched_rule: "verification_command"
      },
      source_offsets: {
        end_line: 10,
        start_line: 10
      },
      summary: "Verification noted: Tests passed after switching to happy-dom.",
      turn_id: turns[0].turn_id,
      type: "verification"
    }),
    eventSchema.parse({
      confidence: "medium",
      event_id: "summary-quality:next_step:1",
      payload_small: {
        matched_rule: "next_step"
      },
      source_offsets: {
        end_line: 11,
        start_line: 11
      },
      summary: "Next step is measuring rerun performance.",
      turn_id: turns[0].turn_id,
      type: "next_step"
    }),
    eventSchema.parse({
      confidence: "medium",
      event_id: "summary-quality:next_step:2",
      payload_small: {
        matched_rule: "next_step"
      },
      source_offsets: {
        end_line: 12,
        start_line: 12
      },
      summary: "Next step is documenting the final Vitest configuration.",
      turn_id: turns[0].turn_id,
      type: "next_step"
    })
  ];

  const summary = summarizeSession({
    events,
    sourceSession,
    turns
  });

  assert.equal(summary.topic, "surely we can make these tests go faster");
  assert.deepEqual(summary.useful_commands, ["pnpm add -D happy-dom", "pnpm test:run"]);
  assert.equal(summary.next_step, "Next step is documenting the final Vitest configuration.");
  assert.deepEqual(summary.what_worked, ["Verified: Tests passed after switching to happy-dom."]);
});

test("summary synthesis turns final completion evidence into operator-ready outcomes", () => {
  const sourceSession = {
    ...sourceSessionFixture,
    project_key: "studio-tools",
    session_id: "summary-complete"
  };
  const turns = [
    turnSchema.parse({
      assistant_summary: "Implemented and verified the PR fixes.",
      commands_seen: [],
      ended_at: "2026-05-16T12:05:00Z",
      files_touched: [
        "/Users/dallascrilley/.codex/worktrees/83a1/studio-tools",
        "/Users/dallascrilley/Code/studio-tools"
      ],
      index: 0,
      session_id: sourceSession.session_id,
      started_at: "2026-05-16T12:00:00Z",
      tool_stub_count: 0,
      turn_id: `${sourceSession.session_id}:turn-0000`,
      user_prompt: "PR #71 Review: feat(db): default to sqlite via psycopg-compatible shim",
      verification_seen: true
    })
  ];
  const events = [
    eventSchema.parse({
      confidence: "medium",
      event_id: "summary-complete:next_step:1",
      payload_small: {
        command_strings: [
          "./scripts/qa",
          "shared/db_sqlite.py",
          "SQLiteConnection.execute()",
          "SQLiteCursor"
        ],
        matched_rule: "follow-up"
      },
      source_offsets: {
        end_line: 18,
        start_line: 18
      },
      summary:
        "**Done:** All 7 blocking/strongly-recommended fixes from PR #71 review implemented and verified. **Verified:** `./scripts/qa` - 1247 passed, 2 skipped, 0 failures.",
      turn_id: turns[0].turn_id,
      type: "next_step"
    }),
    eventSchema.parse({
      confidence: "medium",
      event_id: "summary-complete:verification:1",
      payload_small: {
        command_strings: [
          "./scripts/qa",
          "shared/db_sqlite.py",
          "SQLiteConnection.execute()",
          "SQLiteCursor"
        ],
        matched_rule: "verified"
      },
      source_offsets: {
        end_line: 18,
        start_line: 18
      },
      summary:
        "Verification noted: **Done:** All 7 blocking/strongly-recommended fixes from PR #71 review implemented and verified. **Verified:** `./scripts/qa` - 1247 passed, 2 skipped, 0 failures.",
      turn_id: turns[0].turn_id,
      type: "verification"
    })
  ];

  const summary = summarizeSession({
    events,
    sourceSession,
    turns
  });

  assert.deepEqual(summary.what_worked, [
    "Completed all 7 blocking/strongly-recommended fixes from PR #71 review implemented and verified; verified with `./scripts/qa` (1247 passed, 2 skipped, 0 failures)."
  ]);
  assert.deepEqual(summary.useful_commands, ["./scripts/qa"]);
  assert.deepEqual(summary.files_of_interest, ["shared/db_sqlite.py"]);
  assert.equal(summary.next_step, "No open next step recorded.");
});

test("summary topic ignores AGENTS harness and uses substantive user task", () => {
  const sourceSession = {
    ...sourceSessionFixture,
    project_key: "demo",
    session_id: "agents-first-topic"
  };
  const turns = [
    turnSchema.parse({
      assistant_summary: "Acknowledged harness.",
      commands_seen: [],
      ended_at: "2026-05-03T23:10:03.000Z",
      files_touched: [],
      index: 0,
      session_id: sourceSession.session_id,
      started_at: "2026-05-03T23:10:02.000Z",
      tool_stub_count: 0,
      turn_id: `${sourceSession.session_id}:turn-0000`,
      user_prompt:
        "# AGENTS.md instructions for /Users/example/Code/demo\n\n<INSTRUCTIONS>\nFollow project standards.\n</INSTRUCTIONS>",
      verification_seen: false
    }),
    turnSchema.parse({
      assistant_summary: "Documented carve-out.",
      commands_seen: [],
      ended_at: "2026-05-03T23:10:05.000Z",
      files_touched: ["CLAUDE.md"],
      index: 1,
      session_id: sourceSession.session_id,
      started_at: "2026-05-03T23:10:04.000Z",
      tool_stub_count: 0,
      turn_id: `${sourceSession.session_id}:turn-0001`,
      user_prompt: "Add vault-push carve-out documentation to CLAUDE.md.",
      verification_seen: false
    })
  ];

  const summary = summarizeSession({
    events: [],
    sourceSession,
    turns
  });

  assert.match(summary.topic, /vault-push carve-out/i);
  assert.doesNotMatch(summary.topic, /AGENTS\.md/i);
});

test("summary topic skips Codex protocol-only preambles", () => {
  const sourceSession = {
    ...sourceSessionFixture,
    project_key: "demo",
    session_id: "codex-protocol-topic"
  };
  const noisePrompts = [
    "# CLAUDE.md instructions for /Users/example/Code/demo\n\n<INSTRUCTIONS>\nFollow project standards.\n</INSTRUCTIONS>",
    "<environment_context>\n  <cwd>/Users/example/Code/demo</cwd>\n</environment_context>",
    "<command-message>resume context</command-message>",
    "<turn_aborted>",
    "Caveat: this is a resumed conversation summary.",
    "[Request interrupted by user for tool use]",
    "[Image: screenshot.png]"
  ];
  const turns = [
    ...noisePrompts.map((userPrompt, index) =>
      turnSchema.parse({
        assistant_summary: "Ignored protocol-only prompt.",
        commands_seen: [],
        ended_at: `2026-05-03T23:10:${String(index + 1).padStart(2, "0")}.000Z`,
        files_touched: [],
        index,
        session_id: sourceSession.session_id,
        started_at: `2026-05-03T23:10:${String(index).padStart(2, "0")}.000Z`,
        tool_stub_count: 0,
        turn_id: `${sourceSession.session_id}:turn-${String(index).padStart(4, "0")}`,
        user_prompt: userPrompt,
        verification_seen: false
      })
    ),
    turnSchema.parse({
      assistant_summary: "Started the requested export work.",
      commands_seen: [],
      ended_at: "2026-05-03T23:10:20.000Z",
      files_touched: ["src/commands/export-index.ts"],
      index: noisePrompts.length,
      session_id: sourceSession.session_id,
      started_at: "2026-05-03T23:10:19.000Z",
      tool_stub_count: 0,
      turn_id: `${sourceSession.session_id}:turn-0007`,
      user_prompt: "Add a consolidated session index export command.",
      verification_seen: false
    })
  ];

  const summary = summarizeSession({
    events: [],
    sourceSession,
    turns
  });

  assert.equal(summary.topic, "Add a consolidated session index export command.");
});

test("low-signal topic heuristic is conservative but catches harness paths and commands", () => {
  assert.equal(isLowSignalTopic("Read .agents-state/handoff.md in this worktree"), true);
  assert.equal(isLowSignalTopic("Base directory for this skill is /tmp/demo"), true);
  assert.equal(isLowSignalTopic("/init"), true);
  assert.equal(isLowSignalTopic("npm run build"), true);
  assert.equal(isLowSignalTopic("/Users/example/Code/demo/AGENTS.md"), true);
  assert.equal(isLowSignalTopic("brainstorming"), true);
  assert.equal(isLowSignalTopic("whats-next"), true);
  assert.equal(isLowSignalTopic("# Writing Plans"), true);
  assert.equal(isLowSignalTopic("# PATH Doctor"), true);
  assert.equal(isLowSignalTopic("$brainstorming given the following pieces of"), true);
  assert.equal(isLowSignalTopic("Fix export-index contract topic provenance"), false);
  assert.equal(isLowSignalTopic("Automation: macOS stability scan"), false);
});

test("summarizeSession skips skill-wrapper-only prompts for topic selection", () => {
  const sourceSession = {
    ...sourceSessionFixture,
    project_key: "agent-session-distillery",
    session_id: "skill-wrapper-topic"
  };
  const turns = [
    turnSchema.parse({
      assistant_summary: "Explored options.",
      commands_seen: [],
      ended_at: "2026-05-22T20:10:00.000Z",
      files_touched: [],
      index: 0,
      session_id: sourceSession.session_id,
      started_at: "2026-05-22T20:09:00.000Z",
      tool_stub_count: 0,
      turn_id: `${sourceSession.session_id}:turn-0000`,
      user_prompt:
        '<skill name="brainstorming" location="/tmp/brainstorming/SKILL.md">Explore options.</skill>',
      verification_seen: false
    }),
    turnSchema.parse({
      assistant_summary: "Shipped export-index.",
      commands_seen: [],
      ended_at: "2026-05-22T20:11:00.000Z",
      files_touched: ["src/commands/export-index.ts"],
      index: 1,
      session_id: sourceSession.session_id,
      started_at: "2026-05-22T20:10:30.000Z",
      tool_stub_count: 0,
      turn_id: `${sourceSession.session_id}:turn-0001`,
      user_prompt: "Add export-index command for Tether session search.",
      verification_seen: false
    })
  ];

  const summary = summarizeSession({ events: [], sourceSession, turns });
  assert.equal(summary.topic, "Add export-index command for Tether session search.");
});

test("optional LLM topic stays off by default even for weak deterministic topics", async () => {
  const sourceSession = {
    ...sourceSessionFixture,
    project_key: "agent-session-distillery",
    session_id: "llm-topic-off"
  };
  const turns = [
    turnSchema.parse({
      assistant_summary: "Read the handoff.",
      commands_seen: [],
      ended_at: "2026-05-22T20:10:00.000Z",
      files_touched: [".agents-state/handoff.md"],
      index: 0,
      session_id: sourceSession.session_id,
      started_at: "2026-05-22T20:09:00.000Z",
      tool_stub_count: 0,
      turn_id: `${sourceSession.session_id}:turn-0000`,
      user_prompt: "Read .agents-state/handoff.md in this worktree - it is the authoritative spec.",
      verification_seen: false
    })
  ];
  let calls = 0;

  const summary = await summarizeSessionWithOptionalLlmTopic(
    { events: [], sourceSession, turns },
    {
      generateTopic: async () => {
        calls += 1;
        return "LLM topic should not be used";
      }
    }
  );

  assert.equal(calls, 0);
  assert.equal(summary.topic, "Read .agents-state/handoff.md in this worktree - it is the authoritative spec.");
  assert.equal(summary.topic_source, "deterministic");
});

test("optional LLM topic calls mocked generator only for weak deterministic topics", async () => {
  const sourceSession = {
    ...sourceSessionFixture,
    project_key: "agent-session-distillery",
    session_id: "llm-topic-on"
  };
  const turns = [
    turnSchema.parse({
      assistant_summary: "Implemented gated LLM topic generation.",
      commands_seen: ["npm run build"],
      ended_at: "2026-05-22T20:10:00.000Z",
      files_touched: ["src/pipeline/summarize.ts"],
      index: 0,
      session_id: sourceSession.session_id,
      started_at: "2026-05-22T20:09:00.000Z",
      tool_stub_count: 0,
      turn_id: `${sourceSession.session_id}:turn-0000`,
      user_prompt: "Read .agents-state/handoff.md in this worktree - it is the authoritative spec.",
      verification_seen: false
    })
  ];
  const calls = [];

  const summary = await summarizeSessionWithOptionalLlmTopic(
    { events: [], sourceSession, turns },
    {
      generateTopic: async (input) => {
        calls.push(input);
        return "gated LLM topic support";
      },
      llmTopic: true
    }
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].deterministicTopic, "Read .agents-state/handoff.md in this worktree - it is the authoritative spec.");
  assert.equal(summary.topic, "gated LLM topic support");
  assert.equal(summary.topic_source, "llm");
});

test("optional LLM topic falls back to the deterministic topic when generation fails", async () => {
  const sourceSession = {
    ...sourceSessionFixture,
    project_key: "agent-session-distillery",
    session_id: "llm-topic-fallback"
  };
  const turns = [
    turnSchema.parse({
      assistant_summary: "Implemented gated LLM topic generation.",
      commands_seen: ["npm run build"],
      ended_at: "2026-05-22T20:10:00.000Z",
      files_touched: ["src/pipeline/summarize.ts"],
      index: 0,
      session_id: sourceSession.session_id,
      started_at: "2026-05-22T20:09:00.000Z",
      tool_stub_count: 0,
      turn_id: `${sourceSession.session_id}:turn-0000`,
      user_prompt: "Read .agents-state/handoff.md in this worktree - it is the authoritative spec.",
      verification_seen: false
    })
  ];

  const summary = await summarizeSessionWithOptionalLlmTopic(
    { events: [], sourceSession, turns },
    {
      generateTopic: async () => {
        throw new Error("simulated OpenRouter failure");
      },
      llmTopic: true
    }
  );

  assert.equal(summary.topic, "Read .agents-state/handoff.md in this worktree - it is the authoritative spec.");
  assert.equal(summary.topic_source, "deterministic");
});
