import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";

import { executeQualityApplyLearningReview } from "../dist/commands/quality-apply-learning-review.js";
import { createLedger, upsertSourceSession } from "../dist/db/ledger.js";
import { learningFixture, sourceSessionFixture } from "../dist/models/canonical.js";
import { readLlmLearningReviewApplyLedger } from "../dist/pipeline/llm-learning-review-apply-ledger.js";
import {
  buildLearningReviewBatch,
  buildLearningReviewInputContentHash,
  writeLearningReviewBatch,
} from "../dist/pipeline/llm-learning-review-batch.js";
import { loadSessionBundle, sessionBundlePath } from "../dist/v2/instinct/bundle.js";
import { hashToProjectId } from "../dist/v2/project/resolve.js";
import { getProjectKnowledgeSessionPath } from "../dist/writers/knowledge-writer.js";
import { withRuntimeRoot } from "./helpers/with-runtime-root.mjs";

function makeSession(sessionId = "apply-ledger-session") {
  return {
    ...structuredClone(sourceSessionFixture),
    source_tool: "claude-code",
    source_path: `/tmp/${sessionId}.jsonl`,
    source_hash: `sha256:${sessionId}`,
    workspace_path: "/Users/example/Code/apply-ledger",
    project_key: "apply-ledger",
    session_id: sessionId,
    conversation_id: `${sessionId}-conversation`,
  };
}

function makeLearning(session, learningId, statement) {
  return {
    ...structuredClone(learningFixture),
    learning_id: learningId,
    scope_key: session.project_key,
    title: statement,
    statement,
    trigger: `When applying ${learningId}.`,
    source_refs: [
      {
        source_path: session.source_path,
        source_hash: session.source_hash,
        session_id: session.session_id,
        turn_id: null,
        event_id: null,
        line: 1,
      },
    ],
  };
}

function makeReview(learning, suggestedStatement) {
  return {
    durability: "durable",
    input_content_hash: buildLearningReviewInputContentHash(learning),
    keep: true,
    learning_id: learning.learning_id,
    reason: "Durable reviewed guidance.",
    scope_key: learning.scope_key,
    session_id: learning.source_refs[0].session_id,
    statement: learning.statement,
    suggested_statement: suggestedStatement,
    trigger: learning.trigger,
    verdict: suggestedStatement === learning.statement ? "keep" : "rewrite",
  };
}

async function writeOriginalLearnings(session, learnings) {
  const path = getProjectKnowledgeSessionPath(session.project_key, session.session_id);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${learnings.map((learning) => JSON.stringify(learning)).join("\n")}\n`,
    "utf8",
  );
}

async function writeBatch(runtimeRoot, input) {
  return writeLearningReviewBatch({
    batch: buildLearningReviewBatch({
      createdAt: input.createdAt,
      model: input.model,
      reviews: input.reviews,
      runId: input.runId,
      sourceLedgerWatermark: {
        entry_count: 0,
        last_learning_id: null,
        last_reviewed_at: null,
      },
    }),
    reportsDir: join(runtimeRoot, "reports"),
  });
}

async function applyBatch(database, batchPath, dependencies) {
  const messages = [];
  const exitCode = await executeQualityApplyLearningReview(
    {
      args: ["--batch", batchPath],
      commandPath: ["quality", "apply-learning-review"],
      output: {
        error: (message) => messages.push(message),
        info: (message) => messages.push(message),
      },
    },
    database,
    dependencies,
  );
  return { exitCode, payload: JSON.parse(messages.at(-1)) };
}

test("apply-learning-review merges overlapping batches and repeats as a stable no-op", async () => {
  await withRuntimeRoot(async (runtimeRoot) => {
    const database = await createLedger();
    try {
      const session = makeSession();
      const learningA = makeLearning(session, "learning-a", "Original statement A.");
      const learningB = makeLearning(session, "learning-b", "Original statement B.");
      upsertSourceSession(database, session);
      await writeOriginalLearnings(session, [learningA, learningB]);

      const first = await writeBatch(runtimeRoot, {
        createdAt: "2026-07-09T20:00:00.000Z",
        model: "openai/gpt-5-nano",
        reviews: [
          makeReview(learningA, "First reviewed statement A."),
          makeReview(learningB, "Reviewed statement B."),
        ],
        runId: "apply-first",
      });
      const second = await writeBatch(runtimeRoot, {
        createdAt: "2026-07-09T21:00:00.000Z",
        model: "openrouter/auto",
        reviews: [makeReview(learningA, "Second reviewed statement A.")],
        runId: "apply-second",
      });

      assert.equal((await applyBatch(database, first.batchPath)).exitCode, 0);
      const secondApply = await applyBatch(database, second.batchPath);
      assert.equal(secondApply.exitCode, 0);
      assert.equal(secondApply.payload.no_op, false);

      const projectId = hashToProjectId(session.workspace_path);
      const reviewedPath = join(
        runtimeRoot,
        "knowledge",
        "projects-reviewed",
        projectId,
        `${session.session_id}.jsonl`,
      );
      const reviewedAfterSecond = await readFile(reviewedPath, "utf8");
      const reviewed = reviewedAfterSecond
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.deepEqual(
        reviewed.map((learning) => [learning.learning_id, learning.statement]),
        [
          ["learning-a", "Second reviewed statement A."],
          ["learning-b", "Reviewed statement B."],
        ],
      );

      const bundlePath = sessionBundlePath(projectId, session.session_id);
      const bundleAfterSecond = await readFile(bundlePath, "utf8");
      const bundle = await loadSessionBundle(projectId, session.session_id);
      assert.equal(bundle.reviewed_at, second.batch.created_at);
      assert.equal(
        bundle.deltas.length,
        2,
        "the bundle uses the same merged set as reviewed memory",
      );

      await rm(join(runtimeRoot, "reports", "llm-learning-review-apply.json"), { force: true });

      const repeated = await applyBatch(database, second.batchPath);
      assert.equal(repeated.exitCode, 0);
      assert.equal(repeated.payload.no_op, true);
      const noOpReport = JSON.parse(
        await readFile(join(runtimeRoot, "reports", "llm-learning-review-apply.json"), "utf8"),
      );
      assert.equal(noOpReport.batch_id, second.batch.batch_id);
      assert.equal(noOpReport.no_op, true);
      assert.equal(await readFile(reviewedPath, "utf8"), reviewedAfterSecond);
      assert.equal(await readFile(bundlePath, "utf8"), bundleAfterSecond);

      const ledger = await readLlmLearningReviewApplyLedger();
      assert.deepEqual(
        ledger.map((entry) => [entry.batch_id, entry.status]),
        [
          [first.batch.batch_id, "applying"],
          [first.batch.batch_id, "applied"],
          [second.batch.batch_id, "applying"],
          [second.batch.batch_id, "applied"],
        ],
      );
      assert.equal(ledger.at(-1).reviewed_at, second.batch.created_at);
      assert.equal(ledger.at(-1).outputs[0].learning_count, 2);
    } finally {
      database.close();
    }
  });
});

test("apply-learning-review treats different decisions for identical inputs as distinct batches", async () => {
  await withRuntimeRoot(async (runtimeRoot) => {
    const database = await createLedger();
    try {
      const session = makeSession("decision-identity-session");
      const learning = makeLearning(session, "decision-learning", "Original decision statement.");
      upsertSourceSession(database, session);
      await writeOriginalLearnings(session, [learning]);

      const first = await writeBatch(runtimeRoot, {
        createdAt: "2026-07-09T21:30:00.000Z",
        model: "openrouter/auto",
        reviews: [makeReview(learning, "First reviewed decision.")],
        runId: "decision-first",
      });
      const second = await writeBatch(runtimeRoot, {
        createdAt: "2026-07-09T21:31:00.000Z",
        model: "openrouter/auto",
        reviews: [makeReview(learning, "Second reviewed decision.")],
        runId: "decision-second",
      });

      assert.notEqual(first.batch.batch_id, second.batch.batch_id);
      assert.equal((await applyBatch(database, first.batchPath)).payload.no_op, false);
      assert.equal((await applyBatch(database, second.batchPath)).payload.no_op, false);

      const projectId = hashToProjectId(session.workspace_path);
      const reviewedPath = join(
        runtimeRoot,
        "knowledge",
        "projects-reviewed",
        projectId,
        `${session.session_id}.jsonl`,
      );
      const applied = JSON.parse((await readFile(reviewedPath, "utf8")).trim());
      assert.equal(applied.statement, "Second reviewed decision.");
    } finally {
      database.close();
    }
  });
});

test("apply-learning-review does not finalize the ledger when its report cannot be written", async () => {
  await withRuntimeRoot(async (runtimeRoot) => {
    const database = await createLedger();
    try {
      const session = makeSession("report-retry-session");
      const learning = makeLearning(session, "report-retry-learning", "Report retry statement.");
      upsertSourceSession(database, session);
      await writeOriginalLearnings(session, [learning]);
      const batch = await writeBatch(runtimeRoot, {
        createdAt: "2026-07-09T21:45:00.000Z",
        model: "openrouter/auto",
        reviews: [makeReview(learning, "Reviewed report retry statement.")],
        runId: "report-retry",
      });

      await mkdir(join(runtimeRoot, "reports", "llm-learning-review-apply.json"), {
        recursive: true,
      });
      await assert.rejects(applyBatch(database, batch.batchPath));
      let ledger = await readLlmLearningReviewApplyLedger();
      assert.deepEqual(
        ledger.map((entry) => entry.status),
        ["applying", "failed"],
      );

      await rm(join(runtimeRoot, "reports", "llm-learning-review-apply.json"), {
        force: true,
        recursive: true,
      });
      const retry = await applyBatch(database, batch.batchPath);
      assert.equal(retry.payload.status, "applied");
      ledger = await readLlmLearningReviewApplyLedger();
      assert.deepEqual(
        ledger.map((entry) => entry.status),
        ["applying", "failed", "applying", "applied"],
      );
    } finally {
      database.close();
    }
  });
});

test("apply-learning-review retries a partially failed batch and converges", async () => {
  await withRuntimeRoot(async (runtimeRoot) => {
    const database = await createLedger();
    try {
      const firstSession = makeSession("retry-session-a");
      const secondSession = makeSession("retry-session-b");
      const firstLearning = makeLearning(firstSession, "retry-learning-a", "Retry statement A.");
      const secondLearning = makeLearning(secondSession, "retry-learning-b", "Retry statement B.");
      for (const [session, learning] of [
        [firstSession, firstLearning],
        [secondSession, secondLearning],
      ]) {
        upsertSourceSession(database, session);
        await writeOriginalLearnings(session, [learning]);
      }

      const batch = await writeBatch(runtimeRoot, {
        createdAt: "2026-07-09T22:00:00.000Z",
        model: "openrouter/auto",
        reviews: [
          makeReview(firstLearning, "Reviewed retry statement A."),
          makeReview(secondLearning, "Reviewed retry statement B."),
        ],
        runId: "apply-retry",
      });

      let syncCalls = 0;
      await assert.rejects(
        applyBatch(database, batch.batchPath, {
          afterSessionApplied: async () => {
            syncCalls += 1;
            if (syncCalls === 1) throw new Error("simulated interruption");
          },
        }),
        /simulated interruption/,
      );

      const retry = await applyBatch(database, batch.batchPath);
      assert.equal(retry.exitCode, 0);
      assert.equal(retry.payload.no_op, false);

      for (const session of [firstSession, secondSession]) {
        const projectId = hashToProjectId(session.workspace_path);
        const bundle = await loadSessionBundle(projectId, session.session_id);
        assert.equal(bundle.reviewed_at, batch.batch.created_at);
        assert.equal(bundle.deltas.length, 1);
      }

      const ledger = await readLlmLearningReviewApplyLedger();
      assert.deepEqual(
        ledger.map((entry) => entry.status),
        ["applying", "failed", "applying", "applied"],
      );
      assert.match(ledger[1].error, /simulated interruption/);
    } finally {
      database.close();
    }
  });
});
