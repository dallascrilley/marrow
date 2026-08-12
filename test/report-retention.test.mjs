import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { executeStorageReportRetention } from "../dist/commands/storage-report-retention.js";
import { runtimeRootOverrideEnvVar } from "../dist/config/paths.js";
import { createLedger, upsertSourceSession } from "../dist/db/ledger.js";
import { sourceSessionFixture } from "../dist/models/canonical.js";
import { appendLlmLearningReviewApplyLedgerEntry } from "../dist/pipeline/llm-learning-review-apply-ledger.js";
import {
  buildLearningReviewBatch,
  writeLearningReviewBatch,
} from "../dist/pipeline/llm-learning-review-batch.js";

const oldDate = new Date("2026-05-01T12:00:00.000Z");

async function withRuntimeRoot(run) {
  const previousRoot = process.env[runtimeRootOverrideEnvVar];
  const runtimeRoot = await mkdtemp(join(tmpdir(), "marrow-report-retention-"));
  process.env[runtimeRootOverrideEnvVar] = runtimeRoot;
  try {
    await run(runtimeRoot);
  } finally {
    if (previousRoot === undefined) delete process.env[runtimeRootOverrideEnvVar];
    else process.env[runtimeRootOverrideEnvVar] = previousRoot;
    await rm(runtimeRoot, { force: true, recursive: true });
  }
}

function session(sessionId) {
  return {
    ...sourceSessionFixture,
    conversation_id: `report-retention:${sessionId}`,
    ingest_status: "archived",
    project_key: "report-retention-project",
    session_id: sessionId,
    source_hash: `sha256:${sessionId}`,
  };
}

async function writeOldReport(path, contents) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, contents, "utf8");
  await utimes(path, oldDate, oldDate);
}

function reviewBatch(runId, createdAt) {
  return buildLearningReviewBatch({
    createdAt,
    model: "openrouter/auto",
    reviews: [
      {
        durability: "durable",
        input_content_hash: `sha256:${"a".repeat(64)}`,
        keep: true,
        learning_id: `learning-${runId}`,
        reason: "Durable and scoped.",
        scope_key: "report-retention-project",
        session_id: `review-${runId}`,
        statement: `Keep review ${runId}.`,
        suggested_statement: `Keep review ${runId}.`,
        verdict: "keep",
      },
    ],
    runId,
    sourceLedgerWatermark: { entry_count: 1, last_learning_id: "learning", last_reviewed_at: null },
  });
}

async function runRetention(database, args) {
  const output = [];
  const exitCode = await executeStorageReportRetention(
    {
      args,
      commandPath: ["storage", "retain-reports"],
      output: { error: (message) => output.push(message), info: (message) => output.push(message) },
    },
    database,
  );
  return { exitCode, payload: JSON.parse(output.join("\n")) };
}

test("report retention dry-runs and prunes only terminal archive history", async () => {
  await withRuntimeRoot(async (runtimeRoot) => {
    const database = await createLedger();
    try {
      upsertSourceSession(database, session("older"));
      upsertSourceSession(database, session("newer"));
      upsertSourceSession(database, { ...session("active"), ingest_status: "parsed" });
      const olderJson = join(runtimeRoot, "reports", "archive-older.json");
      const olderMarkdown = join(runtimeRoot, "reports", "archive-older.md");
      const newerJson = join(runtimeRoot, "reports", "archive-newer.json");
      const activeJson = join(runtimeRoot, "reports", "archive-active.json");
      await mkdir(join(runtimeRoot, "reports"), { recursive: true });
      await Promise.all([
        writeOldReport(olderJson, "older json"),
        writeOldReport(olderMarkdown, "older markdown"),
        writeFile(newerJson, "newer json", "utf8"),
        writeOldReport(join(runtimeRoot, "reports", "llm-telemetry.jsonl"), "telemetry\n"),
        writeOldReport(activeJson, "active json"),
      ]);

      const dryRun = await runRetention(database, ["--history", "0"]);
      assert.equal(dryRun.exitCode, 0);
      assert.equal(dryRun.payload.apply, false);
      assert.deepEqual(
        dryRun.payload.candidates.map((candidate) => [candidate.path, candidate.reason]),
        [
          [olderJson, "terminal_history"],
          [olderMarkdown, "terminal_history"],
        ],
      );
      await access(olderJson);
      await access(olderMarkdown);
      await access(newerJson);
      await access(activeJson);

      const applied = await runRetention(database, ["--history", "0", "--apply"]);
      assert.equal(applied.exitCode, 0);
      await assert.rejects(access(olderJson), { code: "ENOENT" });
      await assert.rejects(access(olderMarkdown), { code: "ENOENT" });
      await access(newerJson);
      await access(join(runtimeRoot, "reports", "llm-telemetry.jsonl"));
      const receipt = JSON.parse(await readFile(applied.payload.receipt_path, "utf8"));
      assert.equal(receipt.status, "completed");
      assert.deepEqual(receipt.deleted_paths, [olderJson, olderMarkdown]);

      const rerun = await runRetention(database, ["--history", "0", "--apply"]);
      assert.deepEqual(rerun.payload.candidates, []);
    } finally {
      database.close();
    }
  });
});

test("report retention preserves incomplete work and prunes only applied review history", async () => {
  await withRuntimeRoot(async (runtimeRoot) => {
    const database = await createLedger();
    try {
      const reportsDir = join(runtimeRoot, "reports");
      const older = await writeLearningReviewBatch({
        batch: reviewBatch("older", "2026-05-01T12:00:00.000Z"),
        reportsDir,
      });
      const newer = await writeLearningReviewBatch({
        batch: reviewBatch("newer", "2026-06-01T12:00:00.000Z"),
        reportsDir,
      });
      const incomplete = await writeLearningReviewBatch({
        batch: reviewBatch("incomplete", "2026-04-01T12:00:00.000Z"),
        reportsDir,
      });
      for (const result of [older, newer]) {
        await appendLlmLearningReviewApplyLedgerEntry({
          affected_sessions: [],
          apply_id: `apply-${result.batch.run_id}`,
          batch_id: result.batch.batch_id,
          batch_path: result.batchPath,
          outputs: [],
          recorded_at: result.batch.created_at,
          reviewed_at: result.batch.created_at,
          schema_version: "llm-learning-review-apply-ledger-v1",
          status: "applied",
        });
      }
      await utimes(older.batchPath, oldDate, oldDate);
      await utimes(incomplete.batchPath, oldDate, oldDate);

      const dryRun = await runRetention(database, ["--history", "1"]);
      assert.deepEqual(
        dryRun.payload.candidates.map((candidate) => [candidate.path, candidate.reason]),
        [[older.batchPath, "applied_history"]],
      );
      await access(incomplete.batchPath);

      await runRetention(database, ["--history", "1", "--apply"]);
      await assert.rejects(access(older.batchPath), { code: "ENOENT" });
      await access(newer.batchPath);
      await access(incomplete.batchPath);
    } finally {
      database.close();
    }
  });
});

test("report retention rejects unknown options and requires explicit apply", async () => {
  await withRuntimeRoot(async () => {
    const database = await createLedger();
    try {
      await assert.rejects(
        runRetention(database, ["--unknown"]),
        /Unknown storage retain-reports option/,
      );
    } finally {
      database.close();
    }
  });
});
