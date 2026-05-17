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
  assert.deepEqual(summary.what_worked, [
    "Verification noted: Tests passed after switching to happy-dom."
  ]);
});
