import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// End-to-end audit evidence for the rejected quality tasks:
//   per-session project-learning cap (<= 12)
//   atomicity gate (no multi-sentence chatter promoted)
//   shared heuristics keep extract + audit consistent
//
// Ingests the real Cursor live-regression corpus into an isolated sandbox and
// asserts a FRESH audit honours the cap and chatter gates. This is the
// "after reprocessing" evidence without mutating the operator's live runtime
// (whose stale pre-fix artifacts still show max_project_learnings = 28).

const runtimeOverrideEnvVar = "MARROW_ROOT";
const testDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(dirname(testDir));
const cliPath = join(projectRoot, "dist", "cli.js");
const liveRegressionRoot = join(projectRoot, "test", "fixtures", "cursor", "live-regression");
const fixtureSlug = "Users-example-Code-service-tools";

function runCli(args, env) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

test("fresh ingest of the live-regression corpus passes the cap and chatter audit gates", async () => {
  const sandboxRoot = await mkdtemp(join(tmpdir(), "marrow-audit-fresh-"));
  const runtimeRoot = join(sandboxRoot, "runtime");
  const homeDir = join(sandboxRoot, "home");

  try {
    const projectRootPath = join(homeDir, ".cursor", "projects", fixtureSlug);
    await mkdir(projectRootPath, { recursive: true });
    await writeFile(
      join(projectRootPath, "workspace.json"),
      `${JSON.stringify({ workspacePath: join(homeDir, "Code", fixtureSlug) }, null, 2)}\n`,
      "utf8",
    );

    const fixtureFiles = (await readdir(liveRegressionRoot)).filter((name) =>
      name.endsWith(".jsonl"),
    );
    assert.ok(fixtureFiles.length > 0, "expected live-regression fixtures");
    for (const fixtureFile of fixtureFiles) {
      const sessionId = fixtureFile.replace(/\.jsonl$/u, "");
      const destination = join(projectRootPath, "agent-transcripts", sessionId, fixtureFile);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, await readFile(join(liveRegressionRoot, fixtureFile), "utf8"));
    }

    const env = { HOME: homeDir, [runtimeOverrideEnvVar]: runtimeRoot };

    const ingestResult = runCli(["ingest", "backfill", "--source", "cursor"], env);
    assert.equal(ingestResult.status, 0, ingestResult.stderr);
    const ingestSummary = JSON.parse(ingestResult.stdout);
    assert.equal(ingestSummary.processed_count, fixtureFiles.length);

    const auditResult = runCli(["quality", "audit"], env);
    assert.equal(auditResult.status, 0, auditResult.stderr);
    const report = JSON.parse(auditResult.stdout);

    // Freshly-extracted artifacts never exceed the per-session cap.
    assert.ok(
      report.learning_distribution.max_project_learnings <= 12,
      `max_project_learnings was ${report.learning_distribution.max_project_learnings}`,
    );
    assert.equal(report.learning_distribution.buckets.gt_25, 0);
    assert.equal(report.learning_distribution.buckets.gt_50, 0);

    // The atomicity + chatter gates keep the fresh
    // corpus clean of promoted process narration and wrapper-tag leakage.
    assert.equal(report.issue_counts.process_chatter, 0);
    assert.equal(report.issue_counts.wrapper_tags, 0);
    assert.equal(report.issue_counts.summary_invalid, 0);
  } finally {
    await rm(sandboxRoot, { force: true, recursive: true });
  }
});
