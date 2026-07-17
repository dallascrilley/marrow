import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  access,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { executeStorageParsedCleanup } from "../dist/commands/storage-parsed-cleanup.js";
import { runtimeRootOverrideEnvVar } from "../dist/config/paths.js";
import {
  createLedger,
  transitionPhase,
  upsertDeletionCandidate,
  upsertSourceSession,
} from "../dist/db/ledger.js";
import { sourceSessionFixture } from "../dist/models/canonical.js";
import {
  applyParsedIntermediateCleanup,
  ParsedIntermediateCleanupError,
  planParsedIntermediateCleanupQuarantines,
} from "../dist/pipeline/parsed-cleanup.js";
import { applyParsedIntermediateCleanupWithReceipt } from "../dist/pipeline/parsed-cleanup-receipts.js";
import {
  listParsedIntermediateCleanupCandidates,
  listParsedIntermediateCleanupCandidatesForSessions,
  listRuntimeLifecycleInventory,
  selectParsedIntermediateCleanupCandidateSnapshot,
} from "../dist/read/lifecycle-inventory.js";
import { getProjectKnowledgeSessionPath } from "../dist/writers/knowledge-writer.js";
import { getSessionManifestPathForRevision } from "../dist/writers/manifest-writer.js";
import { getRetentionReceiptPath } from "../dist/writers/report-writer.js";
import {
  getSessionSummaryJsonPath,
  getSessionSummaryMarkdownPath,
} from "../dist/writers/summary-writer.js";

const oldDate = new Date("2026-05-01T12:00:00.000Z");
const now = new Date("2026-07-12T12:00:00.000Z");
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const parsedCleanupHelper = join(projectRoot, "scripts", "parsed-cleanup-fs.py");

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

async function readCleanupReceipts(runtimeRoot) {
  const receiptDirectory = join(runtimeRoot, "deletes", "receipts");
  const names = await readdir(receiptDirectory).catch(() => []);
  return Promise.all(
    names
      .filter((name) => /^parsed-cleanup-.+\.json$/.test(name))
      .sort()
      .map(async (name) => JSON.parse(await readFile(join(receiptDirectory, name), "utf8"))),
  );
}

async function writePendingCleanupReceipt(runtimeRoot, name, candidate, quarantines) {
  const receiptPath = join(runtimeRoot, "deletes", "receipts", name);
  await mkdir(dirname(receiptPath), { recursive: true });
  await writeFile(
    receiptPath,
    `${JSON.stringify({
      candidates: [candidate],
      created_at: now.toISOString(),
      deleted_paths: [],
      max_total_bytes: null,
      older_than_days: 0,
      pending_retry_count: 0,
      quarantines,
      receipt_path: receiptPath,
      retried_by: null,
      skipped_paths: [],
      status: "failed",
    })}\n`,
    "utf8",
  );
  return receiptPath;
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
      const readyExactMetadata = await lstat(readyParsed, { bigint: true });
      assert.deepEqual(dryRun.payload.candidates[0], {
        bytes: Buffer.byteLength("ready parsed"),
        device: readyMetadata.dev,
        inode: readyMetadata.ino,
        lifecycle_state: "archived",
        modified_at: oldDate.toISOString(),
        modified_at_nanoseconds: readyExactMetadata.mtimeNs.toString(),
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

test("parsed cleanup failure receipt records partial deletion and retains quarantine", async () => {
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
      await assert.rejects(access(second), { code: "ENOENT" });
      const receipts = await readCleanupReceipts(runtimeRoot);
      const receipt = receipts.find((entry) => entry.status === "failed");
      assert.ok(receipt);
      assert.equal(receipt.status, "failed");
      assert.equal(receipt.deleted_paths.length, 1);
      assert.equal(receipt.quarantines.length, 1);
      assert.deepEqual(
        new Set([receipt.deleted_paths[0], receipt.quarantines[0].original_path]),
        new Set([first, second]),
      );
      assert.equal(await readFile(receipt.quarantines[0].quarantine_path, "utf8"), "12345");

      const retry = await runCleanup(database, ["--apply"]);
      assert.deepEqual(
        retry.payload.deleted.map((candidate) => candidate.path),
        [receipt.quarantines[0].original_path],
      );
      await assert.rejects(access(receipt.quarantines[0].quarantine_path), { code: "ENOENT" });
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

test("session-scoped selection inspects only exact session paths", async () => {
  await withRuntimeRoot(async (runtimeRoot) => {
    const database = await createLedger();
    try {
      const target = await makeSafeCandidate(database, "exact-target", "target", oldDate);
      await makeSafeCandidate(database, "unrelated-safe", "other", oldDate);
      for (let index = 0; index < 250; index += 1) {
        await writeOldFile(join(runtimeRoot, "reports", `unrelated-${index}.json`), "{}\n");
      }

      let lstatCalls = 0;
      const candidates = await listParsedIntermediateCleanupCandidatesForSessions(
        database,
        ["exact-target"],
        { now, olderThanDays: 0 },
        {
          access,
          lstat: async (path) => {
            lstatCalls += 1;
            return lstat(path);
          },
          realpath,
          stat,
        },
      );

      assert.deepEqual(
        candidates.map((candidate) => candidate.path),
        [target],
      );
      assert.equal(
        lstatCalls,
        2,
        "exact-session selection must inspect only the candidate and its session directory",
      );
    } finally {
      database.close();
    }
  });
});

test("apply revalidates one immutable candidate snapshot in linear work", async () => {
  await withRuntimeRoot(async () => {
    const database = await createLedger();
    try {
      for (let index = 0; index < 24; index += 1) {
        await makeSafeCandidate(database, `scale-${index}`, "12345", oldDate);
      }
      const snapshot = await listParsedIntermediateCleanupCandidates(database, {
        now,
        olderThanDays: 0,
      });
      let renameCalls = 0;
      let lstatCalls = 0;
      let quarantineLookupCalls = 0;
      let latePath;
      const result = await applyParsedIntermediateCleanup(
        database,
        snapshot,
        {
          access,
          link,
          lstat: async (path) => {
            lstatCalls += 1;
            return lstat(path);
          },
          realpath,
          onQuarantineLookup: () => {
            quarantineLookupCalls += 1;
          },
          rename: async (from, to) => {
            renameCalls += 1;
            if (renameCalls === 1) {
              latePath = await makeSafeCandidate(database, "late-candidate", "late", oldDate);
            }
            await rename(from, to);
          },
          stat,
          unlink,
        },
        planParsedIntermediateCleanupQuarantines(snapshot),
      );

      assert.equal(result.deleted.length, snapshot.length);
      assert.equal(
        lstatCalls <= snapshot.length * 12,
        true,
        "each snapshot path gets a bounded number of direct no-follow checks",
      );
      assert.equal(
        quarantineLookupCalls,
        snapshot.length,
        "each snapshot path performs one indexed quarantine lookup",
      );
      assert.ok(latePath);
      await access(latePath);
      assert.equal(
        result.candidates.some((candidate) => candidate.path === latePath),
        false,
      );
    } finally {
      database.close();
    }
  });
});

test("byte-ceiling selection visits a linear multiple of candidates", () => {
  const candidateCount = 257;
  const candidates = Array.from({ length: candidateCount }, (_, index) => ({
    bytes: 1,
    device: 1,
    inode: index + 1,
    lifecycle_state: "archived",
    modified_at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    path: `/runtime/staging/linear-${index}/parsed-records.json`,
    reason: "linear selection test",
    session_id: `linear-${index}`,
  })).reverse();
  let visits = 0;

  const selected = selectParsedIntermediateCleanupCandidateSnapshot(
    candidates,
    { maxTotalBytes: 128, now, olderThanDays: 3650 },
    { onVisit: () => (visits += 1) },
  );

  assert.equal(selected.length, 129);
  assert.deepEqual(
    new Set(selected.map((candidate) => candidate.session_id)),
    new Set(Array.from({ length: 129 }, (_, index) => `linear-${index}`)),
  );
  assert.ok(visits <= candidateCount * 8, `expected linear visits, observed ${visits}`);
});

test("applying receipt freezes candidates before mutation", async () => {
  await withRuntimeRoot(async (runtimeRoot) => {
    const database = await createLedger();
    try {
      const original = await makeSafeCandidate(database, "receipt-original", "old", oldDate);
      let latePath;
      const applied = await runCleanup(database, ["--apply"], {
        fileSystem: {
          access,
          rename: async (from, to) => {
            latePath = await makeSafeCandidate(database, "receipt-late", "late", oldDate);
            await rename(from, to);
          },
          stat,
          unlink,
        },
      });

      assert.deepEqual(
        applied.payload.deleted.map((candidate) => candidate.path),
        [original],
      );
      assert.ok(latePath);
      await access(latePath);
      const receipts = await readCleanupReceipts(runtimeRoot);
      const receipt = receipts.find((entry) => entry.receipt_path === applied.payload.receipt_path);
      assert.ok(receipt);
      assert.deepEqual(
        receipt.candidates.map((candidate) => candidate.path),
        [original],
      );
      assert.equal(receipt.created_at, now.toISOString());
    } finally {
      database.close();
    }
  });
});

test("restart recovery retains quarantine on replacement conflict and never overwrites", async () => {
  await withRuntimeRoot(async (runtimeRoot) => {
    const database = await createLedger();
    try {
      const original = await makeSafeCandidate(
        database,
        "quarantine-conflict",
        "original",
        oldDate,
      );
      await assert.rejects(
        runCleanup(database, ["--apply"], {
          fileSystem: {
            access,
            rename,
            stat,
            unlink: async () => {
              await writeFile(original, "replacement", "utf8");
              throw new Error("injected cleanup failure");
            },
          },
        }),
        (error) =>
          error instanceof ParsedIntermediateCleanupError &&
          error.message === "injected cleanup failure",
      );

      const failedReceipts = await readCleanupReceipts(runtimeRoot);
      const failed = failedReceipts.find((receipt) => receipt.status === "failed");
      assert.ok(failed);
      assert.equal(failed.quarantines.length, 1);
      assert.deepEqual(Object.keys(failed.quarantines[0]).sort(), [
        "original_path",
        "quarantine_directory_device",
        "quarantine_directory_inode",
        "quarantine_path",
      ]);
      assert.equal(failed.quarantines[0].original_path, original);
      await access(failed.quarantines[0].quarantine_path);
      assert.equal(await readFile(original, "utf8"), "replacement");

      await assert.rejects(
        runCleanup(database, ["--apply", "--older-than-days", "30"]),
        /quarantine recovery conflict/,
      );
      assert.equal(await readFile(original, "utf8"), "replacement");
      await access(failed.quarantines[0].quarantine_path);

      await unlink(original);
      const recovered = await runCleanup(database, ["--apply", "--older-than-days", "30"]);
      assert.deepEqual(
        recovered.payload.deleted.map((candidate) => candidate.path),
        [original],
      );
      await assert.rejects(access(original), { code: "ENOENT" });
      await assert.rejects(access(failed.quarantines[0].quarantine_path), { code: "ENOENT" });
    } finally {
      database.close();
    }
  });
});

test("failed recent candidate retries immediately despite the 30-day ordinary age gate", async () => {
  await withRuntimeRoot(async (runtimeRoot) => {
    const database = await createLedger();
    try {
      const recent = await makeSafeCandidate(database, "pending-retry", "recent", now);
      await assert.rejects(
        runCleanup(database, ["--apply", "--older-than-days", "0"], {
          fileSystem: {
            access,
            rename,
            stat,
            unlink: async () => {
              throw new Error("transient unlink failure");
            },
          },
        }),
        /transient unlink failure/,
      );
      await assert.rejects(access(recent), { code: "ENOENT" });
      const pending = (await readCleanupReceipts(runtimeRoot)).find(
        (receipt) => receipt.status === "failed",
      );
      assert.ok(pending);
      assert.equal(await readFile(pending.quarantines[0].quarantine_path, "utf8"), "recent");

      const retried = await runCleanup(database, ["--apply", "--older-than-days", "30"]);
      assert.deepEqual(
        retried.payload.deleted.map((candidate) => candidate.path),
        [recent],
      );
      assert.equal(retried.payload.pending_retry_count, 1);
      await assert.rejects(access(recent), { code: "ENOENT" });

      const afterRetry = await runCleanup(database, ["--older-than-days", "30"]);
      assert.equal(afterRetry.payload.pending_retry_count, 0);
      assert.deepEqual(afterRetry.payload.candidates, []);

      const receipts = await readCleanupReceipts(runtimeRoot);
      const failed = receipts.find((receipt) => receipt.status === "failed");
      assert.ok(failed);
      assert.equal(failed.retried_by, retried.payload.receipt_path);
    } finally {
      database.close();
    }
  });
});

test("pending retry retains quarantine and preserves a later replacement at the same path", async () => {
  await withRuntimeRoot(async () => {
    const database = await createLedger();
    try {
      const original = await makeSafeCandidate(database, "pending-replacement", "old", oldDate);
      await assert.rejects(
        runCleanup(database, ["--apply"], {
          fileSystem: {
            access,
            rename,
            stat,
            unlink: async () => {
              throw new Error("seed pending retry");
            },
          },
        }),
        /seed pending retry/,
      );

      await writeFile(original, "later replacement", "utf8");
      await utimes(original, oldDate, oldDate);
      await assert.rejects(
        runCleanup(database, ["--apply", "--older-than-days", "0"]),
        /quarantine recovery conflict/,
      );
      assert.equal(await readFile(original, "utf8"), "later replacement");

      const failed = (await readCleanupReceipts(process.env[runtimeRootOverrideEnvVar])).filter(
        (receipt) => receipt.status === "failed" && receipt.retried_by === null,
      );
      const active = failed.at(-1);
      assert.ok(active);
      assert.equal(await readFile(active.quarantines[0].quarantine_path, "utf8"), "old");

      await unlink(original);
      const recovered = await runCleanup(database, ["--apply", "--older-than-days", "30"]);
      assert.deepEqual(
        recovered.payload.deleted.map((candidate) => candidate.path),
        [original],
      );
    } finally {
      database.close();
    }
  });
});

test("restart recovery rejects quarantine names not owned by parsed cleanup", async () => {
  await withRuntimeRoot(async (runtimeRoot) => {
    const database = await createLedger();
    try {
      const original = await makeSafeCandidate(database, "foreign-quarantine", "keep", oldDate);
      const [candidate] = await listParsedIntermediateCleanupCandidates(database, {
        now,
        olderThanDays: 0,
      });
      assert.ok(candidate);
      const receiptPath = join(
        runtimeRoot,
        "deletes",
        "receipts",
        "parsed-cleanup-foreign-quarantine.json",
      );
      await mkdir(join(runtimeRoot, "deletes", "receipts"), { recursive: true });
      await writeFile(
        receiptPath,
        JSON.stringify({
          candidates: [candidate],
          created_at: now.toISOString(),
          deleted_paths: [],
          max_total_bytes: null,
          older_than_days: 0,
          pending_retry_count: 1,
          quarantines: [
            {
              original_path: original,
              quarantine_path: `${original}.foreign.quarantine`,
            },
          ],
          receipt_path: receiptPath,
          skipped_paths: [],
          status: "failed",
        }),
        "utf8",
      );

      await assert.rejects(runCleanup(database, ["--apply"]), /unrecognized.*quarantine mapping/);
      assert.equal(await readFile(original, "utf8"), "keep");
    } finally {
      database.close();
    }
  });
});

test("restart recovery atomically refuses a replacement created during recovery", async () => {
  await withRuntimeRoot(async (runtimeRoot) => {
    const database = await createLedger();
    try {
      const original = await makeSafeCandidate(database, "restore-race", "source", oldDate);
      await assert.rejects(
        runCleanup(database, ["--apply"], {
          fileSystem: {
            access,
            link,
            lstat,
            realpath,
            rename,
            stat,
            unlink: async () => {
              throw new Error("seed recoverable quarantine");
            },
          },
        }),
        /seed recoverable quarantine/,
      );

      const failed = (await readCleanupReceipts(runtimeRoot)).find(
        (receipt) => receipt.status === "failed",
      );
      assert.ok(failed);
      const mapping = failed.quarantines[0];
      assert.ok(mapping);

      let replacementInjected = false;
      const injectReplacement = async () => {
        if (!replacementInjected) {
          replacementInjected = true;
          await writeFile(original, "replacement created in restore gap", "utf8");
        }
      };
      await assert.rejects(
        runCleanup(database, ["--apply", "--older-than-days", "30"], {
          fileSystem: {
            access,
            link,
            lstat: async (path) => {
              if (path === original) {
                await injectReplacement();
              }
              return lstat(path);
            },
            realpath,
            rename,
            stat,
            unlink,
          },
        }),
        /quarantine recovery conflict/,
      );

      assert.equal(await readFile(original, "utf8"), "replacement created in restore gap");
      assert.equal(await readFile(mapping.quarantine_path, "utf8"), "source");
    } finally {
      database.close();
    }
  });
});

test("restart recovery converges when original and quarantine share identity", async () => {
  await withRuntimeRoot(async (runtimeRoot) => {
    const database = await createLedger();
    try {
      const original = await makeSafeCandidate(database, "restore-linked", "source", oldDate);
      const [candidate] = await listParsedIntermediateCleanupCandidates(database, {
        now,
        olderThanDays: 0,
      });
      assert.ok(candidate);
      const [mapping] = planParsedIntermediateCleanupQuarantines([candidate]);
      assert.ok(mapping);
      await mkdir(dirname(mapping.quarantine_path), { recursive: true });
      await rename(original, mapping.quarantine_path);
      await link(mapping.quarantine_path, original);
      const receiptPath = join(
        runtimeRoot,
        "deletes",
        "receipts",
        "parsed-cleanup-linked-restore.json",
      );
      await mkdir(dirname(receiptPath), { recursive: true });
      await writeFile(
        receiptPath,
        JSON.stringify({
          candidates: [candidate],
          created_at: now.toISOString(),
          deleted_paths: [],
          max_total_bytes: null,
          older_than_days: 0,
          pending_retry_count: 1,
          quarantines: [mapping],
          receipt_path: receiptPath,
          retried_by: null,
          skipped_paths: [],
          status: "applying",
        }),
        "utf8",
      );

      const result = await runCleanup(database, ["--apply", "--older-than-days", "30"]);
      assert.deepEqual(
        result.payload.deleted.map((item) => item.path),
        [original],
      );
      await assert.rejects(access(original), { code: "ENOENT" });
      await assert.rejects(access(mapping.quarantine_path), { code: "ENOENT" });
    } finally {
      database.close();
    }
  });
});

test("applying receipt persists the planned quarantine before a crash and restart recovers it", async () => {
  await withRuntimeRoot(async (runtimeRoot) => {
    let database = await createLedger();
    const original = await makeSafeCandidate(database, "crash-after-rename", "source", oldDate);
    database.close();

    const workerSource = `
      import { access, link, lstat, realpath, rename, stat, unlink } from "node:fs/promises";
      import { executeStorageParsedCleanup } from ${JSON.stringify(new URL("../dist/commands/storage-parsed-cleanup.js", import.meta.url).href)};
      import { createLedger } from ${JSON.stringify(new URL("../dist/db/ledger.js", import.meta.url).href)};
      const database = await createLedger();
      await executeStorageParsedCleanup(
        { args: ["--apply"], commandPath: [], output: { error() {}, info() {} } },
        database,
        {
          now: new Date(${JSON.stringify(now.toISOString())}),
          fileSystem: {
            access,
            link,
            lstat,
            realpath,
            rename: async (from, to) => {
              await rename(from, to);
              process.exit(77);
            },
            stat,
            unlink,
          },
        },
      );
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", workerSource], {
      cwd: dirname(new URL(import.meta.url).pathname),
      env: { ...process.env, AGENT_SESSION_DISTILLERY_ROOT: runtimeRoot },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let childError = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      childError += chunk;
    });
    const exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    assert.equal(exitCode, 77, childError);

    const receiptsAfterCrash = await readCleanupReceipts(runtimeRoot);
    const applying = receiptsAfterCrash.find((receipt) => receipt.status === "applying");
    assert.ok(applying);
    assert.equal(applying.quarantines.length, 1);
    const mapping = applying.quarantines[0];
    assert.equal(mapping.original_path, original);
    await assert.rejects(access(original), { code: "ENOENT" });
    assert.equal(await readFile(mapping.quarantine_path, "utf8"), "source");

    database = await createLedger();
    try {
      const retry = await runCleanup(database, ["--apply", "--older-than-days", "30"]);
      assert.deepEqual(
        retry.payload.deleted.map((item) => item.path),
        [original],
      );
      const receiptsAfterRetry = await readCleanupReceipts(runtimeRoot);
      const superseded = receiptsAfterRetry.find(
        (receipt) => receipt.receipt_path === applying.receipt_path,
      );
      assert.equal(superseded.retried_by, retry.payload.receipt_path);
      await assert.rejects(access(original), { code: "ENOENT" });
      await assert.rejects(access(mapping.quarantine_path), { code: "ENOENT" });
    } finally {
      database.close();
    }
  });
});

test("exact-session selection rejects a symlinked session directory outside staging", async () => {
  await withRuntimeRoot(async (runtimeRoot) => {
    const database = await createLedger();
    try {
      const original = await makeSafeCandidate(database, "symlink-outside", "source", oldDate);
      const sessionDirectory = dirname(original);
      const outsideDirectory = join(runtimeRoot, "outside-session");
      await rename(sessionDirectory, outsideDirectory);
      await symlink(outsideDirectory, sessionDirectory, "dir");

      const candidates = await listParsedIntermediateCleanupCandidatesForSessions(
        database,
        ["symlink-outside"],
        { now, olderThanDays: 0 },
        { access, lstat, realpath, stat },
      );
      assert.deepEqual(candidates, []);
      assert.equal(await readFile(join(outsideDirectory, "parsed-records.json"), "utf8"), "source");
    } finally {
      database.close();
    }
  });
});

test("apply retains trusted quarantine if the session directory redirects after rename", async () => {
  await withRuntimeRoot(async (runtimeRoot) => {
    const database = await createLedger();
    try {
      const original = await makeSafeCandidate(database, "symlink-race", "source", oldDate);
      const [candidate] = await listParsedIntermediateCleanupCandidatesForSessions(
        database,
        ["symlink-race"],
        { now, olderThanDays: 0 },
        { access, lstat, realpath, stat },
      );
      assert.ok(candidate);
      const sessionDirectory = dirname(original);
      const outsideDirectory = join(runtimeRoot, "outside-race-session");
      const [mapping] = planParsedIntermediateCleanupQuarantines([candidate]);
      assert.ok(mapping);
      const sentinelPath = join(sessionDirectory, "sentinel.txt");
      await writeFile(sentinelPath, "untouched", "utf8");
      let redirected = false;

      await assert.rejects(
        applyParsedIntermediateCleanup(
          database,
          [candidate],
          {
            access,
            link,
            lstat,
            realpath,
            rename: async (from, to) => {
              await rename(from, to);
              if (!redirected && from === original) {
                redirected = true;
                await rename(sessionDirectory, outsideDirectory);
                await symlink(outsideDirectory, sessionDirectory, "dir");
              }
            },
            stat,
            unlink,
          },
          [mapping],
        ),
        /unsafe parsed cleanup path/,
      );

      assert.equal(await readFile(join(outsideDirectory, "sentinel.txt"), "utf8"), "untouched");
      await assert.rejects(access(join(outsideDirectory, "parsed-records.json")), {
        code: "ENOENT",
      });
      assert.equal(await readFile(mapping.quarantine_path, "utf8"), "source");
    } finally {
      database.close();
    }
  });
});

test("apply retains quarantine when the session ancestor swaps after validation", async () => {
  await withRuntimeRoot(async (runtimeRoot) => {
    const database = await createLedger();
    try {
      const original = await makeSafeCandidate(database, "ancestor-swap", "source", oldDate);
      const [candidate] = await listParsedIntermediateCleanupCandidatesForSessions(
        database,
        ["ancestor-swap"],
        { now, olderThanDays: 0 },
        { access, lstat, realpath, stat },
      );
      assert.ok(candidate);
      const [mapping] = planParsedIntermediateCleanupQuarantines([candidate]);
      assert.ok(mapping);
      const sessionDirectory = dirname(original);
      const relocatedDirectory = join(runtimeRoot, "outside-after-validation");
      const sentinelPath = join(sessionDirectory, "outside-sentinel.txt");
      await writeFile(sentinelPath, "untouched", "utf8");
      let sessionRealpathCalls = 0;

      await assert.rejects(
        applyParsedIntermediateCleanup(
          database,
          [candidate],
          {
            access,
            link,
            lstat,
            realpath: async (path) => {
              const resolved = await realpath(path);
              if (path === sessionDirectory) {
                sessionRealpathCalls += 1;
                if (sessionRealpathCalls === 3) {
                  await rename(sessionDirectory, relocatedDirectory);
                  await symlink(relocatedDirectory, sessionDirectory, "dir");
                }
              }
              return resolved;
            },
            rename,
            stat,
            unlink,
          },
          [mapping],
        ),
        (error) => {
          assert.ok(error instanceof ParsedIntermediateCleanupError);
          assert.match(error.message, /unsafe parsed cleanup path/);
          assert.equal(error.result.quarantines.length, 1);
          assert.equal(error.result.quarantines[0].original_path, mapping.original_path);
          assert.equal(error.result.quarantines[0].quarantine_path, mapping.quarantine_path);
          assert.equal(typeof error.result.quarantines[0].quarantine_directory_device, "number");
          assert.equal(typeof error.result.quarantines[0].quarantine_directory_inode, "number");
          return true;
        },
      );

      assert.equal(
        await readFile(join(relocatedDirectory, "outside-sentinel.txt"), "utf8"),
        "untouched",
      );
      assert.equal(await readFile(mapping.quarantine_path, "utf8"), "source");
    } finally {
      database.close();
    }
  });
});

test("pending recovery refuses a symlinked session ancestor without touching outside files", async () => {
  await withRuntimeRoot(async (runtimeRoot) => {
    const database = await createLedger();
    try {
      const original = await makeSafeCandidate(database, "pending-symlink", "source", oldDate);
      const [candidate] = await listParsedIntermediateCleanupCandidates(database, {
        now,
        olderThanDays: 0,
      });
      assert.ok(candidate);
      const sessionDirectory = dirname(original);
      const outsideDirectory = join(runtimeRoot, "outside-pending-symlink");
      const quarantinePath = `${original}.asd-cleanup-123e4567-e89b-42d3-a456-426614174000.quarantine`;
      await rm(sessionDirectory, { force: true, recursive: true });
      await mkdir(outsideDirectory, { recursive: true });
      await writeFile(
        join(outsideDirectory, quarantinePath.slice(sessionDirectory.length + 1)),
        "outside-quarantine",
        "utf8",
      );
      await symlink(outsideDirectory, sessionDirectory, "dir");

      await assert.rejects(
        applyParsedIntermediateCleanup(
          database,
          [candidate],
          { access, link, lstat, realpath, rename, stat, unlink },
          [{ original_path: original, quarantine_path: quarantinePath }],
        ),
        /unrecognized parsed cleanup quarantine mapping|unsafe parsed cleanup path/,
      );

      await assert.rejects(access(join(outsideDirectory, "parsed-records.json")), {
        code: "ENOENT",
      });
      assert.equal(
        await readFile(
          join(outsideDirectory, quarantinePath.slice(sessionDirectory.length + 1)),
          "utf8",
        ),
        "outside-quarantine",
      );
    } finally {
      database.close();
    }
  });
});

test("pending retry count reports duplicate live receipts rather than unique candidates", async () => {
  await withRuntimeRoot(async (runtimeRoot) => {
    const database = await createLedger();
    try {
      await makeSafeCandidate(database, "duplicate-live-receipts", "source", oldDate);
      const [candidate] = await listParsedIntermediateCleanupCandidates(database, {
        now,
        olderThanDays: 0,
      });
      assert.ok(candidate);
      const receiptDirectory = join(runtimeRoot, "deletes", "receipts");
      await mkdir(receiptDirectory, { recursive: true });
      for (const suffix of ["a", "b"]) {
        const receiptPath = join(receiptDirectory, `parsed-cleanup-duplicate-${suffix}.json`);
        await writeFile(
          receiptPath,
          `${JSON.stringify({
            candidates: [candidate],
            created_at: now.toISOString(),
            deleted_paths: [],
            max_total_bytes: null,
            older_than_days: 0,
            pending_retry_count: 0,
            quarantines: [],
            receipt_path: receiptPath,
            retried_by: null,
            skipped_paths: [],
            status: "failed",
          })}\n`,
          "utf8",
        );
      }

      const dryRun = await runCleanup(database, ["--older-than-days", "30"]);
      assert.equal(dryRun.payload.pending_retry_count, 2);
      assert.equal(dryRun.payload.candidates.length, 1);
    } finally {
      database.close();
    }
  });
});

test("failed completion receipt preserves the successful cleanup result", async () => {
  await withRuntimeRoot(async (runtimeRoot) => {
    const database = await createLedger();
    try {
      const original = await makeSafeCandidate(database, "receipt-finalize", "source", oldDate);
      const [candidate] = await listParsedIntermediateCleanupCandidates(database, {
        now,
        olderThanDays: 0,
      });
      assert.ok(candidate);

      await assert.rejects(
        applyParsedIntermediateCleanupWithReceipt({
          candidates: [candidate],
          createdAt: now,
          database,
          olderThanDays: 0,
          receiptWriter: async (path, receipt) => {
            if (receipt.status === "completed") {
              throw new Error("injected completed receipt failure");
            }
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
          },
        }),
        /injected completed receipt failure/,
      );

      const failed = (await readCleanupReceipts(runtimeRoot)).find(
        (receipt) => receipt.status === "failed",
      );
      assert.ok(failed);
      assert.deepEqual(failed.deleted_paths, [original]);
      assert.deepEqual(failed.quarantines, []);
      assert.deepEqual(failed.skipped_paths, []);
      await assert.rejects(access(original), { code: "ENOENT" });
    } finally {
      database.close();
    }
  });
});

test("quarantine root replacement cannot redirect descriptor-bound mutation", async () => {
  await withRuntimeRoot(async (runtimeRoot) => {
    const database = await createLedger();
    try {
      const original = await makeSafeCandidate(database, "root-swap", "source", oldDate);
      const [candidate] = await listParsedIntermediateCleanupCandidates(database, {
        now,
        olderThanDays: 0,
      });
      assert.ok(candidate);
      const [mapping] = planParsedIntermediateCleanupQuarantines([candidate]);
      assert.ok(mapping);
      const quarantineRoot = dirname(mapping.quarantine_path);
      const savedRoot = `${quarantineRoot}.saved`;
      const outsideRoot = join(runtimeRoot, "outside-quarantine-root");
      let swapped = false;
      let retainedMappings;

      await assert.rejects(
        applyParsedIntermediateCleanup(
          database,
          [candidate],
          {
            access,
            link,
            lstat,
            onQuarantineLookup: async () => {
              if (swapped) return;
              swapped = true;
              await rename(quarantineRoot, savedRoot);
              await mkdir(outsideRoot, { recursive: true });
              await symlink(outsideRoot, quarantineRoot, "dir");
            },
            open,
            realpath,
            rename,
            stat,
            unlink,
          },
          [mapping],
        ),
        (error) => {
          assert.ok(error instanceof ParsedIntermediateCleanupError);
          assert.match(error.message, /unsafe parsed cleanup path/);
          retainedMappings = error.result.quarantines;
          return true;
        },
      );

      assert.equal(swapped, true);
      await assert.rejects(access(join(outsideRoot, basename(mapping.quarantine_path))), {
        code: "ENOENT",
      });
      assert.equal(
        await readFile(join(savedRoot, basename(mapping.quarantine_path)), "utf8"),
        "source",
      );
      assert.equal(retainedMappings.length, 1);

      await unlink(quarantineRoot);
      await rename(savedRoot, quarantineRoot);
      const recovered = await applyParsedIntermediateCleanup(
        database,
        [candidate],
        undefined,
        retainedMappings,
      );
      assert.deepEqual(
        recovered.deleted.map((item) => item.path),
        [original],
      );
    } finally {
      database.close();
    }
  });
});

test("legacy sibling quarantine receipts migrate into the trusted central boundary", async () => {
  await withRuntimeRoot(async (runtimeRoot) => {
    const database = await createLedger();
    try {
      const original = await makeSafeCandidate(database, "legacy-migration", "source", oldDate);
      const [candidate] = await listParsedIntermediateCleanupCandidates(database, {
        now,
        olderThanDays: 0,
      });
      assert.ok(candidate);
      const legacyPath = `${original}.asd-cleanup-123e4567-e89b-42d3-a456-426614174000.quarantine`;
      await rename(original, legacyPath);
      const receiptPath = join(
        runtimeRoot,
        "deletes",
        "receipts",
        "parsed-cleanup-legacy-migration.json",
      );
      await mkdir(dirname(receiptPath), { recursive: true });
      await writeFile(
        receiptPath,
        `${JSON.stringify({
          candidates: [candidate],
          created_at: now.toISOString(),
          deleted_paths: [],
          max_total_bytes: null,
          older_than_days: 0,
          quarantined_paths: [legacyPath],
          skipped_paths: [],
          status: "failed",
        })}\n`,
        "utf8",
      );

      const result = await runCleanup(database, ["--apply", "--older-than-days", "30"]);
      assert.deepEqual(
        result.payload.deleted.map((item) => item.path),
        [original],
      );
      await assert.rejects(access(legacyPath), { code: "ENOENT" });
      const legacyReceipt = JSON.parse(await readFile(receiptPath, "utf8"));
      assert.ok(legacyReceipt.retried_by);
    } finally {
      database.close();
    }
  });
});

test("duplicate live mappings canonicalize to the one matching quarantine", async () => {
  await withRuntimeRoot(async (runtimeRoot) => {
    const database = await createLedger();
    try {
      const original = await makeSafeCandidate(database, "duplicate-resolved", "source", oldDate);
      const [candidate] = await listParsedIntermediateCleanupCandidates(database, {
        now,
        olderThanDays: 0,
      });
      assert.ok(candidate);
      const quarantineRoot = join(runtimeRoot, "deletes", "parsed-cleanup-quarantine");
      const first = join(quarantineRoot, "123e4567-e89b-42d3-a456-426614174000.quarantine");
      const second = join(quarantineRoot, "123e4567-e89b-42d3-a456-426614174001.quarantine");
      await mkdir(quarantineRoot, { recursive: true });
      await rename(original, first);
      await writePendingCleanupReceipt(runtimeRoot, "parsed-cleanup-duplicate-a.json", candidate, [
        { original_path: original, quarantine_path: first },
      ]);
      await writePendingCleanupReceipt(runtimeRoot, "parsed-cleanup-duplicate-b.json", candidate, [
        { original_path: original, quarantine_path: second },
      ]);
      const quarantineRootMetadata = await stat(quarantineRoot);
      await writePendingCleanupReceipt(runtimeRoot, "parsed-cleanup-duplicate-c.json", candidate, [
        {
          original_path: original,
          quarantine_directory_device: quarantineRootMetadata.dev,
          quarantine_directory_inode: quarantineRootMetadata.ino,
          quarantine_path: first,
        },
      ]);

      const result = await runCleanup(database, ["--apply", "--older-than-days", "30"]);
      assert.deepEqual(
        result.payload.deleted.map((item) => item.path),
        [original],
      );
      const oldReceipts = (await readCleanupReceipts(runtimeRoot)).filter((receipt) =>
        receipt.receipt_path?.includes("parsed-cleanup-duplicate-"),
      );
      assert.equal(oldReceipts.length, 3);
      assert.equal(
        oldReceipts.every((receipt) => receipt.retried_by === result.payload.receipt_path),
        true,
      );
    } finally {
      database.close();
    }
  });
});

test("ambiguous duplicate live mappings remain unsuperseded for operator resolution", async () => {
  await withRuntimeRoot(async (runtimeRoot) => {
    const database = await createLedger();
    try {
      const original = await makeSafeCandidate(database, "duplicate-ambiguous", "source", oldDate);
      const [candidate] = await listParsedIntermediateCleanupCandidates(database, {
        now,
        olderThanDays: 0,
      });
      assert.ok(candidate);
      const quarantineRoot = join(runtimeRoot, "deletes", "parsed-cleanup-quarantine");
      const first = join(quarantineRoot, "123e4567-e89b-42d3-a456-426614174000.quarantine");
      const second = join(quarantineRoot, "123e4567-e89b-42d3-a456-426614174001.quarantine");
      await mkdir(quarantineRoot, { recursive: true });
      await rename(original, first);
      await link(first, second);
      await writePendingCleanupReceipt(runtimeRoot, "parsed-cleanup-ambiguous-a.json", candidate, [
        { original_path: original, quarantine_path: first },
      ]);
      await writePendingCleanupReceipt(runtimeRoot, "parsed-cleanup-ambiguous-b.json", candidate, [
        { original_path: original, quarantine_path: second },
      ]);

      await assert.rejects(
        runCleanup(database, ["--apply", "--older-than-days", "30"]),
        /multiple live quarantine files/,
      );
      const receipts = await readCleanupReceipts(runtimeRoot);
      assert.equal(receipts.length, 2, "conflict must not create a superseding receipt");
      assert.equal(
        receipts.every((receipt) => receipt.retried_by === null),
        true,
      );
      assert.equal(await readFile(first, "utf8"), "source");
      assert.equal(await readFile(second, "utf8"), "source");
    } finally {
      database.close();
    }
  });
});

test("receipt applying completion and supersession writes fsync file and directory", async () => {
  await withRuntimeRoot(async (runtimeRoot) => {
    const database = await createLedger();
    try {
      const receiptDirectory = join(runtimeRoot, "deletes", "receipts");
      const previousReceipt = join(receiptDirectory, "parsed-cleanup-sync-previous.json");
      await mkdir(receiptDirectory, { recursive: true });
      await writeFile(
        previousReceipt,
        `${JSON.stringify({
          candidates: [],
          created_at: now.toISOString(),
          deleted_paths: [],
          max_total_bytes: null,
          older_than_days: 0,
          pending_retry_count: 0,
          quarantines: [],
          receipt_path: previousReceipt,
          retried_by: null,
          skipped_paths: [],
          status: "failed",
        })}\n`,
        "utf8",
      );
      let directorySyncs = 0;
      let fileSyncs = 0;
      const receiptFileSystem = {
        mkdir,
        open: async (path, flags, mode) => {
          const handle = await open(path, flags, mode);
          return new Proxy(handle, {
            get(target, property) {
              if (property === "sync") {
                return async () => {
                  if (path === receiptDirectory) directorySyncs += 1;
                  else fileSyncs += 1;
                  return target.sync();
                };
              }
              const value = Reflect.get(target, property, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        },
        rename,
        unlink,
      };

      await applyParsedIntermediateCleanupWithReceipt({
        candidates: [],
        createdAt: now,
        database,
        olderThanDays: 0,
        receiptFileSystem,
        supersedesReceiptPaths: [previousReceipt],
      });
      assert.equal(fileSyncs, 3);
      assert.equal(directorySyncs, 3);
    } finally {
      database.close();
    }
  });
});

test("missing descriptor helper fails before moving the parsed candidate", async () => {
  await withRuntimeRoot(async () => {
    const database = await createLedger();
    const previousPython = process.env.ASD_PYTHON;
    try {
      const original = await makeSafeCandidate(database, "missing-helper", "source", oldDate);
      process.env.ASD_PYTHON = "/nonexistent/asd-python";
      await assert.rejects(runCleanup(database, ["--apply"]), /ENOENT|spawn/);
      assert.equal(await readFile(original, "utf8"), "source");
    } finally {
      if (previousPython === undefined) delete process.env.ASD_PYTHON;
      else process.env.ASD_PYTHON = previousPython;
      database.close();
    }
  });
});

test("descriptor rename refuses an occupied quarantine destination without overwriting", async () => {
  await withRuntimeRoot(async () => {
    const database = await createLedger();
    try {
      const original = await makeSafeCandidate(database, "destination-conflict", "source", oldDate);
      const [candidate] = await listParsedIntermediateCleanupCandidatesForSessions(
        database,
        ["destination-conflict"],
        { now, olderThanDays: 0 },
      );
      assert.ok(candidate);
      const [mapping] = planParsedIntermediateCleanupQuarantines([candidate]);
      assert.ok(mapping);

      await assert.rejects(
        applyParsedIntermediateCleanup(
          database,
          [candidate],
          {
            access,
            onQuarantineLookup: async () => {
              await writeFile(mapping.quarantine_path, "foreign", "utf8");
            },
            rename,
            stat,
            unlink,
          },
          [mapping],
        ),
        (error) =>
          error instanceof ParsedIntermediateCleanupError && error.cause?.code === "EEXIST",
      );

      assert.equal(await readFile(original, "utf8"), "source");
      assert.equal(await readFile(mapping.quarantine_path, "utf8"), "foreign");
    } finally {
      database.close();
    }
  });
});

test("descriptor rename refuses a source parent swapped after validation", async () => {
  await withRuntimeRoot(async (runtimeRoot) => {
    const database = await createLedger();
    try {
      const original = await makeSafeCandidate(database, "source-parent-swap", "source", oldDate);
      const [candidate] = await listParsedIntermediateCleanupCandidatesForSessions(
        database,
        ["source-parent-swap"],
        { now, olderThanDays: 0 },
      );
      assert.ok(candidate);
      const [mapping] = planParsedIntermediateCleanupQuarantines([candidate]);
      assert.ok(mapping);
      const sourceDirectory = dirname(original);
      const savedDirectory = join(runtimeRoot, "saved-source-parent");

      await assert.rejects(
        applyParsedIntermediateCleanup(
          database,
          [candidate],
          {
            access,
            onQuarantineLookup: async () => {
              await rename(sourceDirectory, savedDirectory);
              await mkdir(sourceDirectory);
              await writeFile(original, "outside replacement", "utf8");
            },
            rename,
            stat,
            unlink,
          },
          [mapping],
        ),
        (error) =>
          error instanceof ParsedIntermediateCleanupError && error.cause?.code === "ESTALE",
      );

      assert.equal(await readFile(join(savedDirectory, "parsed-records.json"), "utf8"), "source");
      assert.equal(await readFile(original, "utf8"), "outside replacement");
      await assert.rejects(access(mapping.quarantine_path), { code: "ENOENT" });
    } finally {
      database.close();
    }
  });
});

test("exact nanosecond identity survives the Node timestamp rounding boundary", async () => {
  await withRuntimeRoot(async () => {
    const database = await createLedger();
    try {
      const original = await makeSafeCandidate(database, "mtime-boundary", "source", oldDate);
      const mtimeNanoseconds = "1760000000123499999";
      const python = process.env.ASD_PYTHON ?? process.env.PYTHON ?? "python3";
      const timestampResult = spawnSync(
        python,
        [
          "-c",
          "import os,sys; value=int(sys.argv[2]); os.utime(sys.argv[1], ns=(value,value))",
          original,
          mtimeNanoseconds,
        ],
        { encoding: "utf8" },
      );
      assert.equal(timestampResult.status, 0, timestampResult.stderr);
      const [candidate] = await listParsedIntermediateCleanupCandidatesForSessions(
        database,
        ["mtime-boundary"],
        { now, olderThanDays: 0 },
      );
      assert.ok(candidate);
      assert.equal(candidate.modified_at_nanoseconds, mtimeNanoseconds);

      const result = await applyParsedIntermediateCleanupWithReceipt({
        candidates: [candidate],
        createdAt: now,
        database,
        olderThanDays: 0,
      });
      assert.deepEqual(
        result.cleanup.deleted.map((item) => item.path),
        [original],
      );
    } finally {
      database.close();
    }
  });
});

test("descriptor helper fsyncs source and quarantine metadata and is packaged for runtime", async () => {
  await withRuntimeRoot(async (runtimeRoot) => {
    const sourceDirectory = join(runtimeRoot, "fsync-source");
    const quarantineDirectory = join(runtimeRoot, "fsync-quarantine");
    await mkdir(sourceDirectory, { recursive: true });
    await mkdir(quarantineDirectory, { recursive: true });
    const source = join(sourceDirectory, "parsed-records.json");
    await writeFile(source, "source", "utf8");
    const sourceMetadata = await lstat(source, { bigint: true });
    const sourceDirectoryMetadata = await lstat(sourceDirectory, { bigint: true });
    const python = process.env.ASD_PYTHON ?? process.env.PYTHON ?? "python3";
    const probe = spawnSync(
      python,
      [
        "-c",
        `import importlib.util,json,os,sys
spec=importlib.util.spec_from_file_location("parsed_cleanup_fs", sys.argv[1])
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
quarantine_fd=os.open(sys.argv[2], os.O_RDONLY | os.O_DIRECTORY)
os.dup2(quarantine_fd, 3)
calls=[]
module.os.fsync=lambda fd: calls.append(fd)
extra=json.loads(sys.argv[3])
module.execute("rename-into", "target.quarantine", extra)
module.execute("unlink", "target.quarantine")
print(json.dumps(calls))`,
        parsedCleanupHelper,
        quarantineDirectory,
        JSON.stringify({
          source_device: Number(sourceMetadata.dev),
          source_directory: sourceDirectory,
          source_directory_device: Number(sourceDirectoryMetadata.dev),
          source_directory_inode: Number(sourceDirectoryMetadata.ino),
          source_inode: Number(sourceMetadata.ino),
          source_modified_at_nanoseconds: sourceMetadata.mtimeNs.toString(),
          source_name: basename(source),
          source_size: Number(sourceMetadata.size),
        }),
      ],
      { encoding: "utf8" },
    );
    assert.equal(probe.status, 0, probe.stderr);
    const fsyncCalls = JSON.parse(probe.stdout);
    assert.equal(fsyncCalls.length, 3);
    assert.equal(fsyncCalls[1], 3);
    assert.equal(fsyncCalls[2], 3);

    const dockerfile = await readFile(join(projectRoot, "Dockerfile"), "utf8");
    const readme = await readFile(join(projectRoot, "README.md"), "utf8");
    assert.match(dockerfile, /apt-get install[^\n]*python3/);
    assert.match(dockerfile, /COPY --from=build \/app\/scripts\/parsed-cleanup-fs\.py/);
    assert.match(readme, /Python `3\.9\+`/);
  });
});
