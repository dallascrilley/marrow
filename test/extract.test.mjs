import test from "node:test";
import assert from "node:assert/strict";

import { eventSchema, sourceSessionFixture, turnSchema } from "../dist/models/canonical.js";
import { extractLearnings } from "../dist/pipeline/extract.js";

test("verified completion events produce conservative project learnings", () => {
  const sourceSession = {
    ...sourceSessionFixture,
    project_key: "studio-tools",
    session_id: "extract-complete"
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
    verification_seen: true
  });
  const event = eventSchema.parse({
    confidence: "medium",
    event_id: "extract-complete:verification:1",
    payload_small: {
      command_strings: ["./scripts/qa", "shared/db_sqlite.py"],
      matched_rule: "verified"
    },
    source_offsets: {
      end_line: 18,
      start_line: 18
    },
    summary:
      "Verification noted: **Done:** All 7 blocking/strongly-recommended fixes from PR #71 review implemented and verified. **Verified:** `./scripts/qa` - 1247 passed, 2 skipped, 0 failures.",
    turn_id: turn.turn_id,
    type: "verification"
  });

  const learnings = extractLearnings({
    events: [event],
    sourceSession,
    turns: [turn]
  });

  assert.equal(learnings.project.length, 1);
  assert.equal(learnings.project[0].kind, "workflow");
  assert.equal(
    learnings.project[0].statement,
    "Completed all 7 blocking/strongly-recommended fixes from PR #71 review implemented and verified; verified with `./scripts/qa`."
  );
  assert.equal(learnings.project[0].confidence, "medium");
  assert.deepEqual(learnings.user, []);
});

test("learning evidence excludes AGENTS harness text from raw user prompt", () => {
  const sourceSession = {
    ...sourceSessionFixture,
    project_key: "demo",
    session_id: "extract-evidence"
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
    verification_seen: true
  });
  const event = eventSchema.parse({
    confidence: "medium",
    event_id: "extract-evidence:verification:1",
    payload_small: {
      command_strings: ["./.codex/prompts/review-pr.md"],
      matched_rule: "verified"
    },
    source_offsets: {
      end_line: 10,
      start_line: 10
    },
    summary: "Verification noted: review prompt completed for PR #42.",
    turn_id: turn.turn_id,
    type: "verification"
  });

  const learnings = extractLearnings({
    events: [event],
    sourceSession,
    turns: [turn]
  });

  assert.ok(learnings.project.length >= 1);
  const evidence = learnings.project.flatMap((learning) => learning.evidence).join("\n");
  assert.match(evidence, /review-pr\.md/);
  assert.doesNotMatch(evidence, /AGENTS\.md instructions/i);
});
