import assert from "node:assert/strict";
import test from "node:test";

import { eventSchema, sourceSessionFixture, turnSchema } from "../dist/models/canonical.js";
import { extractLearnings } from "../dist/pipeline/extract.js";

test("verified completion events produce conservative project learnings", () => {
  const sourceSession = {
    ...sourceSessionFixture,
    project_key: "service-tools",
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

test("does not harvest embedded foreign-agent prompt directives as user learnings", () => {
  const sourceSession = {
    ...sourceSessionFixture,
    project_key: "open-design",
    session_id: "extract-embedded-agent",
  };
  const embeddedPrompt = [
    "# Instructions (read first)",
    "",
    "# OD core directives (read first — these override anything later in this prompt)",
    "",
    "You are an expert designer working with the user as your manager.",
    "Your role is to produce polished design artifacts in HTML.",
    "Never guess colors from memory.",
    "Always prefer the active design system's palette.",
    "No filler. Never pad with placeholder text.",
  ].join("\n");
  const turn = turnSchema.parse({
    assistant_summary: "Generated design concepts.",
    commands_seen: [],
    ended_at: "2026-05-16T12:05:00Z",
    files_touched: [],
    index: 0,
    session_id: sourceSession.session_id,
    started_at: "2026-05-16T12:00:00Z",
    tool_stub_count: 0,
    turn_id: `${sourceSession.session_id}:turn-0000`,
    user_prompt: embeddedPrompt,
    verification_seen: false,
  });

  const learnings = extractLearnings({
    events: [],
    sourceSession,
    turns: [turn],
  });

  assert.deepEqual(learnings.user, []);
});

test("learning statements never begin with an elision marker from a centered excerpt", () => {
  const sourceSession = {
    ...sourceSessionFixture,
    project_key: "demo",
    session_id: "extract-elision",
  };
  const turn = turnSchema.parse({
    assistant_summary: "Investigated and fixed the constraint error.",
    commands_seen: [],
    ended_at: "2026-05-16T12:05:00Z",
    files_touched: ["src/db/ledger.ts"],
    index: 0,
    session_id: sourceSession.session_id,
    started_at: "2026-05-16T12:00:00Z",
    tool_stub_count: 0,
    turn_id: `${sourceSession.session_id}:turn-0000`,
    user_prompt: "Fix the backfill constraint error.",
    verification_seen: true,
  });
  const fixEvent = eventSchema.parse({
    confidence: "high",
    event_id: "extract-elision:fix:1",
    payload_small: { matched_rule: "fixed" },
    source_offsets: { end_line: 9, start_line: 9 },
    summary:
      "...then fixed the unique-constraint error by keying the upsert on session_id and source_hash.",
    turn_id: turn.turn_id,
    type: "fix",
  });
  const verificationEvent = eventSchema.parse({
    confidence: "high",
    event_id: "extract-elision:verification:1",
    payload_small: { matched_rule: "verified", verification_command: "npm test" },
    source_offsets: { end_line: 12, start_line: 12 },
    summary: "Verification noted: tests pass after the upsert fix.",
    turn_id: turn.turn_id,
    type: "verification",
  });

  const learnings = extractLearnings({
    events: [fixEvent, verificationEvent],
    sourceSession,
    turns: [turn],
  });

  assert.ok(learnings.project.length > 0);
  for (const learning of learnings.project) {
    assert.ok(
      !learning.statement.startsWith("...") && !learning.title.startsWith("..."),
      `statement must not begin with an elision marker: ${learning.statement}`,
    );
  }
});

test("user learnings keep genuine instructions but skip doc fragments in mixed prompts", () => {
  const sourceSession = {
    ...sourceSessionFixture,
    project_key: "demo",
    session_id: "extract-mixed-prompt",
  };
  const turn = turnSchema.parse({
    assistant_summary: "Fixed the retention bug.",
    commands_seen: [],
    ended_at: "2026-05-16T12:05:00Z",
    files_touched: [],
    index: 0,
    session_id: sourceSession.session_id,
    started_at: "2026-05-16T12:00:00Z",
    tool_stub_count: 0,
    turn_id: `${sourceSession.session_id}:turn-0000`,
    user_prompt: [
      "Fix the retention bug.",
      "Never bypass the lifecycle checks when you do.",
      "## Red flags — never",
      "requirements — never your chat transcript.",
    ].join("\n"),
    verification_seen: false,
  });

  const learnings = extractLearnings({ events: [], sourceSession, turns: [turn] });

  assert.deepEqual(
    learnings.user.map((learning) => learning.statement),
    ["Never bypass the lifecycle checks when you do."],
  );
});

test("user learnings ignore prompts that are predominantly pasted markdown docs", () => {
  const sourceSession = {
    ...sourceSessionFixture,
    project_key: "demo",
    session_id: "extract-doc-dump",
  };
  const turn = turnSchema.parse({
    assistant_summary: "Reviewed the design doc.",
    commands_seen: [],
    ended_at: "2026-05-16T12:05:00Z",
    files_touched: [],
    index: 0,
    session_id: sourceSession.session_id,
    started_at: "2026-05-16T12:00:00Z",
    tool_stub_count: 0,
    turn_id: `${sourceSession.session_id}:turn-0000`,
    user_prompt: [
      "# Retention Design",
      "",
      "## Guarantees — always",
      "The pipeline always retries failed sessions.",
      "Operators should never see partial receipts.",
      "- safe_to_delete — always",
    ].join("\n"),
    verification_seen: false,
  });

  const learnings = extractLearnings({ events: [], sourceSession, turns: [turn] });

  assert.deepEqual(learnings.user, []);
});
