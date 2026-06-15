import assert from "node:assert/strict";
import test from "node:test";

import { eventSchema, sourceSessionFixture, turnSchema } from "../dist/models/canonical.js";
import { extractLearnings } from "../dist/pipeline/extract.js";

function makeTurnAndEvent(options) {
  const sourceSession = {
    ...sourceSessionFixture,
    project_key: options.projectKey ?? "demo",
    session_id: options.sessionId ?? "extract-process-chatter",
  };
  const turn = turnSchema.parse({
    assistant_summary: options.assistantSummary ?? "Worked on the task.",
    commands_seen: options.commandsSeen ?? [],
    ended_at: "2026-05-16T12:05:00Z",
    files_touched: options.filesTouched ?? [],
    index: 0,
    session_id: sourceSession.session_id,
    started_at: "2026-05-16T12:00:00Z",
    tool_stub_count: 0,
    turn_id: `${sourceSession.session_id}:turn-0000`,
    user_prompt: options.userPrompt ?? "Fix the bug.",
    verification_seen: options.verificationSeen ?? false,
  });
  const event = eventSchema.parse({
    confidence: options.confidence ?? "medium",
    event_id: `${sourceSession.session_id}:event:1`,
    payload_small: options.payloadSmall ?? {},
    source_offsets: { end_line: 10, start_line: 10 },
    summary: options.summary,
    turn_id: turn.turn_id,
    type: options.type,
  });
  return { event, sourceSession, turn };
}

test("verified completion events produce conservative project learnings", () => {
  const sourceSession = {
    ...sourceSessionFixture,
    project_key: "studio-tools",
    session_id: "extract-complete",
  };
  const turn = turnSchema.parse({
    assistant_summary: "Implemented and verified the PR fixes.",
    commands_seen: [],
    ended_at: "2026-05-16T12:05:00Z",
    files_touched: ["shared/db_sqlite.py"],
    index: 0,
    session_id: sourceSession.session_id,
    started_at: "2026-05-16T12:00:00Z",
    tool_stub_count: 0,
    turn_id: `${sourceSession.session_id}:turn-0000`,
    user_prompt: "Implement PR #71 review fixes.",
    verification_seen: true,
  });
  const event = eventSchema.parse({
    confidence: "medium",
    event_id: "extract-complete:verification:1",
    payload_small: {
      command_strings: ["./scripts/qa", "shared/db_sqlite.py"],
      matched_rule: "verified",
    },
    source_offsets: {
      end_line: 18,
      start_line: 18,
    },
    summary:
      "Verification noted: **Done:** All 7 blocking/strongly-recommended fixes from PR #71 review implemented and verified. **Verified:** `./scripts/qa` - 1247 passed, 2 skipped, 0 failures.",
    turn_id: turn.turn_id,
    type: "verification",
  });

  const learnings = extractLearnings({
    events: [event],
    sourceSession,
    turns: [turn],
  });

  assert.equal(learnings.project.length, 1);
  assert.equal(learnings.project[0].kind, "workflow");
  assert.equal(
    learnings.project[0].statement,
    "Completed all 7 blocking/strongly-recommended fixes from PR #71 review implemented and verified; verified with `./scripts/qa`.",
  );
  assert.equal(learnings.project[0].confidence, "medium");
  assert.deepEqual(learnings.user, []);
});

test("learning evidence excludes AGENTS harness text from raw user prompt", () => {
  const sourceSession = {
    ...sourceSessionFixture,
    project_key: "demo",
    session_id: "extract-evidence",
  };
  const harness =
    "# AGENTS.md instructions for /Users/example/Code/demo\n\n<INSTRUCTIONS>\nFollow project standards.\n</INSTRUCTIONS>";
  const task = "Run ./.codex/prompts/review-pr.md on PR #42 before merge.";
  const turn = turnSchema.parse({
    assistant_summary: "Ran review prompt.",
    commands_seen: ["./.codex/prompts/review-pr.md"],
    ended_at: "2026-05-16T12:05:00Z",
    files_touched: [],
    index: 0,
    session_id: sourceSession.session_id,
    started_at: "2026-05-16T12:00:00Z",
    tool_stub_count: 0,
    turn_id: `${sourceSession.session_id}:turn-0000`,
    user_prompt: `${harness}\n\n${task}`,
    verification_seen: true,
  });
  const event = eventSchema.parse({
    confidence: "medium",
    event_id: "extract-evidence:verification:1",
    payload_small: {
      command_strings: ["./.codex/prompts/review-pr.md"],
      matched_rule: "verified",
    },
    source_offsets: {
      end_line: 10,
      start_line: 10,
    },
    summary: "Verification noted: review prompt completed for PR #42.",
    turn_id: turn.turn_id,
    type: "verification",
  });

  const learnings = extractLearnings({
    events: [event],
    sourceSession,
    turns: [turn],
  });

  assert.ok(learnings.project.length >= 1);
  const evidence = learnings.project.flatMap((learning) => learning.evidence).join("\n");
  assert.match(evidence, /review-pr\.md/);
  assert.doesNotMatch(evidence, /AGENTS\.md instructions/i);
});


test("process-chatter decision events produce no project learning", () => {
  const { event, sourceSession, turn } = makeTurnAndEvent({
    summary:
      "This is converging beautifully: the retry logic is now scoped to the worker queue.",
    type: "decision",
  });

  const learnings = extractLearnings({
    events: [event],
    sourceSession,
    turns: [turn],
  });

  assert.equal(learnings.project.length, 0);
});

test("genuine fix/decision events still produce project learnings", () => {
  const { event, sourceSession, turn } = makeTurnAndEvent({
    summary: "Decision: scope vault writes to asd-learnings/ only.",
    type: "decision",
  });

  const learnings = extractLearnings({
    events: [event],
    sourceSession,
    turns: [turn],
  });

  assert.equal(learnings.project.length, 1);
  assert.equal(learnings.project[0].kind, "decision");
  assert.match(learnings.project[0].statement, /scope vault writes/);
});


test("multi-sentence decision candidates are rejected", () => {
  const { event, sourceSession, turn } = makeTurnAndEvent({
    summary:
      "Decision: scope vault writes to asd-learnings/. This keeps project-owned pages separate from vault memory.",
    type: "decision",
  });

  const learnings = extractLearnings({
    events: [event],
    sourceSession,
    turns: [turn],
  });

  assert.equal(learnings.project.length, 0);
});

test("verified-fix candidates with semicolon survive atomicity check", () => {
  const sourceSession = {
    ...sourceSessionFixture,
    project_key: "demo",
    session_id: "extract-verified-fix",
  };
  const turn = turnSchema.parse({
    assistant_summary: "Fixed the reducer race.",
    commands_seen: ["npm test"],
    ended_at: "2026-05-16T12:05:00Z",
    files_touched: ["src/reducer.ts"],
    index: 0,
    session_id: sourceSession.session_id,
    started_at: "2026-05-16T12:00:00Z",
    tool_stub_count: 0,
    turn_id: `${sourceSession.session_id}:turn-0000`,
    user_prompt: "Fix the reducer race in src/reducer.ts.",
    verification_seen: true,
  });
  const fixEvent = eventSchema.parse({
    confidence: "high",
    event_id: `${sourceSession.session_id}:fix:1`,
    payload_small: {},
    source_offsets: { end_line: 10, start_line: 10 },
    summary: "Fixed the reducer race by locking the dispatch queue.",
    turn_id: turn.turn_id,
    type: "fix",
  });
  const verificationEvent = eventSchema.parse({
    confidence: "high",
    event_id: `${sourceSession.session_id}:verification:1`,
    payload_small: { verification_command: "npm test" },
    source_offsets: { end_line: 12, start_line: 12 },
    summary: "Verification noted: all tests pass.",
    turn_id: turn.turn_id,
    type: "verification",
  });

  const learnings = extractLearnings({
    events: [fixEvent, verificationEvent],
    sourceSession,
    turns: [turn],
  });

  const verifiedFix = learnings.project.find((learning) => learning.kind === "workflow");
  assert.ok(verifiedFix, "expected a verified-fix workflow learning");
  assert.match(verifiedFix.statement, /; verified/);
  assert.ok(verifiedFix.statement.length <= 240, "statement should respect 240-char ceiling");
});


test("project learnings are capped per session with highest-priority survivors", () => {
  const sourceSession = {
    ...sourceSessionFixture,
    project_key: "demo",
    session_id: "extract-cap",
  };
  const turn = turnSchema.parse({
    assistant_summary: "Many small decisions.",
    commands_seen: [],
    ended_at: "2026-05-16T12:05:00Z",
    files_touched: [],
    index: 0,
    session_id: sourceSession.session_id,
    started_at: "2026-05-16T12:00:00Z",
    tool_stub_count: 0,
    turn_id: `${sourceSession.session_id}:turn-0000`,
    user_prompt: "Make many decisions.",
    verification_seen: false,
  });

  const events = [];
  for (let index = 0; index < 20; index += 1) {
    events.push(
      eventSchema.parse({
        confidence: "medium",
        event_id: `${sourceSession.session_id}:decision:${index}`,
        payload_small: {},
        source_offsets: { end_line: index + 1, start_line: index + 1 },
        summary: `Decision: use approach ${index} for the ${index % 2 === 0 ? "parser" : "renderer"}.`,
        turn_id: turn.turn_id,
        type: "decision",
      }),
    );
  }

  const learnings = extractLearnings({
    events,
    sourceSession,
    turns: [turn],
  });

  assert.equal(learnings.project.length, 12);
});

test("project learning cap of zero returns empty", () => {
  const sourceSession = {
    ...sourceSessionFixture,
    project_key: "demo",
    session_id: "extract-cap-zero",
  };
  const turn = turnSchema.parse({
    assistant_summary: "One decision.",
    commands_seen: [],
    ended_at: "2026-05-16T12:05:00Z",
    files_touched: [],
    index: 0,
    session_id: sourceSession.session_id,
    started_at: "2026-05-16T12:00:00Z",
    tool_stub_count: 0,
    turn_id: `${sourceSession.session_id}:turn-0000`,
    user_prompt: "Make a decision.",
    verification_seen: false,
  });
  const event = eventSchema.parse({
    confidence: "medium",
    event_id: `${sourceSession.session_id}:decision:1`,
    payload_small: {},
    source_offsets: { end_line: 1, start_line: 1 },
    summary: "Decision: scope vault writes to asd-learnings/.",
    turn_id: turn.turn_id,
    type: "decision",
  });

  process.env.ASD_MAX_PROJECT_LEARNINGS_PER_SESSION = "0";
  const learnings = extractLearnings({
    events: [event],
    sourceSession,
    turns: [turn],
  });
  delete process.env.ASD_MAX_PROJECT_LEARNINGS_PER_SESSION;

  assert.equal(learnings.project.length, 0);
});


test("multi-sentence file-scoped pattern candidates keep the first sentence", () => {
  const sourceSession = {
    ...sourceSessionFixture,
    project_key: "demo",
    session_id: "extract-pattern-atomicity",
  };
  const turn = turnSchema.parse({
    assistant_summary: "Fixed the import.",
    commands_seen: [],
    ended_at: "2026-05-16T12:05:00Z",
    files_touched: [],
    index: 0,
    session_id: sourceSession.session_id,
    started_at: "2026-05-16T12:00:00Z",
    tool_stub_count: 0,
    turn_id: `${sourceSession.session_id}:turn-0000`,
    user_prompt: "Fix the import error.",
    verification_seen: false,
  });
  const event = eventSchema.parse({
    confidence: "medium",
    event_id: `${sourceSession.session_id}:fix:1`,
    payload_small: {
      command_strings: ["shared/logging/__init__.py"],
    },
    source_offsets: { end_line: 3, start_line: 3 },
    summary:
      "Resolved by adding configure_logging to shared/logging/__init__.py. The worktree branch had it, but the main branch did not.",
    turn_id: turn.turn_id,
    type: "fix",
  });

  const learnings = extractLearnings({
    events: [event],
    sourceSession,
    turns: [turn],
  });

  const pattern = learnings.project.find((learning) => learning.kind === "pattern");
  assert.ok(pattern, "expected a file-scoped pattern learning");
  assert.match(pattern.statement, /resolved by adding configure_logging to shared\/logging\/__init__\.py\./);
  assert.doesNotMatch(pattern.statement, /worktree branch/);
});
