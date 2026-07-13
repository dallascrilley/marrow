import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { executeStorageParsedCleanup } from "../dist/commands/storage-parsed-cleanup.js";
import { runtimeRootOverrideEnvVar } from "../dist/config/paths.js";
import {
  createLedger,
  transitionPhase,
  upsertDeletionCandidate,
  upsertSourceSession,
} from "../dist/db/ledger.js";
import { sourceSessionFixture } from "../dist/models/canonical.js";
import { ParsedIntermediateCleanupError } from "../dist/pipeline/parsed-cleanup.js";
import { listRuntimeLifecycleInventory } from "../dist/read/lifecycle-inventory.js";
import { getProjectKnowledgeSessionPath } from "../dist/writers/knowledge-writer.js";
import { getSessionManifestPathForRevision } from "../dist/writers/manifest-writer.js";
import { getRetentionReceiptPath } from "../dist/writers/report-writer.js";
import {
  getSessionSummaryJsonPath,
  getSessionSummaryMarkdownPath,
} from "../dist/writers/summary-writer.js";

const oldDate = new Date("2026-05-01T12:00:00.000Z");
const now = new Date("2026-07-12T12:00:00.000Z");

async function withRuntimeRoot(run) {
  const previousRoot = process.env[runtimeRootOverrideEnvVar];
  const runtimeRoot = await mkdtemp(join(tmpdir(), "asd-parsed-cleanup-"));
  process.env[runtimeRootOverrideEnvVar] = runtimeRoot;

  try {
    await run(runtimeRoot);
  } finally {
    if (previousRoot === undefined) {
      delete process.env[runtimeRootOverrideEnvVar];
    } else {
      process.env[runtimeRootOverrideEnvVar] = previousRoot;
    }
    await rm(runtimeRoot, { force: true, recursive: true });
  }
}

function session(sessionId, ingestStatus = "archived") {
  return {
    ...sourceSessionFixture,
    conversation_id: `parsed-cleanup:${sessionId}`,
    ingest_status: ingestStatus,
    project_key: "parsed-cleanup-project",
    session_id: sessionId,
    source_hash: `sha256:${sessionId}`,
  };
}

async function writeOldFile(path, contents) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, contents, "utf8");
  await utimes(path, oldDate, oldDate);
}

async function makeSafeCandidate(database, sessionId, parsedContents, modifiedAt) {
  const source = upsertSourceSession(database, session(sessionId)).sourceSession;
  upsertDeletionCandidate(database, {
    candidateState: "ready",
    currentLifecycleState: "archived",
    projectKey: source.project_key,
    reason: "Durable summary, manifest, and retention receipt are present.",
    safeToDelete: true,
    sessionId: source.session_id,
    sourceHash: source.source_hash,
    sourceSessionId: source.id,
  });
  const parsedPath = join(
    process.env[runtimeRootOverrideEnvVar],
    "staging",
    source.session_id,
    "parsed-records.json",
  );
  await Promise.all([
    writeFileAt(parsedPath, parsedContents, modifiedAt),
    writeFileAt(
      getProjectKnowledgeSessionPath(source.project_key, source.session_id),
      "{}\n",
      modifiedAt,
    ),
    writeFileAt(
      getSessionManifestPathForRevision(source.session_id, source.source_hash),
      "{}\n",
      modifiedAt,
    ),
    writeFileAt(getRetentionReceiptPath(source.session_id), "{}\n", modifiedAt),
    writeFileAt(getSessionSummaryJsonPath(source.session_id), "{}\n", modifiedAt),
    writeFileAt(getSessionSummaryMarkdownPath(source.session_id), "summary\n", modifiedAt),
  ]);
  return parsedPath;
}

async function writeFileAt(path, contents, modifiedAt) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, contents, "utf8");
  await utimes(path, modifiedAt, modifiedAt);
}

async function runCleanup(database, args, dependencies = {}) {
  const output = [];
  const exitCode = await executeStorageParsedCleanup(
    {
      args,
      commandPath: ["storage", "cleanup-parsed"],
      output: { error: (message) => output.push(message), info: (message) => output.push(message) },
    },
    database,
    { now, ...dependencies },
  );
  return { exitCode, payload: JSON.parse(output.join("\n")) };
}

test("parsed cleanup dry-runs only old safe candidates and apply preserves reduced artifacts", async () => {
  await withRuntimeRoot(async (runtimeRoot) => {
    const database = await createLedger();
    try {
      const ready = upsertSourceSession(database, session("ready")).sourceSession;
      const stale = upsertSourceSession(database, session("stale", "parsed")).sourceSession;
      upsertSourceSession(database, session("incomplete", "parsed"));
      transitionPhase(database, {
        phaseName: "parsed",
        phaseState: "stale",
        sourceSessionId: stale.id,
      });
      upsertDeletionCandidate(database, {
        candidateState: "ready",
        currentLifecycleState: "archived",
        projectKey: ready.project_key,
        reason: "Durable summary, manifest, and retention receipt are present.",
        safeToDelete: true,
        sessionId: ready.session_id,
        sourceHash: ready.source_hash,
        sourceSessionId: ready.id,
      });
      upsertDeletionCandidate(database, {
        candidateState: "ready",
        currentLifecycleState: "archived",
        projectKey: stale.project_key,
        reason: "Must not override stale recovery safety.",
        safeToDelete: true,
        sessionId: stale.session_id,
        sourceHash: stale.source_hash,
        sourceSessionId: stale.id,
      });

      const readyParsed = join(runtimeRoot, "staging", "ready", "parsed-records.json");
      const readyReduced = join(runtimeRoot, "staging", "ready", "reduced-session.json");
      const staleParsed = join(runtimeRoot, "staging", "stale", "parsed-records.json");
      const incompleteParsed = join(runtimeRoot, "staging", "incomplete", "parsed-records.json");
      const unknownParsed = join(runtimeRoot, "staging", "unknown", "parsed-records.json");
      const nestedParsed = join(runtimeRoot, "staging", "ready", "recovery", "parsed-records.json");
      await Promise.all([
        writeOldFile(readyParsed, "ready parsed"),
        writeOldFile(readyReduced, "ready reduced"),
        writeOldFile(staleParsed, "stale parsed"),
        writeOldFile(incompleteParsed, "incomplete parsed"),
        writeOldFile(unknownParsed, "unknown parsed"),
        writeOldFile(nestedParsed, "nested parsed"),
        writeOldFile(getProjectKnowledgeSessionPath(ready.project_key, ready.session_id), "{}\n"),
        writeOldFile(
          getSessionManifestPathForRevision(ready.session_id, ready.source_hash),
          "{}\n",
        ),
        writeOldFile(getRetentionReceiptPath(ready.session_id), "{}\n"),
        writeOldFile(getSessionSummaryJsonPath(ready.session_id), "{}\n"),
        writeOldFile(getSessionSummaryMarkdownPath(ready.session_id), "summary\n"),
      ]);

      const dryRun = await runCleanup(database, []);
      assert.equal(dryRun.exitCode, 0);
      assert.equal(dryRun.payload.apply, false);
      assert.equal(dryRun.payload.candidates.length, 1);
      const readyMetadata = await stat(readyParsed);
      assert.deepEqual(dryRun.payload.candidates[0], {
        bytes: Buffer.byteLength("ready parsed"),
        device: readyMetadata.dev,
        inode: readyMetadata.ino,
        lifecycle_state: "archived",
        modified_at: oldDate.toISOString(),
        path: readyParsed,
        reason:
          "Parsed intermediate has durable downstream retention artifacts confirmed by a safe deletion candidate.",
        session_id: "ready",
      });
      await access(readyParsed);

      const applied = await runCleanup(database, ["--apply"]);
      assert.equal(applied.exitCode, 0);
      assert.equal(applied.payload.apply, true);
      assert.equal(applied.payload.deleted.length, 1);
      assert.equal(applied.payload.deleted[0].path, readyParsed);
      await assert.rejects(access(readyParsed), { code: "ENOENT" });
      await access(readyReduced);
      await access(staleParsed);
      await access(nestedParsed);
      await access(incompleteParsed);
      await access(unknownParsed);
      const receipt = JSON.parse(await readFile(applied.payload.receipt_path, "utf8"));
      assert.equal(receipt.status, "completed");
      assert.deepEqual(receipt.deleted_paths, [readyParsed]);

      const rerun = await runCleanup(database, ["--apply"]);
      assert.deepEqual(rerun.payload.deleted, []);
      const inventory = await listRuntimeLifecycleInventory(database, { now });
      assert.equal(
        inventory.artifacts.some((item) => item.kind === "staging_reduced" && item.count === 1),
        true,
      );
    } finally {
      database.close();
    }
  });
});

test("parsed cleanup rejects a safe candidate after required retention artifacts disappear", async () => {
  await withRuntimeRoot(async (runtimeRoot) => {
    const database = await createLedger();
    try {
      const source = upsertSourceSession(database, session("missing-artifacts")).sourceSession;
      upsertDeletionCandidate(database, {
        candidateState: "ready",
        currentLifecycleState: "archived",
        projectKey: source.project_key,
        reason: "Candidate was safe before durable artifacts disappeared.",
        safeToDelete: true,
        sessionId: source.session_id,
        sourceHash: source.source_hash,
        sourceSessionId: source.id,
      });
      const parsedPath = join(runtimeRoot, "staging", source.session_id, "parsed-records.json");
      await writeOldFile(parsedPath, "still not safe");

      const dryRun = await runCleanup(database, []);
      assert.deepEqual(dryRun.payload.candidates, []);
      await access(parsedPath);
    } finally {
      database.close();
    }
  });
});

test("parsed cleanup enforces a byte ceiling oldest-first even below the age threshold", async () => {
  await withRuntimeRoot(async () => {
    const database = await createLedger();
    try {
      const oldest = await makeSafeCandidate(
        database,
        "oldest",
        "12345",
        new Date("2026-07-10T12:00:00.000Z"),
      );
      const middle = await makeSafeCandidate(
        database,
        "middle",
        "12345",
        new Date("2026-07-11T12:00:00.000Z"),
      );
      const newest = await makeSafeCandidate(database, "newest", "12345", now);

      const dryRun = await runCleanup(database, [
        "--older-than-days",
        "30",
        "--max-total-bytes",
        "8",
      ]);
      assert.equal(dryRun.payload.max_total_bytes, 8);
      assert.deepEqual(
        dryRun.payload.candidates.map((candidate) => candidate.path),
        [oldest, middle],
      );

      const applied = await runCleanup(database, [
        "--apply",
        "--older-than-days",
        "30",
        "--max-total-bytes",
        "8",
      ]);
      assert.deepEqual(
        applied.payload.deleted.map((candidate) => candidate.path),
        [oldest, middle],
      );
      await assert.rejects(access(oldest), { code: "ENOENT" });
      await assert.rejects(access(middle), { code: "ENOENT" });
      await access(newest);
    } finally {
      database.close();
    }
  });
});

test("parsed cleanup failure receipt records partial deletion and restores quarantine", async () => {
  await withRuntimeRoot(async (runtimeRoot) => {
    const database = await createLedger();
    try {
      const first = await makeSafeCandidate(database, "failure-first", "12345", oldDate);
      const second = await makeSafeCandidate(
        database,
        "failure-second",
        "12345",
        new Date(oldDate.getTime() + 1000),
      );
      let unlinkCalls = 0;
      const fileSystem = {
        access,
        rename,
        stat,
        unlink: async (path) => {
          unlinkCalls += 1;
          if (unlinkCalls === 2) {
            throw new Error("injected unlink failure");
          }
          await unlink(path);
        },
      };

      await assert.rejects(
        runCleanup(database, ["--apply"], { fileSystem }),
        (error) =>
          error instanceof ParsedIntermediateCleanupError &&
          error.message === "injected unlink failure",
      );

      await assert.rejects(access(first), { code: "ENOENT" });
      await access(second);
      const receiptPath = join(
        runtimeRoot,
        "deletes",
        "receipts",
        `parsed-cleanup-${now.toISOString().replaceAll(":", "-")}.json`,
      );
      const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
      assert.equal(receipt.status, "failed");
      assert.deepEqual(receipt.deleted_paths, [first]);
      assert.deepEqual(receipt.quarantined_paths, []);
    } finally {
      database.close();
    }
  });
});

test("parsed cleanup rejects unknown options and requires an explicit apply flag", async () => {
  await withRuntimeRoot(async () => {
    const database = await createLedger();
    try {
      await assert.rejects(
        runCleanup(database, ["--unknown"]),
        /Unknown storage cleanup-parsed option/,
      );
    } finally {
      database.close();
    }
  });
});
