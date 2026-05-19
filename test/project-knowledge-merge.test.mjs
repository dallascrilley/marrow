import test from "node:test";
import assert from "node:assert/strict";

import { learningFixture } from "../dist/models/canonical.js";
import { dedupeProjectLearnings } from "../dist/pipeline/project-knowledge-merge.js";

function workflowLearning(sessionId, statement) {
  return {
    ...learningFixture,
    learning_id: `learning-${sessionId}`,
    kind: "workflow",
    statement,
    title: "Workflow",
    source_refs: [
      {
        ...learningFixture.source_refs[0],
        session_id: sessionId,
      },
    ],
  };
}

test("dedupeProjectLearnings merges duplicate workflow commands across sessions", () => {
  const command = "./.codex/prompts/review-pr.md";
  const merged = dedupeProjectLearnings([
    workflowLearning("session-a", `Use ${command} for PR review.`),
    workflowLearning("session-b", `Ran ${command} during review.`),
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].source_refs.length, 2);
});

test("dedupeProjectLearnings keeps distinct statements", () => {
  const merged = dedupeProjectLearnings([
    workflowLearning("session-a", "Prefer pnpm over npm in this repo."),
    workflowLearning("session-b", "Run quality audit after batch ingest."),
  ]);

  assert.equal(merged.length, 2);
});
