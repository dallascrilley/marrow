import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = fileURLToPath(new URL(".", import.meta.url));
const projectRoot = resolve(testDir, "..");
const scriptPath = join(projectRoot, "scripts", "resummarize-corpus.mjs");
const runtimeOverrideEnvVar = "AGENT_SESSION_DISTILLERY_ROOT";

test("resummarize-corpus script dry-run exits 0 and writes report", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "asd-corpus-script-"));
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
    assert.equal(report.result?.dry_run, true);
    assert.match(report.report_path, /resummarize-corpus\.json$/);
  } finally {
    await rm(sandbox, { force: true, recursive: true });
  }
});
