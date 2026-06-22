import assert from "node:assert/strict";
import test from "node:test";

import { eventSchema, sourceSessionFixture, turnSchema } from "../dist/models/canonical.js";
import { extractLearnings } from "../dist/pipeline/extract.js";

// Deterministic proof harness for the rejected quality tasks:
//   td-a0038f  cap project learnings per session at 12 (priority survival)
//   td-6600c2  reject multi-sentence non-verified candidates + 240-char ceiling
//   td-aceb5a  shared isAtomicStatement heuristic governs the gate
// These assert the extraction-time behaviour the live audit cannot show until
// historical learnings are reprocessed.

function sourceSession(overrides = {}) {
  return {
    ...sourceSessionFixture,
    project_key: "studio-tools",
    session_id: "cap-atomicity-session",
    source_hash: "sha256:cap-atomicity",
    ...overrides,
  };
}

function turn(index, overrides = {}) {
  const sessionId = overrides.session_id ?? "cap-atomicity-session";
  return turnSchema.parse({
    assistant_summary: "No assistant summary captured.",
    commands_seen: [],
    ended_at: "2026-05-16T12:05:00Z",
    files_touched: [],
    index,
    session_id: sessionId,
    started_at: "2026-05-16T12:00:00Z",
    tool_stub_count: 0,
    turn_id: `${sessionId}:turn-${String(index).padStart(4, "0")}`,
    user_prompt: "Implement the project change.",
    verification_seen: false,
    ...overrides,
  });
}

function decisionEvent(turnId, seq, summary) {
  return eventSchema.parse({
    confidence: "medium",
    event_id: `${turnId}:decision:${String(seq).padStart(6, "0")}`,
    payload_small: { matched_rule: "decision" },
    source_offsets: { end_line: 3 + seq, start_line: 3 + seq },
    summary,
    turn_id: turnId,
    type: "decision",
  });
}

test("td-a0038f: project learnings are capped at 12 by default", () => {
  const source = sourceSession();
  const turns = [];
  const events = [];
  // 18 distinct, atomic, durable decision candidates across 18 turns.
  for (let i = 0; i < 18; i += 1) {
    const t = turn(i);
    turns.push(t);
    events.push(
      decisionEvent(
        t.turn_id,
        i,
        `Keep module-${i} synchronous because callers require a single Result error channel.`,
      ),
    );
  }

  const learnings = extractLearnings({ events, sourceSession: source, turns });

  assert.ok(
    learnings.project.length <= 12,
    `expected <= 12 project learnings, got ${learnings.project.length}`,
  );
  assert.equal(learnings.project.length, 12);
});

test("td-a0038f: an explicit higher cap is honoured", () => {
  const source = sourceSession({ session_id: "cap-override-session" });
  const turns = [];
  const events = [];
  for (let i = 0; i < 18; i += 1) {
    const t = turn(i, { session_id: "cap-override-session" });
    turns.push(t);
    events.push(
      decisionEvent(
        t.turn_id,
        i,
        `Keep module-${i} synchronous because callers require a single Result error channel.`,
      ),
    );
  }

  const previous = process.env.ASD_MAX_PROJECT_LEARNINGS;
  process.env.ASD_MAX_PROJECT_LEARNINGS = "20";
  try {
    const learnings = extractLearnings({ events, sourceSession: source, turns });
    assert.equal(learnings.project.length, 18);
  } finally {
    if (previous === undefined) {
      delete process.env.ASD_MAX_PROJECT_LEARNINGS;
    } else {
      process.env.ASD_MAX_PROJECT_LEARNINGS = previous;
    }
  }
});

test("td-6600c2/td-aceb5a: multi-sentence non-verified candidate is dropped, atomic kept", () => {
  const source = sourceSession({ session_id: "atomicity-session" });
  const firstTurn = turn(0, { session_id: "atomicity-session" });
  const events = [
    decisionEvent(
      firstTurn.turn_id,
      1,
      "Refactored the loader. Then I cleaned up the imports. Finally I reran the suite.",
    ),
    decisionEvent(
      firstTurn.turn_id,
      2,
      "Keep the retry budget bounded because unbounded retries mask upstream failures.",
    ),
  ];

  const learnings = extractLearnings({ events, sourceSession: source, turns: [firstTurn] });

  assert.equal(learnings.project.length, 1);
  assert.equal(learnings.project[0].kind, "decision");
  assert.match(learnings.project[0].statement, /retry budget bounded/);
});

test("td-6600c2: kept statements respect the 240-char ceiling", () => {
  const source = sourceSession({ session_id: "ceiling-session" });
  const firstTurn = turn(0, { session_id: "ceiling-session" });
  const longReason = "x".repeat(400);
  const events = [decisionEvent(firstTurn.turn_id, 1, `Keep the cache warm because ${longReason}`)];

  const learnings = extractLearnings({ events, sourceSession: source, turns: [firstTurn] });

  for (const learning of learnings.project) {
    assert.ok(
      learning.statement.length <= 240,
      `statement exceeded 240 chars: ${learning.statement.length}`,
    );
  }
});
