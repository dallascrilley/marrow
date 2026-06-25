import assert from "node:assert/strict";
import test from "node:test";

import {
  hasProcessChatter,
  hasUsefulSummarySignal,
  hasWrapperTags,
  isAtomicStatement,
  isLowSignalSummary,
  isProcessChatterText,
  looksLikeCompletedOutcome,
  looksLikeProcessChatterLine,
} from "../dist/pipeline/artifact-heuristics.js";

function summary(overrides = {}) {
  return {
    files_of_interest: [],
    next_step: "No explicit next step recorded.",
    project_learnings: [],
    user_learnings: [],
    useful_commands: [],
    what_failed: [],
    what_was_decided: [],
    what_worked: [],
    ...overrides,
  };
}

test("looksLikeProcessChatterLine flags short process-only phrases", () => {
  assert.ok(looksLikeProcessChatterLine("Let me check the code."));
  assert.ok(looksLikeProcessChatterLine("I'll review this next."));
  assert.ok(looksLikeProcessChatterLine("Checking the logs now."));
  assert.ok(looksLikeProcessChatterLine("Exploring options."));
});

test("looksLikeProcessChatterLine permits durable signal wrapped in process wording", () => {
  assert.ok(
    !looksLikeProcessChatterLine(
      "Let me check what toast infrastructure is available: fixed the desktop-polish wiring and verified with `npm test`.",
    ),
  );
  assert.ok(
    looksLikeProcessChatterLine(
      "Checking whether we can quickly stabilize the two previous tests.",
    ),
  );
  assert.ok(looksLikeProcessChatterLine("I'll fix the failing test in desktop/vitest.config.ts."));
  assert.ok(
    looksLikeProcessChatterLine(
      "Now regenerate the registry summary + projections from the corrected description, then check whether the provenance edit survived the update.",
    ),
  );
  assert.ok(
    looksLikeProcessChatterLine("Now stage it in a cleanly-named directory and add it to hub."),
  );
});

test("looksLikeProcessChatterLine ignores lines without process prefix", () => {
  assert.ok(!looksLikeProcessChatterLine("Fixed the failing test."));
  assert.ok(!looksLikeProcessChatterLine("Use worker threads instead of forks."));
});

test("isProcessChatterText checks every line", () => {
  assert.ok(isProcessChatterText("Fixed the bug.\nLet me check.\nDone."));
  assert.ok(!isProcessChatterText("Fixed the bug.\nVerified with tests.\nDone."));
});

test("hasProcessChatter aliases isProcessChatterText", () => {
  assert.ok(hasProcessChatter("Let me check."));
  assert.ok(!hasProcessChatter("Fixed the bug."));
});

test("hasWrapperTags detects harness tags", () => {
  assert.ok(hasWrapperTags("<attached_files>foo</attached_files>"));
  assert.ok(hasWrapperTags('Use <skill id="foo"> for task.'));
  assert.ok(!hasWrapperTags("Use the skill for task."));
});

test("isLowSignalSummary true only when no signal and default next step", () => {
  assert.ok(isLowSignalSummary(summary()));
  assert.ok(!isLowSignalSummary(summary({ what_worked: ["Fixed the bug."] })));
  assert.ok(!isLowSignalSummary(summary({ next_step: "Fix the remaining test." })));
});

test("hasUsefulSummarySignal true when any field has content", () => {
  assert.ok(!hasUsefulSummarySignal(summary()));
  assert.ok(hasUsefulSummarySignal(summary({ what_worked: ["Fixed."] })));
  assert.ok(hasUsefulSummarySignal(summary({ project_learnings: ["Use x."] })));
  assert.ok(hasUsefulSummarySignal(summary({ useful_commands: ["npm test"] })));
});

test("looksLikeCompletedOutcome detects completed next steps", () => {
  assert.ok(looksLikeCompletedOutcome("Done and verified with all tests passing."));
  assert.ok(looksLikeCompletedOutcome("Implemented and verified."));
  assert.ok(!looksLikeCompletedOutcome("Fix the remaining test."));
});

test("isAtomicStatement rejects multi-sentence text", () => {
  assert.ok(isAtomicStatement("Fixed the bug."));
  assert.ok(isAtomicStatement("In file.ts, use worker threads; verified."));
  assert.ok(!isAtomicStatement("First, fixed the bug. Then updated the tests."));
  assert.ok(!isAtomicStatement("Fixed the bug. Updated the tests. Verified."));
});

test("isAtomicStatement handles empty input", () => {
  assert.ok(!isAtomicStatement(""));
  assert.ok(!isAtomicStatement("   "));
});
