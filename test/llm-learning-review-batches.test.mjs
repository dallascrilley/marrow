import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { learningFixture } from "../dist/models/canonical.js";
import {
  buildLearningReviewBatch,
  buildLearningReviewInputContentHash,
  parseLearningReviewBatch,
  serializeLearningReviewBatch,
  writeLearningReviewBatch,
} from "../dist/pipeline/llm-learning-review-batch.js";

const reviewedEntries = [
  {
    durability: "durable",
    input_content_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    keep: true,
    learning_id: "learning-a",
    reason: "Durable project guidance.",
    scope_key: "studio-tools",
    session_id: "session-a",
    statement: "Original statement A.",
    suggested_statement: "Reviewed statement A.",
    trigger: "When working on A.",
    verdict: "rewrite",
  },
  {
    durability: "transient",
    input_content_hash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    keep: false,
    learning_id: "learning-b",
    reason: "One-off process detail.",
    scope_key: "studio-tools",
    session_id: "session-b",
    statement: "Original statement B.",
    suggested_statement: "Rejected statement B.",
    trigger: "",
    verdict: "reject",
  },
];

function build(overrides = {}) {
  return buildLearningReviewBatch({
    createdAt: "2026-07-09T20:00:00.000Z",
    model: "openai/gpt-5-nano",
    reviews: reviewedEntries,
    runId: "run-001",
    sourceLedgerWatermark: {
      entry_count: 4,
      last_learning_id: "prior-learning",
      last_reviewed_at: "2026-07-09T19:00:00.000Z",
    },
    ...overrides,
  });
}

test("review batch content identity is stable across run metadata", () => {
  const first = build();
  const repeated = build({
    createdAt: "2026-07-09T21:00:00.000Z",
    runId: "run-002",
  });

  assert.equal(first.batch_id, repeated.batch_id);
  assert.notEqual(first.run_id, repeated.run_id);
  assert.notEqual(first.created_at, repeated.created_at);
});

test("review input hash tracks prompt-relevant content and ignores metadata-only fields", () => {
  const first = buildLearningReviewInputContentHash(learningFixture);
  const promptChanged = buildLearningReviewInputContentHash({
    ...learningFixture,
    statement: `${learningFixture.statement} Updated.`,
  });
  const metadataChanged = buildLearningReviewInputContentHash({
    ...learningFixture,
    technologies: [...learningFixture.technologies, "sqlite"],
  });

  assert.notEqual(first, promptChanged);
  assert.equal(first, metadataChanged);
});

test("review batch rejects malformed input content hashes", () => {
  assert.throws(
    () =>
      build({
        reviews: [{ ...reviewedEntries[0], input_content_hash: "sha256:not-a-hash" }],
      }),
    /input_content_hash/,
  );
});

test("review batch identity changes when ordered inputs change", () => {
  const first = build();
  const reordered = build({ reviews: [...reviewedEntries].reverse() });

  assert.notEqual(first.batch_id, reordered.batch_id);
});

test("review batch identity changes with prompt contract version", () => {
  const first = build();
  const changedPrompt = build({ promptVersion: "llm-learning-review-prompt-v3" });

  assert.notEqual(first.batch_id, changedPrompt.batch_id);
});

test("review batch serialization preserves metadata and verdict counts", () => {
  const batch = build();
  const parsed = parseLearningReviewBatch(serializeLearningReviewBatch(batch));

  assert.deepEqual(parsed, batch);
  assert.equal(parsed.status, "generated");
  assert.equal(parsed.count, 2);
  assert.deepEqual(parsed.verdict_counts, { keep: 0, reject: 1, rewrite: 1 });
  assert.deepEqual(parsed.source_ledger_watermark, {
    entry_count: 4,
    last_learning_id: "prior-learning",
    last_reviewed_at: "2026-07-09T19:00:00.000Z",
  });
});

test("identical content from repeated runs writes distinct immutable artifacts", async () => {
  const reportsDir = await mkdtemp(join(tmpdir(), "asd-review-batches-"));
  try {
    const first = await writeLearningReviewBatch({ batch: build(), reportsDir });
    const second = await writeLearningReviewBatch({
      batch: build({ createdAt: "2026-07-09T21:00:00.000Z", runId: "run-002" }),
      reportsDir,
    });

    assert.notEqual(first.batchPath, second.batchPath);
    assert.equal(first.batch.batch_id, second.batch.batch_id);
    assert.deepEqual(
      parseLearningReviewBatch(await readFile(first.batchPath, "utf8")),
      first.batch,
    );

    const latest = JSON.parse(await readFile(second.latestPointerPath, "utf8"));
    assert.equal(latest.batch_id, second.batch.batch_id);
    assert.equal(latest.run_id, "run-002");
    assert.equal(latest.batch_path, second.batchPath);

    await assert.rejects(
      writeLearningReviewBatch({ batch: first.batch, reportsDir }),
      (error) => error?.code === "EEXIST",
      "an existing run artifact is never overwritten",
    );
  } finally {
    await rm(reportsDir, { force: true, recursive: true });
  }
});

test("parallel batch writes use collision-resistant latest-pointer temp files", async () => {
  const reportsDir = await mkdtemp(join(tmpdir(), "asd-review-batches-concurrent-"));
  try {
    const writes = Array.from({ length: 24 }, (_, index) =>
      writeLearningReviewBatch({
        batch: build({
          createdAt: `2026-07-09T21:00:${String(index).padStart(2, "0")}.000Z`,
          runId: `parallel-${String(index).padStart(2, "0")}`,
        }),
        reportsDir,
      }),
    );

    const results = await Promise.all(writes);
    assert.equal(new Set(results.map((result) => result.batchPath)).size, writes.length);

    const latest = JSON.parse(await readFile(results[0].latestPointerPath, "utf8"));
    const matchingResult = results.find((result) => result.batch.run_id === latest.run_id);
    assert.ok(matchingResult, "latest pointer references one completed concurrent write");
    assert.equal(latest.batch_path, matchingResult.batchPath);
  } finally {
    await rm(reportsDir, { force: true, recursive: true });
  }
});
