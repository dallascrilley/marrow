import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

import {
  createLedger,
  getDeletionCandidateBySessionId,
  upsertDeletionCandidate,
  upsertSourceSession,
} from "../dist/db/ledger.js";
import { sourceSessionFixture } from "../dist/models/canonical.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(testDir);
const cliPath = join(projectRoot, "dist", "cli.js");
const cleanupScriptPath = join(projectRoot, "scripts", "cleanup-codex-sources.mjs");
const runtimeOverrideEnvVar = "MARROW_ROOT";

async function withFixture(run) {
  const root = await mkdtemp(join(tmpdir(), "marrow-delete-sources-runtime-"));
  const home = await mkdtemp(join(tmpdir(), "marrow-delete-sources-home-"));
  const previousRuntimeRoot = process.env[runtimeOverrideEnvVar];
  const previousHome = process.env.HOME;
  process.env[runtimeOverrideEnvVar] = root;
  process.env.HOME = home;

  try {
    await run({ root, home });
  } finally {
    if (previousRuntimeRoot === undefined) {
      delete process.env[runtimeOverrideEnvVar];
    } else {
      process.env[runtimeOverrideEnvVar] = previousRuntimeRoot;
    }
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
}

function runCli(args, { root, home }) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, HOME: home, [runtimeOverrideEnvVar]: root },
  });
}

function runCleanupScript(args, { root, home }) {
  return spawnSync(process.execPath, [cleanupScriptPath, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, HOME: home, [runtimeOverrideEnvVar]: root },
  });
}

function sha256(contents) {
  return `sha256:${createHash("sha256").update(contents).digest("hex")}`;
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function seedCandidate({
  home,
  contents = '{"type":"session_meta"}\n',
  hash = undefined,
  state = "ready",
}) {
  const sessionId = "rollout-2026-07-14T12-34-56-019f0000-0000-7000-8000-000000000001";
  const sourcePath = join(home, ".codex", "sessions", "2026", "07", "14", `${sessionId}.jsonl`);
  await mkdir(dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, contents, "utf8");
  const database = await createLedger();

  try {
    const { sourceSession } = upsertSourceSession(database, {
      ...sourceSessionFixture,
      session_id: sessionId,
      source_tool: "codex-cli",
      source_format: "codex-cli-jsonl",
      source_path: sourcePath,
      source_hash: hash ?? sha256(contents),
    });
    upsertDeletionCandidate(database, {
      candidateState: state,
      currentLifecycleState: sourceSession.current_lifecycle_state,
      projectKey: sourceSession.project_key,
      reason: "All required retention artifacts are present.",
      safeToDelete: true,
      sessionId,
      sourceHash: sourceSession.source_hash,
      sourceSessionId: sourceSession.id,
    });
  } finally {
    database.close();
  }

  return { sessionId, sourcePath, contents };
}

function archivePathFor({ root, sessionId }) {
  return join(root, "archives", "raw", "codex-cli", "2026", "07", "14", `${sessionId}.jsonl.gz`);
}

async function writeVerifiedArchive(fixture, source) {
  const archivePath = archivePathFor({ ...fixture, sessionId: source.sessionId });
  const archiveContents = gzipSync(Buffer.from(source.contents));
  const receipt = {
    archive_path: archivePath,
    archive_sha256: sha256(archiveContents),
    archived_at: "2026-07-14T12:35:00.000Z",
    compressed_bytes: archiveContents.length,
    session_id: source.sessionId,
    source_bytes: Buffer.byteLength(source.contents),
    source_hash: sha256(source.contents),
    source_path: source.sourcePath,
    source_removed_at: null,
    source_tool: "codex-cli",
  };
  await mkdir(dirname(archivePath), { recursive: true });
  await writeFile(archivePath, archiveContents);
  await writeFile(`${archivePath}.receipt.json`, JSON.stringify(receipt, null, 2));
  return archivePath;
}

test("delete sources dry-run leaves a ready Codex source untouched", async () => {
  await withFixture(async (fixture) => {
    const source = await seedCandidate(fixture);

    const result = runCli(["delete", "sources", "--source", "codex-cli"], fixture);

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.apply, false);
    assert.equal(payload.archivable.length, 1);
    assert.equal(payload.archivable[0].session_id, source.sessionId);
    assert.equal(await pathExists(source.sourcePath), true);
    assert.equal(await pathExists(join(fixture.root, "archives")), false);
  });
});

test("delete sources archives, verifies, then removes an eligible Codex source", async () => {
  await withFixture(async (fixture) => {
    const source = await seedCandidate(fixture);

    const result = runCli(["delete", "sources", "--source", "codex-cli", "--apply"], fixture);

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.apply, true);
    assert.equal(payload.applied.length, 1);

    const archivePath = join(
      fixture.root,
      "archives",
      "raw",
      "codex-cli",
      "2026",
      "07",
      "14",
      `${source.sessionId}.jsonl.gz`,
    );
    const receiptPath = `${archivePath}.receipt.json`;
    assert.equal(await pathExists(source.sourcePath), false);
    assert.equal(await pathExists(archivePath), true);
    assert.equal(await pathExists(receiptPath), true);
    assert.equal(gunzipSync(await readFile(archivePath)).toString("utf8"), source.contents);

    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    assert.equal(receipt.session_id, source.sessionId);
    assert.equal(receipt.source_hash, sha256(source.contents));

    const database = await createLedger();
    try {
      const candidate = getDeletionCandidateBySessionId(database, source.sessionId);
      assert.equal(candidate.candidate_state, "applied");
    } finally {
      database.close();
    }
  });
});

test("delete sources refuses a source whose bytes do not match the ledger hash", async () => {
  await withFixture(async (fixture) => {
    const source = await seedCandidate({ ...fixture, hash: sha256("different") });

    const result = runCli(["delete", "sources", "--source", "codex-cli", "--apply"], fixture);

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.applied.length, 0);
    assert.equal(payload.blocked.length, 1);
    assert.match(payload.blocked[0].reason, /hash mismatch/i);
    assert.equal(await pathExists(source.sourcePath), true);
    assert.equal(await pathExists(join(fixture.root, "archives")), false);
  });
});

test("delete sources blocks unsafe candidate states and unsupported sources", async () => {
  await withFixture(async (fixture) => {
    const source = await seedCandidate({ ...fixture, state: "pending_artifacts" });

    const unsafeState = runCli(["delete", "sources", "--source", "codex-cli", "--apply"], fixture);
    assert.equal(unsafeState.status, 0, unsafeState.stderr);
    const unsafePayload = JSON.parse(unsafeState.stdout);
    assert.equal(unsafePayload.applied.length, 0);
    assert.equal(unsafePayload.blocked.length, 1);
    assert.equal(await pathExists(source.sourcePath), true);

    const unsupported = runCli(["delete", "sources", "--source", "cursor"], fixture);
    assert.equal(unsupported.status, 1);
    assert.match(unsupported.stderr, /requires --source codex-cli/i);
  });
});

test("delete sources leaves a collision and ledger state untouched", async () => {
  await withFixture(async (fixture) => {
    const source = await seedCandidate(fixture);
    const archivePath = archivePathFor({ ...fixture, sessionId: source.sessionId });
    await mkdir(dirname(archivePath), { recursive: true });
    await writeFile(archivePath, "not a gzip archive");

    const result = runCli(["delete", "sources", "--source", "codex-cli", "--apply"], fixture);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.applied.length, 0);
    assert.equal(payload.blocked.length, 1);
    assert.match(payload.blocked[0].reason, /collision/i);
    assert.equal(await pathExists(source.sourcePath), true);

    const database = await createLedger();
    try {
      const candidate = getDeletionCandidateBySessionId(database, source.sessionId);
      assert.equal(candidate.candidate_state, "ready");
    } finally {
      database.close();
    }
  });
});

test("delete sources reports a missing source without changing its deletion candidate", async () => {
  await withFixture(async (fixture) => {
    const source = await seedCandidate(fixture);
    await unlink(source.sourcePath);

    const result = runCli(["delete", "sources", "--source", "codex-cli", "--apply"], fixture);

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.applied.length, 0);
    assert.equal(payload.missing.length, 1);

    const database = await createLedger();
    try {
      const candidate = getDeletionCandidateBySessionId(database, source.sessionId);
      assert.equal(candidate.candidate_state, "ready");
    } finally {
      database.close();
    }
  });
});

test("delete sources archives legacy applied sources and retrying is idempotent", async () => {
  await withFixture(async (fixture) => {
    const source = await seedCandidate({ ...fixture, state: "applied" });

    const firstRun = runCli(["delete", "sources", "--source", "codex-cli", "--apply"], fixture);
    assert.equal(firstRun.status, 0, firstRun.stderr);
    assert.equal(JSON.parse(firstRun.stdout).applied.length, 1);
    assert.equal(await pathExists(source.sourcePath), false);

    const secondRun = runCli(["delete", "sources", "--source", "codex-cli", "--apply"], fixture);
    assert.equal(secondRun.status, 0, secondRun.stderr);
    const payload = JSON.parse(secondRun.stdout);
    assert.equal(payload.already_archived.length, 1);
    assert.equal(payload.applied.length, 1);
  });
});

test("delete sources recovers an interrupted post-archive deletion", async () => {
  await withFixture(async (fixture) => {
    const source = await seedCandidate(fixture);
    const archivePath = await writeVerifiedArchive(fixture, source);

    const result = runCli(["delete", "sources", "--source", "codex-cli", "--apply"], fixture);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.already_archived.length, 1);
    assert.equal(payload.applied.length, 1);
    assert.equal(await pathExists(source.sourcePath), false);
    assert.equal(await pathExists(archivePath), true);
  });
});

test("cleanup-codex-sources delegates to the verified dry-run workflow", async () => {
  await withFixture(async (fixture) => {
    const source = await seedCandidate(fixture);

    const result = runCleanupScript([], fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /deprecated/i);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.apply, false);
    assert.equal(payload.archivable.length, 1);
    assert.equal(await pathExists(source.sourcePath), true);
  });
});
