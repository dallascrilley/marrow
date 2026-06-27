import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createLedger, upsertSourceSession } from "../dist/db/ledger.js";
import { sourceSessionFixture } from "../dist/models/canonical.js";
import {
  assessSessionIntegrity,
  sessionIntegrityExitCode,
} from "../dist/pipeline/session-integrity.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(testDir);
const cliPath = join(projectRoot, "dist", "cli.js");
const runtimeOverrideEnvVar = "AGENT_SESSION_DISTILLERY_ROOT";

async function withRuntimeRoot(run) {
  const sandboxBase = await mkdtemp(join(tmpdir(), "asd-integrity-"));
  const runtimeRoot = join(sandboxBase, "runtime-root");
  const previousOverride = process.env[runtimeOverrideEnvVar];

  process.env[runtimeOverrideEnvVar] = runtimeRoot;

  try {
    await run(runtimeRoot);
  } finally {
    if (previousOverride === undefined) {
      delete process.env[runtimeOverrideEnvVar];
    } else {
      process.env[runtimeOverrideEnvVar] = previousOverride;
    }

    await rm(sandboxBase, { force: true, recursive: true });
  }
}

async function writeManifest(
  runtimeRoot,
  { sessionId, asdSessionId, sourcePath, sourceTool, manifestFileName, sourceHash },
) {
  const summaryPath = join(runtimeRoot, "summaries", "by-session", sessionId, "summary.json");
  const manifestPath = join(
    runtimeRoot,
    "sources",
    "manifests",
    manifestFileName ?? `${sessionId}.json`,
  );

  await mkdir(join(runtimeRoot, "summaries", "by-session", sessionId), { recursive: true });
  await mkdir(join(runtimeRoot, "sources", "manifests"), { recursive: true });
  await writeFile(
    summaryPath,
    `${JSON.stringify({
      session_id: asdSessionId,
      topic: "Integrity fixture",
      topic_source: "deterministic",
      what_worked: [],
      what_failed: [],
      what_was_decided: [],
      useful_commands: [],
      files_of_interest: [],
      next_step: "Keep shipping.",
      project_learnings: [],
      user_learnings: [],
      deletion_readiness: "ready",
    })}\n`,
    "utf8",
  );
  await writeFile(
    manifestPath,
    `${JSON.stringify({
      artifact_paths: {
        summary_json_path: summaryPath,
      },
      generated_at: "2026-06-24T00:02:00.000Z",
      session: {
        conversation_id: `demo:${sessionId}`,
        ingest_status: "archived",
        project_key: "demo",
        retention_status: "kept",
        session_id: sessionId,
        source_format: "jsonl",
        source_hash: sourceHash ?? `sha256:${sessionId}`,
        source_path: sourcePath,
        source_tool: sourceTool,
        started_at: "2026-06-24T00:00:00.000Z",
        updated_at: "2026-06-24T00:01:00.000Z",
        workspace_path: "/Users/example/Code/demo",
      },
      version: 1,
    })}\n`,
    "utf8",
  );

  return { manifestPath, summaryPath };
}

test("assessSessionIntegrity passes when ledger and manifests align", async () => {
  await withRuntimeRoot(async (runtimeRoot) => {
    const database = await createLedger();
    try {
      const sourcePath = join(runtimeRoot, "fixtures", "aligned.jsonl");
      await mkdir(join(runtimeRoot, "fixtures"), { recursive: true });
      await writeFile(sourcePath, '{"type":"session"}\n', "utf8");

      upsertSourceSession(database, {
        ...sourceSessionFixture,
        session_id: "aligned-session",
        source_path: sourcePath,
        source_hash: "sha256:aligned-session",
      });
      await writeManifest(runtimeRoot, {
        sessionId: "aligned-session",
        asdSessionId: "aligned-session",
        sourcePath,
        sourceTool: "cursor",
      });

      const report = await assessSessionIntegrity(database);
      assert.equal(report.ok, true);
      assert.equal(report.findings.length, 0);
      assert.equal(sessionIntegrityExitCode(report), 0);
    } finally {
      database.close();
    }
  });
});

test("assessSessionIntegrity flags orphan manifests and duplicate asd_session_id", async () => {
  await withRuntimeRoot(async (runtimeRoot) => {
    const database = await createLedger();
    try {
      const sharedAsdId = "shared-asd-id";
      const firstPath = join(runtimeRoot, "fixtures", "first.jsonl");
      const secondPath = join(runtimeRoot, "fixtures", "second.jsonl");
      const orphanPath = join(runtimeRoot, "fixtures", "orphan.jsonl");
      await mkdir(join(runtimeRoot, "fixtures"), { recursive: true });
      await writeFile(firstPath, '{"type":"session"}\n', "utf8");
      await writeFile(secondPath, '{"type":"session"}\n', "utf8");
      await writeFile(orphanPath, '{"type":"session"}\n', "utf8");

      upsertSourceSession(database, {
        ...sourceSessionFixture,
        session_id: "ledger-one",
        source_path: firstPath,
        source_hash: "sha256:ledger-one",
      });
      upsertSourceSession(database, {
        ...sourceSessionFixture,
        session_id: "ledger-two",
        source_path: secondPath,
        source_hash: "sha256:ledger-two",
      });

      await writeManifest(runtimeRoot, {
        sessionId: "ledger-one",
        asdSessionId: sharedAsdId,
        sourcePath: firstPath,
        sourceTool: "cursor",
      });
      await writeManifest(runtimeRoot, {
        sessionId: "ledger-two",
        asdSessionId: sharedAsdId,
        sourcePath: secondPath,
        sourceTool: "cursor",
      });
      await writeManifest(runtimeRoot, {
        sessionId: "orphan-session",
        asdSessionId: "orphan-session",
        sourcePath: orphanPath,
        sourceTool: "cursor",
      });

      const report = await assessSessionIntegrity(database);
      assert.equal(report.ok, false, "orphan manifest should be blocking");
      assert.equal(sessionIntegrityExitCode(report), 1);
      assert.equal(report.counts.warning_findings, 1, "duplicate should be warning, not blocking");
      assert.ok(
        report.findings.some((finding) => finding.code === "orphan_manifest"),
        "expected orphan manifest finding",
      );
      assert.ok(
        report.findings.some((finding) => finding.code === "duplicate_asd_session_id"),
        "expected duplicate asd_session_id finding",
      );
    } finally {
      database.close();
    }
  });
});

test("assessSessionIntegrity ignores ADR-0008 revision manifests for one source identity", async () => {
  await withRuntimeRoot(async (runtimeRoot) => {
    const database = await createLedger();
    try {
      const sourcePath = join(runtimeRoot, "fixtures", "revision.jsonl");
      await mkdir(join(runtimeRoot, "fixtures"), { recursive: true });
      await writeFile(sourcePath, '{"type":"session"}\n', "utf8");

      upsertSourceSession(database, {
        ...sourceSessionFixture,
        session_id: "revision-session",
        source_path: sourcePath,
        source_hash: "sha256:revision-new",
      });

      await writeManifest(runtimeRoot, {
        sessionId: "revision-session",
        asdSessionId: "revision-session",
        sourcePath,
        sourceTool: "cursor",
        manifestFileName: "revision-session.legacyhash.json",
        sourceHash: "sha256:revision-old",
      });
      await writeManifest(runtimeRoot, {
        sessionId: "revision-session",
        asdSessionId: "revision-session",
        sourcePath,
        sourceTool: "cursor",
        manifestFileName: "revision-session.newhash.json",
        sourceHash: "sha256:revision-new",
      });

      const report = await assessSessionIntegrity(database);
      assert.equal(report.ok, true);
      assert.equal(
        report.findings.some((finding) => finding.code === "duplicate_asd_session_id"),
        false,
      );
    } finally {
      database.close();
    }
  });
});

test("assessSessionIntegrity treats duplicates as warnings (ok=true, exit 0) when no orphans exist", async () => {
  await withRuntimeRoot(async (runtimeRoot) => {
    const database = await createLedger();
    try {
      const firstPath = join(runtimeRoot, "fixtures", "first.jsonl");
      const secondPath = join(runtimeRoot, "fixtures", "second.jsonl");
      await mkdir(join(runtimeRoot, "fixtures"), { recursive: true });
      await writeFile(firstPath, '{"type":"session"}\n', "utf8");
      await writeFile(secondPath, '{"type":"session"}\n', "utf8");

      upsertSourceSession(database, {
        ...sourceSessionFixture,
        session_id: "ledger-one",
        source_path: firstPath,
        source_hash: "sha256:ledger-one",
      });
      upsertSourceSession(database, {
        ...sourceSessionFixture,
        session_id: "ledger-two",
        source_path: secondPath,
        source_hash: "sha256:ledger-two",
      });

      await writeManifest(runtimeRoot, {
        sessionId: "ledger-one",
        asdSessionId: "shared-asd-id",
        sourcePath: firstPath,
        sourceTool: "cursor",
      });
      await writeManifest(runtimeRoot, {
        sessionId: "ledger-two",
        asdSessionId: "shared-asd-id",
        sourcePath: secondPath,
        sourceTool: "cursor",
      });

      const report = await assessSessionIntegrity(database);
      assert.equal(report.ok, true, "dupes-only should be ok");
      assert.equal(sessionIntegrityExitCode(report), 0);
      assert.equal(report.counts.warning_findings, 1, "one duplicate finding");
      assert.equal(report.counts.orphan_manifests, 0, "no orphans");
      assert.ok(
        report.findings.some((finding) => finding.code === "duplicate_asd_session_id"),
        "expected duplicate finding",
      );
    } finally {
      database.close();
    }
  });
});

test("asd check exits non-zero when integrity violations exist", async () => {
  await withRuntimeRoot(async (runtimeRoot) => {
    const orphanPath = join(runtimeRoot, "fixtures", "orphan-only.jsonl");
    await mkdir(join(runtimeRoot, "fixtures"), { recursive: true });
    await writeFile(orphanPath, '{"type":"session"}\n', "utf8");
    await writeManifest(runtimeRoot, {
      sessionId: "orphan-only",
      asdSessionId: "orphan-only",
      sourcePath: orphanPath,
      sourceTool: "cursor",
    });

    const result = spawnSync(process.execPath, [cliPath, "check"], {
      cwd: projectRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        [runtimeOverrideEnvVar]: runtimeRoot,
      },
    });

    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /orphan_manifest/);
  });
});

test("asd check exits zero on clean runtime", async () => {
  await withRuntimeRoot(async (runtimeRoot) => {
    const database = await createLedger();
    try {
      const sourcePath = join(runtimeRoot, "fixtures", "clean.jsonl");
      await mkdir(join(runtimeRoot, "fixtures"), { recursive: true });
      await writeFile(sourcePath, '{"type":"session"}\n', "utf8");
      upsertSourceSession(database, {
        ...sourceSessionFixture,
        session_id: "clean-session",
        source_path: sourcePath,
        source_hash: "sha256:clean-session",
      });
      await writeManifest(runtimeRoot, {
        sessionId: "clean-session",
        asdSessionId: "clean-session",
        sourcePath,
        sourceTool: "cursor",
      });
    } finally {
      database.close();
    }

    const result = spawnSync(process.execPath, [cliPath, "check"], {
      cwd: projectRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        [runtimeOverrideEnvVar]: runtimeRoot,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Session integrity OK/);
  });
});
