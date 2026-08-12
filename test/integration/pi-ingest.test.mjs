import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { hashToProjectId } from "../../dist/v2/project/resolve.js";

const fixtureWorkspacePath = "/Users/example/Code/demo";
const expectedProjectKey = hashToProjectId(fixtureWorkspacePath);

const testDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(dirname(testDir));
const cliPath = join(projectRoot, "dist", "cli.js");
const fixtureSessionsRoot = join(projectRoot, "test", "fixtures", "pi", "sessions");
const runtimeOverrideEnvVar = "MARROW_ROOT";

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

test("ingest backfill --source pi processes the smoke fixture end-to-end", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "marrow-pi-int-"));
  const home = join(sandbox, "home");
  const runtimeRoot = join(sandbox, "runtime");

  try {
    const targetSessionsRoot = join(home, ".pi", "agent", "sessions");
    await mkdir(targetSessionsRoot, { recursive: true });
    await cp(fixtureSessionsRoot, targetSessionsRoot, { recursive: true });

    const result = runCli(["ingest", "backfill", "--source", "pi"], {
      HOME: home,
      [runtimeOverrideEnvVar]: runtimeRoot,
    });
    assert.equal(result.status, 0, result.stderr);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.source, "pi");
    assert.equal(payload.discovered_count, 1);
    assert.equal(payload.sessions.length, 1);
    const session = payload.sessions[0];
    assert.equal(session.project_key, expectedProjectKey);
    assert.ok(session.summary_path.endsWith("summary.json"));

    const summary = JSON.parse(await readFile(session.summary_path, "utf8"));
    assert.equal(typeof summary.session_id, "string");

    const summaryDir = join(runtimeRoot, "summaries", "by-session", session.session_id);
    const summaryFiles = await readdir(summaryDir);
    assert.ok(summaryFiles.includes("summary.json"));
    assert.ok(summaryFiles.includes("summary.md"));
  } finally {
    await rm(sandbox, { force: true, recursive: true });
  }
});
