import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = fileURLToPath(new URL(".", import.meta.url));
const projectRoot = resolve(testDir, "..");
const scriptPath = join(projectRoot, "scripts", "resummarize-corpus.mjs");
const runtimeOverrideEnvVar = "MARROW_ROOT";

test("resummarize-corpus script dry-run exits 0 and writes report", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "marrow-corpus-script-"));
  const runtimeRoot = join(sandbox, "runtime-root");

  try {
    const result = spawnSync(process.execPath, [scriptPath, "--dry-run", "--root", runtimeRoot], {
      cwd: projectRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        [runtimeOverrideEnvVar]: runtimeRoot,
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout.trim());
    assert.equal(report.success, true);
    assert.equal(report.dry_run, true);
    assert.equal(report.leaked_topic_only, true);
    assert.equal(report.llm_topic, false);
    assert.equal(report.result?.dry_run, true);
    assert.match(report.report_path, /resummarize-corpus\.json$/);
  } finally {
    await rm(sandbox, { force: true, recursive: true });
  }
});

test("resummarize-corpus --help exits 0 without touching runtime store", async () => {
  const result = spawnSync(process.execPath, [scriptPath, "--help"], {
    cwd: projectRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /--leaked-topic-only/);
  assert.match(result.stdout, /--confirm/);
});

test("resummarize-corpus write sweep requires --confirm", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "marrow-corpus-script-confirm-"));
  const runtimeRoot = join(sandbox, "runtime-root");

  try {
    const result = spawnSync(process.execPath, [scriptPath, "--root", runtimeRoot], {
      cwd: projectRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        [runtimeOverrideEnvVar]: runtimeRoot,
      },
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--confirm/);
  } finally {
    await rm(sandbox, { force: true, recursive: true });
  }
});

test("resummarize-corpus write sweep backs up summaries before resummarize", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "marrow-corpus-script-backup-"));
  const runtimeRoot = join(sandbox, "runtime-root");
  const summariesPath = join(runtimeRoot, "summaries", "fixture-session");
  await mkdir(summariesPath, { recursive: true });
  await writeFile(join(summariesPath, "summary.json"), '{"topic":"old"}\n', "utf8");

  try {
    const result = spawnSync(
      process.execPath,
      [scriptPath, "--confirm", "--root", runtimeRoot, "--no-export-index"],
      {
        cwd: projectRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          [runtimeOverrideEnvVar]: runtimeRoot,
        },
      },
    );

    const report = JSON.parse(result.stdout.trim());
    assert.ok(report.backup_path);
    const backupSummary = await readFile(
      join(report.backup_path, "fixture-session", "summary.json"),
      "utf8",
    );
    assert.equal(backupSummary, '{"topic":"old"}\n');
  } finally {
    await rm(sandbox, { force: true, recursive: true });
  }
});
