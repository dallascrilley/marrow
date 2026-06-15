import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { sourceSessionFixture } from "../dist/models/canonical.js";
import { reviewLearningsBatchedWithOpenRouter } from "../dist/pipeline/llm-learning-review.js";

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
    scope_key: "studio-tools",
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
    statement: `Durable statement number ${counter} worth reviewing for project memory.`,
    title: "Decision",
    ...overrides,
  };
}

function batchResponse(reviews, usage) {
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        choices: [{ message: { content: JSON.stringify({ reviews }) } }],
        usage,
      };
    },
    async text() {
      return "";
    },
  };
}

test("batched review issues one call and demultiplexes verdicts by id", async () => {
  const learnings = [learning(), learning(), learning()];
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return batchResponse(
      learnings.map((l, i) => ({
        id: l.learning_id,
        keep: i !== 1,
        verdict: i === 1 ? "reject" : "keep",
        durability: i === 1 ? "transient" : "durable",
        statement: i === 1 ? "Rejected" : l.statement,
        reason: "judged",
      })),
      { prompt_tokens: 300, completion_tokens: 30, total_tokens: 330, cost: 0.0009 },
    );
  };

  const outcome = await reviewLearningsBatchedWithOpenRouter({
    apiKey: "test-key",
    fetchImpl,
    learnings,
    noCache: true,
    projectKey: "studio-tools",
  });

  assert.equal(calls, 1, "three learnings share a single HTTP call");
  assert.equal(outcome.reviewed.length, 3);
  assert.equal(outcome.failures.length, 0);

  const byId = new Map(outcome.reviewed.map((r) => [r.learning.learning_id, r]));
  assert.equal(byId.get(learnings[0].learning_id).review.verdict, "keep");
  assert.equal(byId.get(learnings[1].learning_id).review.verdict, "reject");
  assert.equal(byId.get(learnings[1].learning_id).review.keep, false);

  // Cost/tokens split evenly across the batch and tagged with batch_size.
  for (const r of outcome.reviewed) {
    assert.equal(r.usage.batch_size, 3);
    assert.equal(r.usage.cost, 0.0009 / 3);
  }
  const totalReasoning = outcome.reviewed.reduce((s, r) => s + (r.usage.total_tokens ?? 0), 0);
  assert.equal(totalReasoning, 330, "split token totals sum back to the original");
});

test("batched review serves cache hits without a second call", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "asd-batch-cache-"));
  try {
    const learnings = [learning(), learning()];
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return batchResponse(
        learnings.map((l) => ({
          id: l.learning_id,
          keep: true,
          verdict: "keep",
          durability: "durable",
          statement: l.statement,
          reason: "judged",
        })),
        { prompt_tokens: 200, completion_tokens: 20, total_tokens: 220, cost: 0.0006 },
      );
    };

    const first = await reviewLearningsBatchedWithOpenRouter({
      apiKey: "test-key",
      cacheDir,
      fetchImpl,
      learnings,
      projectKey: "studio-tools",
    });
    assert.equal(calls, 1);
    assert.equal(first.reviewed.length, 2);

    // Second run: both learnings are cached → no new HTTP call.
    const second = await reviewLearningsBatchedWithOpenRouter({
      apiKey: "test-key",
      cacheDir,
      fetchImpl,
      learnings,
      projectKey: "studio-tools",
    });
    assert.equal(calls, 1, "cache hits bypass the batch entirely");
    assert.equal(second.reviewed.length, 2);
    assert.ok(second.reviewed.every((r) => r.usage.cache_hit === true));
  } finally {
    await rm(cacheDir, { force: true, recursive: true });
  }
});
