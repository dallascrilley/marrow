#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildLearningReviewBatch,
  buildLearningReviewInputContentHash,
  writeLearningReviewBatch,
} from "../dist/pipeline/llm-learning-review-batch.js";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const cliPath = join(projectRoot, "dist", "cli.js");
const args = process.argv.slice(2);
const includeLive = args.includes("--live");
const keepSandbox = args.includes("--keep");
const writeJsonPath = parseOption("--write-json");
const writeSummaryPath = parseOption("--write-summary");

const report = {
  schema_version: "review-apply-exactly-once-proof-v1",
  generated_at: new Date().toISOString(),
  git_sha: gitOutput(["rev-parse", "HEAD"]),
  deterministic: await runDeterministicProof(),
  live: includeLive
    ? await runBoundedLiveProof()
    : { status: "skipped", reason: "Run with --live to exercise one provider-reviewed learning." },
};
report.success = report.deterministic.success && (!includeLive || report.live.success);

if (writeJsonPath) {
  await mkdir(dirname(writeJsonPath), { recursive: true });
  await writeFile(writeJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
if (writeSummaryPath) {
  await mkdir(dirname(writeSummaryPath), { recursive: true });
  await writeFile(writeSummaryPath, formatSummary(report), "utf8");
}

console.log(JSON.stringify(report, null, 2));
process.exitCode = report.success ? 0 : 1;

async function runDeterministicProof() {
  const sandbox = await mkdtemp(join(tmpdir(), "marrow-review-apply-proof-"));
  const runtimeRoot = join(sandbox, "runtime");
  const home = join(sandbox, "home");

  try {
    const fixture = await seedFixtureRuntime({ home, runtimeRoot, sessionName: "session-e2e" });
    const firstBatch = await writeProofBatch({
      runtimeRoot,
      learning: fixture.learning,
      createdAt: "2026-07-09T22:00:00.000Z",
      runId: "proof-duplicate-apply",
      suggestedStatement: "Use an immutable batch and append-only ledger for reviewed memory.",
    });

    const firstApply = runCli(
      ["quality", "apply-learning-review", "--batch", firstBatch.batchPath],
      runtimeRoot,
    );
    const output = firstApply.payload.outputs[0];
    if (!output) throw new Error("Initial apply did not write a reviewed output.");
    const reviewedPath = output.path;
    const bundlePath = join(
      runtimeRoot,
      "instincts",
      output.project_id,
      "sessions",
      `${output.session_id}.yaml`,
    );
    const receiptPath = join(runtimeRoot, "reports", "llm-learning-review-apply.json");
    const applyLedgerPath = join(runtimeRoot, "reports", "llm-learning-review-apply-ledger.jsonl");
    const beforeDuplicate = await fileEvidence([reviewedPath, bundlePath]);
    await rm(receiptPath, { force: true });
    const duplicateApply = runCli(
      ["quality", "apply-learning-review", "--batch", firstBatch.batchPath],
      runtimeRoot,
    );
    const afterDuplicate = await fileEvidence([reviewedPath, bundlePath]);
    const duplicateUnchanged = sameEvidence(beforeDuplicate, afterDuplicate);
    const receiptRecreated = await fileExists(receiptPath);

    const batchesBeforeSkip = await listBatchNames(runtimeRoot);
    const applyLedgerBeforeSkip = await fingerprint(applyLedgerPath);
    const outputsBeforeSkip = await fileEvidence([reviewedPath, bundlePath]);
    const skippedGeneration = runCli(
      ["quality", "review-learnings", "--if-new", "--max-per", "0/24h", "--max-usd", "0/24h"],
      runtimeRoot,
    );
    const batchesAfterSkip = await listBatchNames(runtimeRoot);
    const applyLedgerAfterSkip = await fingerprint(applyLedgerPath);
    const outputsAfterSkip = await fileEvidence([reviewedPath, bundlePath]);
    const skippedUnchanged =
      skippedGeneration.payload.skipped === true &&
      skippedGeneration.payload.generated_batch !== true &&
      JSON.stringify(batchesBeforeSkip) === JSON.stringify(batchesAfterSkip) &&
      applyLedgerBeforeSkip === applyLedgerAfterSkip &&
      sameEvidence(outputsBeforeSkip, outputsAfterSkip);

    const retryBatch = await writeProofBatch({
      runtimeRoot,
      learning: fixture.learning,
      createdAt: "2026-07-09T22:05:00.000Z",
      runId: "proof-interrupted-retry",
      suggestedStatement: "Retry incomplete reviewed-memory application until it converges.",
    });
    await rm(receiptPath, { force: true, recursive: true });
    await mkdir(receiptPath, { recursive: true });
    const interrupted = runCliAllowFailure(
      ["quality", "apply-learning-review", "--batch", retryBatch.batchPath],
      runtimeRoot,
    );
    const interruptedOutputEvidence = await fileEvidence([reviewedPath, bundlePath]);
    await rm(receiptPath, { force: true, recursive: true });
    const retryApply = runCli(
      ["quality", "apply-learning-review", "--batch", retryBatch.batchPath],
      runtimeRoot,
    );
    const retryOutputEvidence = await fileEvidence([reviewedPath, bundlePath]);
    const retryLedger = (await readJsonl(applyLedgerPath)).filter(
      (entry) => entry.batch_id === retryBatch.batch.batch_id,
    );
    const retryStatuses = retryLedger.map((entry) => entry.status);
    const retryConverged =
      interrupted.status !== 0 &&
      retryApply.payload.status === "applied" &&
      retryApply.payload.batch_id === retryBatch.batch.batch_id &&
      JSON.stringify(retryStatuses) ===
        JSON.stringify(["applying", "failed", "applying", "applied"]) &&
      retryOutputEvidence.every((entry) => entry.exists) &&
      interruptedOutputEvidence.every((entry) => entry.exists) &&
      retryOutputEvidence.every(
        (entry, index) => entry.sha256 === interruptedOutputEvidence[index]?.sha256,
      );

    const result = {
      success:
        firstApply.payload.status === "applied" &&
        duplicateApply.payload.no_op === true &&
        duplicateUnchanged &&
        receiptRecreated &&
        skippedUnchanged &&
        retryConverged,
      batch_ids: {
        duplicate: firstBatch.batch.batch_id,
        retry: retryBatch.batch.batch_id,
      },
      duplicate_apply: {
        status: duplicateApply.payload.status,
        no_op: duplicateApply.payload.no_op,
        receipt_recreated: receiptRecreated,
        outputs_unchanged: duplicateUnchanged,
        before: normalizeEvidence(beforeDuplicate, runtimeRoot),
        after: normalizeEvidence(afterDuplicate, runtimeRoot),
      },
      skipped_generation: {
        skip_reason: skippedGeneration.payload.skip_reason,
        generated_batch: skippedGeneration.payload.generated_batch ?? false,
        batch_files_before: batchesBeforeSkip,
        batch_files_after: batchesAfterSkip,
        apply_ledger_hash_before: applyLedgerBeforeSkip,
        apply_ledger_hash_after: applyLedgerAfterSkip,
        reviewed_outputs_unchanged: sameEvidence(outputsBeforeSkip, outputsAfterSkip),
        state_unchanged: skippedUnchanged,
      },
      interrupted_retry: {
        simulated_failure_exit_code: interrupted.status,
        ledger_transitions: retryStatuses,
        converged: retryConverged,
        outputs_after_failure: normalizeEvidence(interruptedOutputEvidence, runtimeRoot),
        outputs_after_retry: normalizeEvidence(retryOutputEvidence, runtimeRoot),
      },
      reviewed_file_count: retryApply.payload.outputs.length,
      reviewed_learning_count: retryApply.payload.outputs.reduce(
        (sum, entry) => sum + entry.learning_count,
        0,
      ),
    };
    return result;
  } finally {
    if (!keepSandbox) await rm(sandbox, { force: true, recursive: true });
  }
}

async function runBoundedLiveProof() {
  if (!process.env.OPENROUTER_API_KEY) {
    return { success: false, status: "failed", reason: "OPENROUTER_API_KEY is not set." };
  }
  const sandbox = await mkdtemp(join(tmpdir(), "marrow-review-live-proof-"));
  const runtimeRoot = join(sandbox, "runtime");
  const home = join(sandbox, "home");
  const model = process.env.OPENROUTER_MODEL ?? "google/gemini-3-flash-preview";

  try {
    const fixture = await seedFixtureRuntime({ home, runtimeRoot, sessionName: "session-e2e" });
    const durableLearning = {
      ...fixture.learning,
      title: "Preserve unrelated shared-worktree changes",
      statement:
        "Before editing a shared repository, inspect git status and preserve unrelated user changes.",
      trigger: "When starting work in a shared repository or worktree.",
    };
    await writeFile(fixture.learningPath, `${JSON.stringify(durableLearning)}\n`, "utf8");
    const review = runCli(
      [
        "quality",
        "review-learnings",
        "--if-new",
        "--limit",
        "1",
        "--max-learnings",
        "1",
        "--max-total-learnings",
        "1",
        "--batch-size",
        "1",
        "--model",
        model,
        "--max-per",
        "1/24h",
        "--max-usd",
        "0.05/24h",
        "--no-cache",
      ],
      runtimeRoot,
    );
    if (review.payload.generated_batch !== true || !review.payload.batch_path) {
      throw new Error(`Bounded live review did not generate a batch: ${review.stdout}`);
    }
    const apply = runCli(
      ["quality", "apply-learning-review", "--batch", review.payload.batch_path],
      runtimeRoot,
    );
    const batchFiles = await listBatchNames(runtimeRoot);
    const batch = JSON.parse(await readFile(review.payload.batch_path, "utf8"));
    const acceptedCount = batch.reviews.filter(
      (entry) => entry.keep === true && entry.durability === "durable",
    ).length;
    const appliedLearningCount = apply.payload.outputs.reduce(
      (sum, entry) => sum + entry.learning_count,
      0,
    );
    const success =
      review.payload.count <= 1 &&
      review.payload.total_reviewed_learnings <= 1 &&
      batchFiles.length === 1 &&
      apply.payload.batch_id === review.payload.batch_id &&
      apply.payload.batch_path === review.payload.batch_path &&
      appliedLearningCount === acceptedCount;

    return {
      success,
      status: success ? "passed" : "failed",
      model: review.payload.model,
      batch_id: review.payload.batch_id,
      reviewed_count: review.payload.count,
      accepted_count: acceptedCount,
      applied_learning_count: appliedLearningCount,
      batch_file_count: batchFiles.length,
      exact_batch_applied: apply.payload.batch_id === review.payload.batch_id,
      budget: {
        max_per: review.payload.llm_budget?.max_per_window ?? "1/24h",
        max_usd: review.payload.usd_budget?.max_usd_per_window ?? "0.05/24h",
      },
      ledger_transitions: (
        await readJsonl(join(runtimeRoot, "reports", "llm-learning-review-apply-ledger.jsonl"))
      ).map((entry) => entry.status),
    };
  } finally {
    if (!keepSandbox) await rm(sandbox, { force: true, recursive: true });
  }
}

async function seedFixtureRuntime({ home, runtimeRoot, sessionName }) {
  const cursorProject = join(home, ".cursor", "projects", "marrow");
  await mkdir(join(cursorProject, "agent-transcripts"), { recursive: true });
  await writeFile(join(cursorProject, "workspace-path.txt"), `${projectRoot}\n`, "utf8");
  await cp(
    join(projectRoot, "test/fixtures/cursor/transcripts/session-e2e.jsonl"),
    join(cursorProject, "agent-transcripts", `${sessionName}.jsonl`),
  );
  const ingest = runCli(["ingest", "backfill", "--source", "cursor"], runtimeRoot, { HOME: home });
  const session = ingest.payload.sessions[0];
  if (!session?.project_key || !session?.session_id)
    throw new Error("Fixture ingest returned no session.");
  const learningPath = join(
    runtimeRoot,
    "knowledge",
    "projects",
    session.project_key,
    `${session.session_id}.jsonl`,
  );
  const learning = JSON.parse((await readFile(learningPath, "utf8")).trim().split("\n")[0]);
  return { learning, learningPath, session };
}

async function writeProofBatch({ runtimeRoot, learning, createdAt, runId, suggestedStatement }) {
  return writeLearningReviewBatch({
    batch: buildLearningReviewBatch({
      createdAt,
      model: "proof-fixture",
      reviews: [
        {
          session_id: learning.source_refs[0].session_id,
          learning_id: learning.learning_id,
          input_content_hash: buildLearningReviewInputContentHash(learning),
          scope_key: learning.scope_key,
          statement: learning.statement,
          suggested_statement: suggestedStatement,
          trigger: learning.trigger,
          verdict: "rewrite",
          keep: true,
          durability: "durable",
          reason: "Exactly-once behavioral proof fixture.",
        },
      ],
      runId,
      sourceLedgerWatermark: {
        entry_count: 0,
        last_learning_id: null,
        last_reviewed_at: null,
      },
    }),
    reportsDir: join(runtimeRoot, "reports"),
  });
}

function runCli(commandArgs, runtimeRoot, extraEnv = {}) {
  const result = runCliAllowFailure(commandArgs, runtimeRoot, extraEnv);
  if (result.status !== 0) {
    throw new Error(
      `CLI failed (${result.status}): ${commandArgs.join(" ")}\n${result.stderr || result.stdout}`,
    );
  }
  return { ...result, payload: JSON.parse(result.stdout) };
}

function runCliAllowFailure(commandArgs, runtimeRoot, extraEnv = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...commandArgs], {
    cwd: projectRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...extraEnv,
      MARROW_ROOT: runtimeRoot,
    },
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

function gitOutput(commandArgs) {
  const result = spawnSync("git", commandArgs, { cwd: projectRoot, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr.trim());
  return result.stdout.trim();
}

async function fileEvidence(paths) {
  return Promise.all(
    paths.map(async (path) => {
      const details = await stat(path);
      return {
        path,
        exists: true,
        sha256: await fingerprint(path),
        mtime_ms: details.mtimeMs,
        size_bytes: details.size,
      };
    }),
  );
}

function normalizeEvidence(entries, runtimeRoot) {
  return entries.map((entry) => ({ ...entry, path: relative(runtimeRoot, entry.path) }));
}

function sameEvidence(left, right) {
  return (
    left.length === right.length &&
    left.every(
      (entry, index) =>
        entry.sha256 === right[index]?.sha256 &&
        entry.mtime_ms === right[index]?.mtime_ms &&
        entry.size_bytes === right[index]?.size_bytes,
    )
  );
}

async function fingerprint(path) {
  return `sha256:${createHash("sha256")
    .update(await readFile(path))
    .digest("hex")}`;
}

async function readJsonl(path) {
  return (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function listBatchNames(runtimeRoot) {
  return (
    await readdir(join(runtimeRoot, "reports", "llm-learning-review-batches")).catch(() => [])
  ).sort();
}

async function fileExists(path) {
  return stat(path)
    .then(() => true)
    .catch(() => false);
}

function parseOption(flag) {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return resolve(value);
}

function formatSummary(proof) {
  const deterministic = proof.deterministic;
  const live = proof.live;
  return `# Exactly-once reviewed-memory application proof

- Generated: ${proof.generated_at}
- Git SHA: \`${proof.git_sha}\`
- Verdict: **${proof.success ? "PASS" : "FAIL"}**

## Commands

\`\`\`bash
mise x node@22.22.2 -- npm run build
OPENROUTER_API_KEY=<secret> mise x node@22.22.2 -- node scripts/proof-review-apply-exactly-once.mjs --live
\`\`\`

## Deterministic sandbox

- Duplicate apply: \`no_op=${deterministic.duplicate_apply.no_op}\`; reviewed output and bundle hashes, sizes, and modification times unchanged: \`${deterministic.duplicate_apply.outputs_unchanged}\`; receipt recreated: \`${deterministic.duplicate_apply.receipt_recreated}\`.
- Skipped generation: reason \`${deterministic.skipped_generation.skip_reason}\`; no new batch, apply-ledger change, or reviewed-output timestamp change: \`${deterministic.skipped_generation.state_unchanged}\`.
- Interrupted retry: exit \`${deterministic.interrupted_retry.simulated_failure_exit_code}\`; transitions \`${deterministic.interrupted_retry.ledger_transitions.join(" -> ")}\`; converged with identical output hashes: \`${deterministic.interrupted_retry.converged}\`.
- Reviewed files: ${deterministic.reviewed_file_count}; reviewed learnings: ${deterministic.reviewed_learning_count}.

## Bounded live provider batch

- Status: \`${live.status}\`
- Model: \`${live.model ?? "not run"}\`
- Reviewed: ${live.reviewed_count ?? 0}; accepted: ${live.accepted_count ?? 0}; applied: ${live.applied_learning_count ?? 0}.
- Batch files: ${live.batch_file_count ?? 0}; exact generated batch applied: \`${live.exact_batch_applied ?? false}\`.
- Limits: count \`${live.budget?.max_per ?? "n/a"}\`; spend \`${live.budget?.max_usd ?? "n/a"}\`.
- Ledger: \`${live.ledger_transitions?.join(" -> ") ?? "not run"}\`.

The live proof uses an isolated runtime and one pending fixture learning. It neither reads nor mutates unrelated reviewed memory. Secret values are not included in this artifact.
`;
}
