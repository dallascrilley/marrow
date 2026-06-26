import assert from "node:assert/strict";
import test from "node:test";

import { eventSchema, sourceSessionFixture, turnSchema } from "../dist/models/canonical.js";
import {
  isLowSignalTopic,
  summarizeSession,
  summarizeSessionWithOptionalLlmTopic,
} from "../dist/pipeline/summarize.js";

test("summary synthesis skips prompt noise, prefers the latest next step, and filters weak commands", () => {
  const sourceSession = {
    ...sourceSessionFixture,
    project_key: "agent-session-distillery",
    session_id: "summary-quality",
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
        "surely we can make these tests go faster",
      ].join("\n"),
      verification_seen: true,
    }),
  ];
  const events = [
    eventSchema.parse({
      confidence: "high",
      event_id: "summary-quality:verification:1",
      payload_small: {
        matched_rule: "verification_command",
      },
      source_offsets: {
        end_line: 10,
        start_line: 10,
      },
      summary: "Verification noted: Tests passed after switching to happy-dom.",
      turn_id: turns[0].turn_id,
      type: "verification",
    }),
    eventSchema.parse({
      confidence: "medium",
      event_id: "summary-quality:next_step:1",
      payload_small: {
        matched_rule: "next_step",
      },
      source_offsets: {
        end_line: 11,
        start_line: 11,
      },
      summary: "Next step is measuring rerun performance.",
      turn_id: turns[0].turn_id,
      type: "next_step",
    }),
    eventSchema.parse({
      confidence: "medium",
      event_id: "summary-quality:next_step:2",
      payload_small: {
        matched_rule: "next_step",
      },
      source_offsets: {
        end_line: 12,
        start_line: 12,
      },
      summary: "Next step is documenting the final Vitest configuration.",
      turn_id: turns[0].turn_id,
      type: "next_step",
    }),
  ];

  const summary = summarizeSession({
    events,
    sourceSession,
    turns,
  });

  assert.equal(summary.topic, "surely we can make these tests go faster");
  assert.deepEqual(summary.useful_commands, ["pnpm add -D happy-dom", "pnpm test:run"]);
  assert.equal(summary.next_step, "Next step is documenting the final Vitest configuration.");
  assert.deepEqual(summary.what_worked, ["Tests passed after switching to happy-dom."]);
});

test("summary synthesis drops process chatter while keeping durable outcomes", () => {
  const sourceSession = {
    ...sourceSessionFixture,
    project_key: "agent-session-distillery",
    session_id: "summary-process-chatter",
  };
  const turns = [
    turnSchema.parse({
      assistant_summary: "Updated Vitest config and verified the suite.",
      commands_seen: [],
      ended_at: "2026-05-16T12:05:00Z",
      files_touched: ["desktop/vitest.config.ts"],
      index: 0,
      session_id: sourceSession.session_id,
      started_at: "2026-05-16T12:00:00Z",
      tool_stub_count: 0,
      turn_id: `${sourceSession.session_id}:turn-0000`,
      user_prompt: "Speed up the Vitest suite",
      verification_seen: true,
    }),
  ];
  const events = [
    eventSchema.parse({
      confidence: "medium",
      event_id: "summary-process-chatter:fix:1",
      payload_small: { matched_rule: "fix" },
      source_offsets: { end_line: 10, start_line: 10 },
      summary:
        "Now regenerate the registry summary + projections from the corrected description, then check whether the provenance edit survived the update.",
      turn_id: turns[0].turn_id,
      type: "fix",
    }),
    eventSchema.parse({
      confidence: "medium",
      event_id: "summary-process-chatter:fix:2",
      payload_small: { matched_rule: "updated" },
      source_offsets: { end_line: 11, start_line: 11 },
      summary: "Updated Vitest config to use worker threads and happy-dom.",
      turn_id: turns[0].turn_id,
      type: "fix",
    }),
    eventSchema.parse({
      confidence: "high",
      event_id: "summary-process-chatter:verification:1",
      payload_small: { matched_rule: "tests pass" },
      source_offsets: { end_line: 12, start_line: 12 },
      summary: "Verification noted: Tests passed after switching to happy-dom.",
      turn_id: turns[0].turn_id,
      type: "verification",
    }),
  ];

  const summary = summarizeSession({
    events,
    sourceSession,
    turns,
  });

  assert.ok(
    summary.what_worked.includes("Updated Vitest config to use worker threads and happy-dom."),
  );
  assert.ok(summary.what_worked.includes("Tests passed after switching to happy-dom."));
  assert.ok(summary.what_worked.every((line) => !/^Now regenerate/i.test(line)));
});

test("summary synthesis turns final completion evidence into operator-ready outcomes", () => {
  const sourceSession = {
    ...sourceSessionFixture,
    project_key: "studio-tools",
    session_id: "summary-complete",
  };
  const turns = [
    turnSchema.parse({
      assistant_summary: "Implemented and verified the PR fixes.",
      commands_seen: [],
      ended_at: "2026-05-16T12:05:00Z",
      files_touched: [
        "/Users/dallascrilley/.codex/worktrees/83a1/studio-tools",
        "/Users/dallascrilley/Code/studio-tools",
      ],
      index: 0,
      session_id: sourceSession.session_id,
      started_at: "2026-05-16T12:00:00Z",
      tool_stub_count: 0,
      turn_id: `${sourceSession.session_id}:turn-0000`,
      user_prompt: "PR #71 Review: feat(db): default to sqlite via psycopg-compatible shim",
      verification_seen: true,
    }),
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
          "SQLiteCursor",
        ],
        matched_rule: "follow-up",
      },
      source_offsets: {
        end_line: 18,
        start_line: 18,
      },
      summary:
        "**Done:** All 7 blocking/strongly-recommended fixes from PR #71 review implemented and verified. **Verified:** `./scripts/qa` - 1247 passed, 2 skipped, 0 failures.",
      turn_id: turns[0].turn_id,
      type: "next_step",
    }),
    eventSchema.parse({
      confidence: "medium",
      event_id: "summary-complete:verification:1",
      payload_small: {
        command_strings: [
          "./scripts/qa",
          "shared/db_sqlite.py",
          "SQLiteConnection.execute()",
          "SQLiteCursor",
        ],
        matched_rule: "verified",
      },
      source_offsets: {
        end_line: 18,
        start_line: 18,
      },
      summary:
        "Verification noted: **Done:** All 7 blocking/strongly-recommended fixes from PR #71 review implemented and verified. **Verified:** `./scripts/qa` - 1247 passed, 2 skipped, 0 failures.",
      turn_id: turns[0].turn_id,
      type: "verification",
    }),
  ];

  const summary = summarizeSession({
    events,
    sourceSession,
    turns,
  });

  assert.deepEqual(summary.what_worked, [
    "Completed all 7 blocking/strongly-recommended fixes from PR #71 review implemented and verified; verified with `./scripts/qa` (1247 passed, 2 skipped, 0 failures).",
  ]);
  assert.deepEqual(summary.useful_commands, ["./scripts/qa"]);
  assert.deepEqual(summary.files_of_interest, ["shared/db_sqlite.py"]);
  assert.equal(summary.next_step, "No open next step recorded.");
});

test("summary synthesis normalizes absolute workspace paths and payload file arrays", () => {
  const sourceSession = {
    ...sourceSessionFixture,
    project_key: "demo",
    session_id: "summary-file-paths",
  };
  const turns = [
    turnSchema.parse({
      assistant_summary: "Reviewed ingest quality.",
      commands_seen: [],
      ended_at: "2026-06-16T12:05:00Z",
      files_touched: [
        "/Users/example/Code/demo/src/pipeline/summarize.ts",
        "/Users/example/Code/demo",
      ],
      index: 0,
      session_id: sourceSession.session_id,
      started_at: "2026-06-16T12:00:00Z",
      tool_stub_count: 0,
      turn_id: `${sourceSession.session_id}:turn-0000`,
      user_prompt: "Fix files of interest extraction.",
      verification_seen: false,
    }),
  ];
  const events = [
    eventSchema.parse({
      confidence: "medium",
      event_id: "summary-file-paths:decision:1",
      payload_small: {
        file_paths: [
          "/Users/example/Code/demo/src/pipeline/extract.ts",
          "src/pipeline/quality-audit.ts",
        ],
        matched_rule: "decision",
        paths: ["/Users/example/Code/demo"],
      },
      source_offsets: {
        end_line: 20,
        start_line: 20,
      },
      summary:
        "Keep the fix focused on /Users/example/Code/demo/src/pipeline/summarize.ts and src/pipeline/extract.ts before touching runtime docs.",
      turn_id: turns[0].turn_id,
      type: "decision",
    }),
  ];

  const summary = summarizeSession({ events, sourceSession, turns });

  assert.deepEqual(summary.files_of_interest, [
    "src/pipeline/summarize.ts",
    "src/pipeline/extract.ts",
    "src/pipeline/quality-audit.ts",
  ]);
});

test("summary topic ignores AGENTS harness and uses substantive user task", () => {
  const sourceSession = {
    ...sourceSessionFixture,
    project_key: "demo",
    session_id: "agents-first-topic",
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
      verification_seen: false,
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
      verification_seen: false,
    }),
  ];

  const summary = summarizeSession({
    events: [],
    sourceSession,
    turns,
  });

  assert.match(summary.topic, /vault-push carve-out/i);
  assert.doesNotMatch(summary.topic, /AGENTS\.md/i);
});

test("summary topic skips Codex protocol-only preambles", () => {
  const sourceSession = {
    ...sourceSessionFixture,
    project_key: "demo",
    session_id: "codex-protocol-topic",
  };
  const noisePrompts = [
    "# CLAUDE.md instructions for /Users/example/Code/demo\n\n<INSTRUCTIONS>\nFollow project standards.\n</INSTRUCTIONS>",
    "<environment_context>\n  <cwd>/Users/example/Code/demo</cwd>\n</environment_context>",
    "<command-message>resume context</command-message>",
    "<turn_aborted>",
    "Caveat: this is a resumed conversation summary.",
    "[Request interrupted by user for tool use]",
    "[Image: screenshot.png]",
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
        verification_seen: false,
      }),
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
      verification_seen: false,
    }),
  ];

  const summary = summarizeSession({
    events: [],
    sourceSession,
    turns,
  });

  assert.equal(summary.topic, "Add a consolidated session index export command.");
});

test("summary topic skips low-signal first lines and promotes later substantive prompt lines", () => {
  const sourceSession = {
    ...sourceSessionFixture,
    project_key: "demo",
    session_id: "low-signal-first-line-topic",
  };
  const turns = [
    turnSchema.parse({
      assistant_summary: "Started the requested fix.",
      commands_seen: [],
      ended_at: "2026-05-03T23:11:00.000Z",
      files_touched: ["src/pipeline/summarize.ts"],
      index: 0,
      session_id: sourceSession.session_id,
      started_at: "2026-05-03T23:10:59.000Z",
      tool_stub_count: 0,
      turn_id: `${sourceSession.session_id}:turn-0000`,
      user_prompt: [
        "{",
        "/commit",
        "/Users/example/Code/demo/.agents-state/handoff.md",
        "Improve deterministic topic derivation for summary regeneration.",
      ].join("\n"),
      verification_seen: false,
    }),
  ];

  const summary = summarizeSession({
    events: [],
    sourceSession,
    turns,
  });

  assert.equal(summary.topic, "Improve deterministic topic derivation for summary regeneration.");
});

test("summary topic skips wrapper markdown headings like User Input and promotes the real task", () => {
  const sourceSession = {
    ...sourceSessionFixture,
    project_key: "demo",
    session_id: "wrapper-heading-topic",
  };
  const turns = [
    turnSchema.parse({
      assistant_summary: "Started the requested review.",
      commands_seen: [],
      ended_at: "2026-05-03T23:11:00.000Z",
      files_touched: [],
      index: 0,
      session_id: sourceSession.session_id,
      started_at: "2026-05-03T23:10:59.000Z",
      tool_stub_count: 0,
      turn_id: `${sourceSession.session_id}:turn-0000`,
      user_prompt: [
        "## User Input",
        "/reviewer https://github.com/dallascrilley/cohost-ai-studio/pull/487",
      ].join("\n"),
      verification_seen: false,
    }),
  ];

  const summary = summarizeSession({
    events: [],
    sourceSession,
    turns,
  });

  assert.equal(
    summary.topic,
    "/reviewer https://github.com/dallascrilley/cohost-ai-studio/pull/487",
  );
});

test("summary topic falls back to assistant summary when prompt is a bare control command", () => {
  const sourceSession = {
    ...sourceSessionFixture,
    project_key: "demo",
    session_id: "assistant-fallback-topic",
  };
  const turns = [
    turnSchema.parse({
      assistant_summary:
        "Preparing the commit: checking git status and recent changes, then running the repo verification.",
      commands_seen: [],
      ended_at: "2026-05-03T23:11:00.000Z",
      files_touched: [],
      index: 0,
      session_id: sourceSession.session_id,
      started_at: "2026-05-03T23:10:59.000Z",
      tool_stub_count: 0,
      turn_id: `${sourceSession.session_id}:turn-0000`,
      user_prompt: "/commit",
      verification_seen: false,
    }),
  ];

  const summary = summarizeSession({
    events: [],
    sourceSession,
    turns,
  });

  assert.equal(
    summary.topic,
    "Preparing the commit: checking git status and recent changes, then running the repo verification.",
  );
});

test("summary topic prefers first meaningful assistant-summary sentence for bare skill command prompts", () => {
  const sourceSession = {
    ...sourceSessionFixture,
    project_key: "demo",
    session_id: "assistant-fallback-skill-topic",
  };
  const turns = [
    turnSchema.parse({
      assistant_summary:
        "Inspecting key diffs to group changes logically. Curating the full analysis and commit plan.",
      commands_seen: [],
      ended_at: "2026-05-03T23:12:00.000Z",
      files_touched: [],
      index: 0,
      session_id: sourceSession.session_id,
      started_at: "2026-05-03T23:11:59.000Z",
      tool_stub_count: 0,
      turn_id: `${sourceSession.session_id}:turn-0000`,
      user_prompt: "/git-atomic-commits",
      verification_seen: false,
    }),
  ];

  const summary = summarizeSession({
    events: [],
    sourceSession,
    turns,
  });

  assert.equal(summary.topic, "Inspecting key diffs to group changes logically.");
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
  assert.equal(isLowSignalTopic("## Catalog facets"), true);
  assert.equal(isLowSignalTopic("### Operating model"), true);
  assert.equal(isLowSignalTopic("## User Input"), true);
  assert.equal(isLowSignalTopic("$brainstorming given the following pieces of"), false);
  assert.equal(isLowSignalTopic("Fix export-index contract topic provenance"), false);
  assert.equal(isLowSignalTopic("Automation: macOS stability scan"), false);
});

test("low-signal topic heuristic catches wrapper/harness topic leaks", () => {
  // HTML comment leaked from a skill/command definition file.
  assert.equal(
    isLowSignalTopic("<!-- generated by `hub ship --runtime claude`; edits will be overwritten."),
    true,
  );
  // Stop-hook status injection.
  assert.equal(
    isLowSignalTopic('A session-scoped Stop hook is now active with condition: "Outcome: ..."'),
    true,
  );
  // Backtick-only config/workflow fragment.
  assert.equal(isLowSignalTopic("`medium effort → 3 angles × 6 candidates → 1-vote verify`"), true);
  // A descriptive instruction in backticks-free prose stays high-signal.
  assert.equal(
    isLowSignalTopic("Scan recent commits for likely bugs and propose minimal fixes."),
    false,
  );
});

test("low-signal topic heuristic catches operator control-loop and launcher prompts", () => {
  // Recurring chief-of-staff / agent-driver prompts that carry no session signal.
  assert.equal(
    isLowSignalTopic(
      "Heartbeat. Run one bounded operating loop now. This is a recurring control loop",
    ),
    true,
  );
  assert.equal(
    isLowSignalTopic(
      "Continue with the next best set of actions, using your best judgement to resolve",
    ),
    true,
  );
  assert.equal(isLowSignalTopic("Role: Lead Systems Architect & ~/.hub Specialist"), true);
  // Bare agent-CLI launch with flags is the harness starting an agent, not a topic.
  assert.equal(
    isLowSignalTopic("pi --no-extensions --no-skills --no-prompt-templates --no-themes"),
    true,
  );
  // False-positive guards: real topics that merely mention these words stay high-signal.
  assert.equal(isLowSignalTopic("claude code hooks not firing on SessionEnd"), false);
  assert.equal(isLowSignalTopic("Fix the heartbeat endpoint returning 500"), false);
  assert.equal(isLowSignalTopic("Role-based access control for the admin dashboard"), false);
});

test("low-signal topic heuristic rejects embedded foreign system prompts", () => {
  assert.equal(
    isLowSignalTopic("You are a memory extractor for a personal AI design assistant."),
    true,
  );
  assert.equal(
    isLowSignalTopic("Given the user's most recent message, decide what to remember."),
    true,
  );
  assert.equal(isLowSignalTopic("Your task is to classify the following diff."), true);
  assert.equal(
    isLowSignalTopic("You must respond only with valid JSON describing the entries."),
    true,
  );
  // Real interactive prompts that merely start with "you" must not be caught.
  assert.equal(isLowSignalTopic("You broke the build, can you fix the failing test?"), false);
  assert.equal(isLowSignalTopic("Add a memory extractor command to the CLI"), false);
});

test("summarizeSession skips skill-wrapper-only prompts for topic selection", () => {
  const sourceSession = {
    ...sourceSessionFixture,
    project_key: "agent-session-distillery",
    session_id: "skill-wrapper-topic",
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
      verification_seen: false,
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
      verification_seen: false,
    }),
  ];

  const summary = summarizeSession({ events: [], sourceSession, turns });
  assert.equal(summary.topic, "Add export-index command for Tether session search.");
});

test("optional LLM topic stays off by default even for weak deterministic topics", async () => {
  const sourceSession = {
    ...sourceSessionFixture,
    project_key: "agent-session-distillery",
    session_id: "llm-topic-off",
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
      verification_seen: false,
    }),
  ];
  let calls = 0;

  const summary = await summarizeSessionWithOptionalLlmTopic(
    { events: [], sourceSession, turns },
    {
      generateTopic: async () => {
        calls += 1;
        return "LLM topic should not be used";
      },
    },
  );

  assert.equal(calls, 0);
  assert.equal(
    summary.topic,
    "Read .agents-state/handoff.md in this worktree - it is the authoritative spec.",
  );
  assert.equal(summary.topic_source, "deterministic");
});

test("optional LLM topic calls mocked generator only for weak deterministic topics", async () => {
  const sourceSession = {
    ...sourceSessionFixture,
    project_key: "agent-session-distillery",
    session_id: "llm-topic-on",
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
      verification_seen: false,
    }),
  ];
  const calls = [];

  const summary = await summarizeSessionWithOptionalLlmTopic(
    { events: [], sourceSession, turns },
    {
      generateTopic: async (input) => {
        calls.push(input);
        return "gated LLM topic support";
      },
      llmTopic: true,
    },
  );

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].deterministicTopic,
    "Read .agents-state/handoff.md in this worktree - it is the authoritative spec.",
  );
  assert.equal(summary.topic, "gated LLM topic support");
  assert.equal(summary.topic_source, "llm");
});

test("optional LLM topic threads onUsage with session id to the generator", async () => {
  const sourceSession = {
    ...sourceSessionFixture,
    project_key: "agent-session-distillery",
    session_id: "llm-topic-usage",
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
      verification_seen: false,
    }),
  ];
  const usageEvents = [];

  await summarizeSessionWithOptionalLlmTopic(
    { events: [], sourceSession, turns },
    {
      generateTopic: async (input) => {
        input.onUsage?.({
          model: "openai/gpt-5.4-nano",
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15,
          reasoning_tokens: 1,
          cached_tokens: 0,
          cost: 0.0001,
          cost_source: "upstream",
          cost_is_known: true,
          missing_reason: null,
          duration_ms: 100,
          cache_hit: false,
        });
        return "usage-aware topic";
      },
      llmTopic: true,
      onUsage: (usage, sessionId) => {
        usageEvents.push({ usage, sessionId });
      },
    },
  );

  assert.equal(usageEvents.length, 1);
  assert.equal(usageEvents[0].sessionId, sourceSession.session_id);
  assert.equal(usageEvents[0].usage.cost, 0.0001);
});

test("optional LLM topic falls back to the deterministic topic when generation fails", async () => {
  const sourceSession = {
    ...sourceSessionFixture,
    project_key: "agent-session-distillery",
    session_id: "llm-topic-fallback",
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
      verification_seen: false,
    }),
  ];

  const summary = await summarizeSessionWithOptionalLlmTopic(
    { events: [], sourceSession, turns },
    {
      generateTopic: async () => {
        throw new Error("simulated OpenRouter failure");
      },
      llmTopic: true,
    },
  );

  assert.equal(
    summary.topic,
    "Read .agents-state/handoff.md in this worktree - it is the authoritative spec.",
  );
  assert.equal(summary.topic_source, "deterministic");
});

test("low-signal topic heuristic catches wrapper and context-dump topics", () => {
  assert.equal(
    isLowSignalTopic(
      "User initiated a review task. Here's the full review output for the changes.",
    ),
    true,
  );
  assert.equal(
    isLowSignalTopic("Review the code changes against the base branch 'origin/main'."),
    true,
  );
  assert.equal(
    isLowSignalTopic("see context: • I have the key evidence from the transcript and SKILL.md."),
    true,
  );
  assert.equal(isLowSignalTopic("resolve these:"), true);
  assert.equal(isLowSignalTopic("fix whatever is causinf tools to hng:"), true);
  assert.equal(isLowSignalTopic("/commit"), true);
  assert.equal(
    isLowSignalTopic("/reviewer https://github.com/dallascrilley/cohost-ai-studio/pull/487"),
    false,
  );
  assert.equal(
    isLowSignalTopic(
      "/td-task-management review open/unresolved td tasks/issues/epics and help me move them forward",
    ),
    false,
  );
  assert.equal(isLowSignalTopic("/audit-meta @campaigns/shows/dallas-mar-2026/ad-copy.md"), false);
  assert.equal(isLowSignalTopic('"globalShortcut": "Cmd+/",'), true);
  assert.equal(
    isLowSignalTopic('"resource": "/Users/dallascrilley/Code/cohost-ai-studio/justfile",'),
    true,
  );
  assert.equal(
    isLowSignalTopic(
      'line 47, in raise SystemExit(main)) ^n^ File "/Users/dallascrilley/Code/studio-tools/shared/query.py", line 28, in main',
    ),
    true,
  );
  assert.equal(isLowSignalTopic("Fix export-index contract topic provenance"), false);
  assert.equal(isLowSignalTopic("Automation: macOS stability scan"), false);
});

test("optional LLM topic is called for weak deterministic topics like resolve these", async () => {
  const sourceSession = {
    ...sourceSessionFixture,
    project_key: "agent-session-distillery",
    session_id: "llm-topic-resolve-these",
  };
  const turns = [
    turnSchema.parse({
      assistant_summary: "Triaged failures.",
      commands_seen: [],
      ended_at: "2026-05-22T20:10:00.000Z",
      files_touched: [],
      index: 0,
      session_id: sourceSession.session_id,
      started_at: "2026-05-22T20:09:00.000Z",
      tool_stub_count: 0,
      turn_id: `${sourceSession.session_id}:turn-0000`,
      user_prompt: "resolve these: auth latency regressions",
      verification_seen: false,
    }),
  ];
  let calls = 0;

  const summary = await summarizeSessionWithOptionalLlmTopic(
    { events: [], sourceSession, turns },
    {
      generateTopic: async () => {
        calls += 1;
        return "Resolve auth latency regressions";
      },
      llmTopic: true,
    },
  );

  assert.equal(calls, 1);
  assert.equal(summary.topic, "Resolve auth latency regressions");
  assert.equal(summary.topic_source, "llm");
});

test("optional LLM topic is not called for high-signal deterministic topics", async () => {
  const sourceSession = {
    ...sourceSessionFixture,
    project_key: "agent-session-distillery",
    session_id: "llm-topic-high-signal",
  };
  const turns = [
    turnSchema.parse({
      assistant_summary: "Fixed topic provenance.",
      commands_seen: ["npm run build"],
      ended_at: "2026-05-22T20:10:00.000Z",
      files_touched: ["src/commands/export-index.ts"],
      index: 0,
      session_id: sourceSession.session_id,
      started_at: "2026-05-22T20:09:00.000Z",
      tool_stub_count: 0,
      turn_id: `${sourceSession.session_id}:turn-0000`,
      user_prompt: "Fix export-index contract topic provenance",
      verification_seen: false,
    }),
  ];
  let calls = 0;

  const summary = await summarizeSessionWithOptionalLlmTopic(
    { events: [], sourceSession, turns },
    {
      generateTopic: async () => {
        calls += 1;
        return "LLM should not be used";
      },
      llmTopic: true,
    },
  );

  assert.equal(calls, 0);
  assert.equal(summary.topic, "Fix export-index contract topic provenance");
  assert.equal(summary.topic_source, "deterministic");
});

test("summary includes fallback workflow learning in what_worked when no fix events exist", () => {
  const sourceSession = {
    ...sourceSessionFixture,
    project_key: "studio-tools",
    session_id: "fallback-workflow-summary",
  };
  const turns = [
    turnSchema.parse({
      assistant_summary: "No assistant summary captured.",
      commands_seen: ["./.cursor/setup-worktree-unix.sh"],
      ended_at: "2026-05-22T20:10:00.000Z",
      files_touched: [],
      index: 0,
      session_id: sourceSession.session_id,
      started_at: "2026-05-22T20:09:00.000Z",
      tool_stub_count: 0,
      turn_id: `${sourceSession.session_id}:turn-0000`,
      user_prompt: "@.cursor/worktrees.json develop a worktree setup script for this project",
      verification_seen: false,
    }),
  ];

  const summary = summarizeSession({
    events: [],
    projectLearnings: [
      {
        confidence: "medium",
        evidence: ["@.cursor/worktrees.json develop a worktree setup script for this project"],
        kind: "workflow",
        learning_id: `${sourceSession.session_id}:project:turn-fallback:0`,
        promotion_basis: "Derived from project-specific command usage.",
        scope: "project",
        scope_key: "studio-tools",
        source_refs: [],
        statement: "Use `./.cursor/setup-worktree-unix.sh` for worktree setup in studio-tools.",
        title: "Workflow: Use `./.cursor/setup-worktree-unix.sh` for worktree setup...",
      },
    ],
    sourceSession,
    turns,
  });

  assert.deepEqual(summary.what_worked, [
    "Use `./.cursor/setup-worktree-unix.sh` for worktree setup in studio-tools.",
  ]);
});

test("deriveTopic skips an HTML-comment header to reach the real title line", () => {
  const sourceSession = {
    ...sourceSessionFixture,
    project_key: "agent-session-distillery",
    session_id: "html-comment-topic",
  };
  const turns = [
    turnSchema.parse({
      assistant_summary: "Executed the plan.",
      commands_seen: [],
      ended_at: "2026-05-03T23:10:01.000Z",
      files_touched: [],
      index: 0,
      session_id: sourceSession.session_id,
      started_at: "2026-05-03T23:10:00.000Z",
      tool_stub_count: 0,
      turn_id: `${sourceSession.session_id}:turn-0000`,
      user_prompt: [
        "<!-- generated by `hub ship --runtime claude`; edits will be overwritten. -->",
        "# ce-work — execute the plan, close the loop",
        "The compound-engineering execution step.",
      ].join("\n"),
      verification_seen: false,
    }),
  ];

  const summary = summarizeSession({
    events: [],
    sourceSession,
    turns,
  });

  assert.equal(summary.topic, "# ce-work — execute the plan, close the loop");
});

test("deriveTopic skips the '# Instructions (read first)' prompt-wrapper header", () => {
  const sourceSession = {
    ...sourceSessionFixture,
    project_key: "agent-session-distillery",
    session_id: "instructions-wrapper-topic",
  };
  const turns = [
    turnSchema.parse({
      assistant_summary: "Did the work.",
      commands_seen: [],
      ended_at: "2026-05-03T23:10:01.000Z",
      files_touched: [],
      index: 0,
      session_id: sourceSession.session_id,
      started_at: "2026-05-03T23:10:00.000Z",
      tool_stub_count: 0,
      turn_id: `${sourceSession.session_id}:turn-0000`,
      user_prompt: [
        "# Instructions (read first)",
        "Refactor the auth module to use the shared validator.",
      ].join("\n"),
      verification_seen: false,
    }),
  ];

  const summary = summarizeSession({
    events: [],
    sourceSession,
    turns,
  });

  assert.equal(summary.topic, "Refactor the auth module to use the shared validator.");
});

test("deriveTopic skips corpus-validated structural wrapper headers", () => {
  const cases = [
    { header: "# TASK", body: "Ship the dashboard audit panel." },
    { header: "## Context Usage", body: "Reduce eager payload size for dashboard." },
    { header: "# Handoff", body: "Continue ingestion quality fixes next session." },
  ];

  for (const { header, body } of cases) {
    const sourceSession = {
      ...sourceSessionFixture,
      project_key: "agent-session-distillery",
      session_id: `wrapper-${header.replace(/\W+/g, "-").toLowerCase()}`,
    };
    const turns = [
      turnSchema.parse({
        assistant_summary: "Did the work.",
        commands_seen: [],
        ended_at: "2026-05-03T23:10:01.000Z",
        files_touched: [],
        index: 0,
        session_id: sourceSession.session_id,
        started_at: "2026-05-03T23:10:00.000Z",
        tool_stub_count: 0,
        turn_id: `${sourceSession.session_id}:turn-0000`,
        user_prompt: [header, body].join("\n"),
        verification_seen: false,
      }),
    ];

    const summary = summarizeSession({
      events: [],
      sourceSession,
      turns,
    });

    assert.equal(summary.topic, body, `expected real task after ${header}`);
  }
});
