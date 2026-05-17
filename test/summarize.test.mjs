import test from "node:test";
import assert from "node:assert/strict";

import {
  eventSchema,
  sourceSessionFixture,
  turnSchema
} from "../dist/models/canonical.js";
import { summarizeSession } from "../dist/pipeline/summarize.js";

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
