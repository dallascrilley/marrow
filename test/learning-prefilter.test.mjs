import assert from "node:assert/strict";
import test from "node:test";

import { sourceSessionFixture } from "../dist/models/canonical.js";
import { partitionLearningsForReview } from "../dist/pipeline/learning-prefilter.js";

let counter = 0;
function learning(overrides = {}) {
  counter += 1;
  return {
    confidence: "medium",
    evidence: ["evidence"],
    kind: "decision",
    learning_id: `learning-${counter}`,
    promotion_basis: "fixture",
    scope: "project",
    scope_key: "service-tools",
    source_refs: [
      {
        event_id: null,
        line: null,
        session_id: sourceSessionFixture.session_id,
        source_hash: sourceSessionFixture.source_hash,
        source_path: sourceSessionFixture.source_path,
        turn_id: null,
      },
    ],
    statement: "Capture OpenRouter usage and cost at the call boundary to enable budgeting.",
    title: "Decision",
    ...overrides,
  };
}

test("partition keeps substantive learnings and flags low-signal noise", () => {
  const learnings = [
    // Harness leak that contaminates a learning statement — exactly the junk the
    // deterministic detector already condemns, so reviewing it is wasted spend.
    learning({ statement: "Base directory for this skill: /Users/x/.claude/skills/foo" }),
    learning({ statement: "ce-work" }),
    learning({
      statement: "Prefer effective upstream cost over usage.cost for BYOK OpenRouter keys.",
    }),
  ];

  const { toReview, skipped } = partitionLearningsForReview(learnings, "ses-1", new Set());

  assert.equal(toReview.length, 1);
  assert.match(toReview[0].statement, /effective upstream cost/);
  assert.equal(skipped.length, 2);
  assert.ok(skipped.every((entry) => entry.reason === "low_signal"));
  assert.ok(skipped.every((entry) => entry.session_id === "ses-1"));
});

test("partition dedupes identical statements across sessions", () => {
  const seen = new Set();
  const statement = "Reasoning tokens dominate memory-lint review cost; cap effort to low.";

  const first = partitionLearningsForReview([learning({ statement })], "ses-1", seen);
  const second = partitionLearningsForReview([learning({ statement })], "ses-2", seen);

  assert.equal(first.toReview.length, 1);
  assert.equal(first.skipped.length, 0);

  assert.equal(second.toReview.length, 0);
  assert.equal(second.skipped.length, 1);
  assert.equal(second.skipped[0].reason, "duplicate");
  assert.equal(second.skipped[0].session_id, "ses-2");
});

test("partition treats whitespace/case variants as duplicates", () => {
  const seen = new Set();
  const a = learning({
    statement: "Telemetry writes stay fail-soft and never break the pipeline.",
  });
  const b = learning({
    statement: "  TELEMETRY writes   stay fail-soft and never break the pipeline.  ",
  });

  partitionLearningsForReview([a], "ses-1", seen);
  const { toReview, skipped } = partitionLearningsForReview([b], "ses-2", seen);

  assert.equal(toReview.length, 0);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].reason, "duplicate");
});
