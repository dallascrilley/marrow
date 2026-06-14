import assert from "node:assert/strict";
import test from "node:test";

import { summarySchema, turnSchema } from "../dist/models/canonical.js";
import { isDiscardableNoSignal } from "../dist/pipeline/retention.js";

function lowSignalSummary(overrides = {}) {
  return summarySchema.parse({
    session_id: "sess-1",
    topic: "Hello",
    what_worked: [],
    what_failed: [],
    what_was_decided: [],
    useful_commands: [],
    files_of_interest: [],
    next_step: "No explicit next step recorded.",
    project_learnings: [],
    user_learnings: [],
    deletion_readiness: "not_ready",
    ...overrides,
  });
}

test("isDiscardableNoSignal is true for low-signal summary and no-signal prompt", () => {
  const summary = lowSignalSummary({ topic: "Hello" });
  const turns = [
    turnSchema.parse({
      assistant_summary: "Answered.",
      commands_seen: [],
      ended_at: "2026-05-16T12:05:00Z",
      files_touched: [],
      index: 0,
      session_id: "sess-1",
      started_at: "2026-05-16T12:00:00Z",
      tool_stub_count: 0,
      turn_id: "sess-1:turn-0000",
      user_prompt: "Hello",
      verification_seen: false,
    }),
  ];

  assert.equal(isDiscardableNoSignal(summary, turns), true);
});

test("isDiscardableNoSignal is false when summary has durable signal", () => {
  const summary = lowSignalSummary({
    topic: "Fix retention pipeline",
    what_worked: ["Verified tests pass."],
  });

  assert.equal(isDiscardableNoSignal(summary), false);
});

test("isDiscardableNoSignal is false for substantive multi-turn task", () => {
  const summary = lowSignalSummary({
    topic: "Implement memory quality fixes",
    next_step: "No explicit next step recorded.",
  });
  const turns = [
    turnSchema.parse({
      assistant_summary: "Read harness.",
      commands_seen: [],
      ended_at: "2026-05-16T12:02:00Z",
      files_touched: [],
      index: 0,
      session_id: "sess-1",
      started_at: "2026-05-16T12:00:00Z",
      tool_stub_count: 0,
      turn_id: "sess-1:turn-0000",
      user_prompt: "# AGENTS.md\n\nFollow project rules.",
      verification_seen: false,
    }),
    turnSchema.parse({
      assistant_summary: "Planned fixes.",
      commands_seen: [],
      ended_at: "2026-05-16T12:05:00Z",
      files_touched: ["src/pipeline/extract.ts"],
      index: 1,
      session_id: "sess-1",
      started_at: "2026-05-16T12:03:00Z",
      tool_stub_count: 0,
      turn_id: "sess-1:turn-0001",
      user_prompt: "Implement memory quality remediation for prompt sanitization.",
      verification_seen: false,
    }),
  ];

  assert.equal(isDiscardableNoSignal(summary, turns), false);
});

test("isDiscardableNoSignal is true for tiny multi-turn no-signal session", () => {
  const summary = lowSignalSummary({ topic: "Hello" });
  const turns = [
    turnSchema.parse({
      assistant_summary: "Hi.",
      commands_seen: [],
      ended_at: "2026-05-16T12:02:00Z",
      files_touched: [],
      index: 0,
      session_id: "sess-1",
      started_at: "2026-05-16T12:00:00Z",
      tool_stub_count: 0,
      turn_id: "sess-1:turn-0000",
      user_prompt: "Hello",
      verification_seen: false,
    }),
    turnSchema.parse({
      assistant_summary: "One.",
      commands_seen: [],
      ended_at: "2026-05-16T12:05:00Z",
      files_touched: [],
      index: 1,
      session_id: "sess-1",
      started_at: "2026-05-16T12:03:00Z",
      tool_stub_count: 0,
      turn_id: "sess-1:turn-0001",
      user_prompt: "Say one",
      verification_seen: false,
    }),
  ];

  assert.equal(isDiscardableNoSignal(summary, turns), true);
});
