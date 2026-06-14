import assert from "node:assert/strict";
import test from "node:test";

import { applyDelta, applyDeltas } from "../dist/v2/instinct/apply-delta.js";

const ctx = {
  now: "2026-05-19T12:00:00Z",
  sessionId: "sess-a",
};

const createDelta = (id, finding = "Finding one.") => ({
  op: "create",
  instinct_id: id,
  trigger: "When doing X",
  finding,
  domain: "tooling",
  initial_confidence: 0.65,
});

test("duplicate create reinforces instead of replacing", () => {
  const id = "prefer-pnpm-over-npm-11111111";
  let map = applyDelta(new Map(), createDelta(id), ctx);
  map = applyDelta(map, createDelta(id, "Should not replace."), {
    ...ctx,
    sessionId: "sess-b",
    now: "2026-05-19T13:00:00Z",
  });

  const instinct = map.get(id);
  assert.ok(instinct);
  assert.equal(instinct.finding, "Finding one.");
  assert.equal(instinct.source.observations.length, 2);
  assert.equal(instinct.source.observations[1].session, "sess-b");
});

test("merge folds source observations into target and removes source", () => {
  const sourceId = "source-instinct-aaaaaaaa";
  const targetId = "target-instinct-bbbbbbbb";
  let map = applyDeltas(
    new Map(),
    [createDelta(sourceId, "Source finding."), createDelta(targetId, "Target finding.")],
    ctx,
  );

  map = applyDelta(
    map,
    { op: "merge", instinct_id: sourceId, into: targetId },
    { ...ctx, now: "2026-05-19T14:00:00Z", sessionId: "sess-merge" },
  );

  assert.equal(map.has(sourceId), false);
  const target = map.get(targetId);
  assert.ok(target);
  assert.equal(target.source.observations.length, 2);
});

test("correct updates finding without stacking confidence delta", () => {
  const id = "correct-me-cccccccc";
  let map = applyDelta(new Map(), createDelta(id), ctx);
  const before = map.get(id).confidence;

  map = applyDelta(
    map,
    {
      op: "correct",
      instinct_id: id,
      correction: "Revised finding.",
      delta: { confidence: 0.99 },
    },
    { ...ctx, now: "2026-05-20T12:00:00Z", sessionId: "sess-correct" },
  );

  const after = map.get(id);
  assert.equal(after.finding, "Revised finding.");
  assert.ok(after.confidence <= 0.85, "confidence should come from recompute, not raw delta bump");
  assert.ok(Math.abs(after.confidence - before) < 0.5);
});
