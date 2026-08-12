import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createLedger, upsertSourceSession } from "../dist/db/ledger.js";
import { sourceSessionFixture } from "../dist/models/canonical.js";
import { hashToProjectId } from "../dist/v2/project/resolve.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(testDir);
const cliPath = join(projectRoot, "dist", "cli.js");
const runtimeOverrideEnvVar = "MARROW_ROOT";

async function withRuntime(run) {
  const root = await mkdtemp(join(tmpdir(), "marrow-migrate-project-ids-"));
  const prior = process.env[runtimeOverrideEnvVar];
  process.env[runtimeOverrideEnvVar] = root;

  try {
    await run(root);
  } finally {
    if (prior === undefined) {
      delete process.env[runtimeOverrideEnvVar];
    } else {
      process.env[runtimeOverrideEnvVar] = prior;
    }

    await rm(root, { recursive: true, force: true });
  }
}

function runCli(args, root) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, [runtimeOverrideEnvVar]: root },
  });
}

function buildSession(overrides = {}) {
  return {
    ...sourceSessionFixture,
    ...overrides,
  };
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// --apply mode prints an informational preamble line before the (pretty
// printed, multi-line) JSON payload, so strip it off before parsing.
function parseMigrationPayload(stdout) {
  const trimmed = stdout.trim();
  const jsonStart = trimmed.indexOf("{");
  return JSON.parse(trimmed.slice(jsonStart));
}

test("migrate project-ids dry-run reports the legacy-to-ADR-0002 mapping without copying anything", async () => {
  await withRuntime(async (root) => {
    // A real (non-git) workspace dir so resolveProjectId deterministically
    // falls through to the path-hash branch instead of a git-remote lookup.
    const workspace = await mkdtemp(join(tmpdir(), "marrow-migrate-workspace-"));
    const legacyKey = "demo-legacy";
    const expectedNewId = hashToProjectId(workspace);

    const database = await createLedger();
    try {
      upsertSourceSession(
        database,
        buildSession({
          project_key: legacyKey,
          workspace_path: workspace,
        }),
      );
    } finally {
      database.close();
    }

    const legacyKnowledgeDir = join(root, "knowledge", "projects", legacyKey);
    await mkdir(legacyKnowledgeDir, { recursive: true });
    await writeFile(join(legacyKnowledgeDir, "marker.json"), JSON.stringify({ ok: true }), "utf8");

    const result = runCli(["migrate", "project-ids"], root);

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim());
    assert.equal(payload.dry_run, true);
    assert.equal(payload.entries, 1);
    assert.equal(payload.changed, 1);

    const reportPath = join(root, "_project-id-migration.json");
    assert.equal(payload.report, reportPath);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.equal(report.apply, false);
    assert.equal(report.entries.length, 1);
    assert.equal(report.entries[0].old_key, legacyKey);
    assert.equal(report.entries[0].new_id, expectedNewId);
    assert.equal(report.entries[0].source, "path-hash");
    assert.equal(report.entries[0].applied, undefined);

    // Dry run must not touch knowledge/projects at all.
    assert.equal(await pathExists(join(root, "knowledge", "projects", expectedNewId)), false);
    assert.equal(
      await readFile(join(legacyKnowledgeDir, "marker.json"), "utf8"),
      JSON.stringify({ ok: true }),
    );
  });
});

test("migrate project-ids --apply copies knowledge/projects/<old> to knowledge/projects/<new> and is idempotent on rerun", async () => {
  await withRuntime(async (root) => {
    const workspace = await mkdtemp(join(tmpdir(), "marrow-migrate-workspace-"));
    const legacyKey = "demo-legacy-apply";
    const expectedNewId = hashToProjectId(workspace);

    const database = await createLedger();
    try {
      upsertSourceSession(
        database,
        buildSession({
          project_key: legacyKey,
          session_id: "session-apply-0001",
          source_hash: "sha256:session-apply-0001",
          source_path: "/tmp/session-apply-0001.jsonl",
          workspace_path: workspace,
        }),
      );
    } finally {
      database.close();
    }

    const legacyKnowledgeDir = join(root, "knowledge", "projects", legacyKey);
    const newKnowledgeDir = join(root, "knowledge", "projects", expectedNewId);
    await mkdir(legacyKnowledgeDir, { recursive: true });
    await writeFile(join(legacyKnowledgeDir, "marker.json"), JSON.stringify({ ok: true }), "utf8");

    const firstApply = runCli(["migrate", "project-ids", "--apply"], root);
    assert.equal(firstApply.status, 0, firstApply.stderr);
    const firstPayload = parseMigrationPayload(firstApply.stdout);
    assert.equal(firstPayload.dry_run, false);
    assert.equal(firstPayload.changed, 1);

    const firstReport = JSON.parse(
      await readFile(join(root, "_project-id-migration.json"), "utf8"),
    );
    assert.equal(firstReport.apply, true);
    assert.equal(firstReport.entries[0].applied, true);
    assert.equal(firstReport.entries[0].apply_error, undefined);

    assert.equal(await pathExists(newKnowledgeDir), true);
    const migratedMarker = await readFile(join(newKnowledgeDir, "marker.json"), "utf8");
    assert.equal(migratedMarker, JSON.stringify({ ok: true }));

    // Original legacy dir is left in place; apply mode copies, it does not move.
    assert.equal(
      await readFile(join(legacyKnowledgeDir, "marker.json"), "utf8"),
      JSON.stringify({ ok: true }),
    );

    // Re-running --apply against the same legacy entry is a no-op for that
    // entry: the copy already exists (fs.cp with force:false skips it rather
    // than throwing), nothing errors, the migrated content is unchanged, and
    // the migrated-to ADR-0002 id dir is not rediscovered as another legacy key.
    const secondApply = runCli(["migrate", "project-ids", "--apply"], root);
    assert.equal(secondApply.status, 0, secondApply.stderr);

    const secondReport = JSON.parse(
      await readFile(join(root, "_project-id-migration.json"), "utf8"),
    );
    const secondEntryForLegacyKey = secondReport.entries.find(
      (entry) => entry.old_key === legacyKey,
    );
    assert.ok(secondEntryForLegacyKey, "legacy key entry still present on rerun");
    assert.equal(secondEntryForLegacyKey.new_id, expectedNewId);
    assert.equal(secondEntryForLegacyKey.applied, true);
    assert.equal(secondEntryForLegacyKey.apply_error, undefined);
    assert.equal(
      secondReport.entries.some((entry) => entry.old_key === expectedNewId),
      false,
      "migrated target dir must not be rediscovered as a legacy key",
    );
    assert.equal(
      await readFile(join(newKnowledgeDir, "marker.json"), "utf8"),
      JSON.stringify({ ok: true }),
    );
  });
});
