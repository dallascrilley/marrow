import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createLedger,
  getDeletionCandidateBySessionId,
  getReviewQueueEntryBySessionId,
  getSourceSessionBySessionId,
  listPhaseCheckpoints,
  listRunHistory,
} from "../../dist/db/ledger.js";

const runtimeOverrideEnvVar = "AGENT_SESSION_DISTILLERY_ROOT";
const stagingOverrideEnvVar = "AGENT_SESSION_DISTILLERY_STAGING_ROOT";
const testDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(dirname(testDir));
const cliPath = join(projectRoot, "dist", "cli.js");
const fixtureTranscriptPath = join(
  projectRoot,
  "test",
  "fixtures",
  "cursor",
  "transcripts",
  "session-e2e.jsonl",
);

function runCli(args, env) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
    },
  });
}

test("ingest backfill advances a fixture transcript through deletion-candidate lifecycle", async () => {
  const sandboxRoot = await mkdtemp(join(await realpath(tmpdir()), "asd-ingest-e2e-"));
  const runtimeRoot = join(sandboxRoot, "runtime");
  const stagingRoot = join(sandboxRoot, "external-staging");
  const homeDir = join(sandboxRoot, "home");
  const workspacePath = join(homeDir, "Code", "agent-session-distillery");
  const encodedSlug = encodeURIComponent(workspacePath);
  const transcriptDestination = join(
    homeDir,
    ".cursor",
    "projects",
    encodedSlug,
    "agent-transcripts",
    "session-e2e.jsonl",
  );
  const transcriptContents = await readFile(fixtureTranscriptPath, "utf8");
  const previousHome = process.env.HOME;
  const previousRuntimeRoot = process.env[runtimeOverrideEnvVar];
  const previousStagingRoot = process.env[stagingOverrideEnvVar];

  process.env.HOME = homeDir;
  process.env[runtimeOverrideEnvVar] = runtimeRoot;
  process.env[stagingOverrideEnvVar] = stagingRoot;

  try {
    await mkdir(workspacePath, { recursive: true });
    await mkdir(stagingRoot, { recursive: true });
    await mkdir(join(homeDir, ".cursor", "projects", encodedSlug), { recursive: true });
    await writeFile(
      join(homeDir, ".cursor", "projects", encodedSlug, "workspace.json"),
      `${JSON.stringify({ workspacePath }, null, 2)}\n`,
      "utf8",
    );
    await mkdir(dirname(transcriptDestination), { recursive: true });
    await writeFile(transcriptDestination, transcriptContents, "utf8");

    const ingestResult = runCli(["ingest", "backfill", "--source", "cursor"], {
      HOME: homeDir,
      [runtimeOverrideEnvVar]: runtimeRoot,
    });
    assert.equal(ingestResult.status, 0, ingestResult.stderr);

    const reviewQueueResult = runCli(["review", "queue"], {
      HOME: homeDir,
      [runtimeOverrideEnvVar]: runtimeRoot,
    });
    assert.equal(reviewQueueResult.status, 0, reviewQueueResult.stderr);
    assert.match(reviewQueueResult.stdout, /summary/);

    const deleteDryRun = runCli(["delete", "apply"], {
      HOME: homeDir,
      [runtimeOverrideEnvVar]: runtimeRoot,
    });
    assert.equal(deleteDryRun.status, 0, deleteDryRun.stderr);
    assert.match(deleteDryRun.stdout, /"apply": false/);

    const database = await createLedger();

    try {
      const session = getSourceSessionBySessionId(database, "session-e2e");
      assert.ok(session);
      assert.equal(
        session.current_lifecycle_state,
        "deletion_candidate",
        JSON.stringify(listRunHistory(database, session.id), null, 2),
      );

      const checkpoints = listPhaseCheckpoints(database, session.id);
      assert.deepEqual(
        checkpoints.map((checkpoint) => checkpoint.phase_name),
        ["archived", "deletion_candidate", "extracted", "parsed", "reduced", "summarized"],
      );
      assert.ok(checkpoints.every((checkpoint) => checkpoint.phase_state === "completed"));

      const candidate = getDeletionCandidateBySessionId(database, "session-e2e");
      assert.ok(candidate);
      assert.equal(candidate.candidate_state, "ready");
      assert.equal(candidate.safe_to_delete, 1);
      assert.equal(candidate.current_lifecycle_state, "archived");

      const reviewEntry = getReviewQueueEntryBySessionId(database, "session-e2e");
      assert.ok(reviewEntry);
      assert.equal(reviewEntry.queue_state, "completed");

      await assert.rejects(access(join(stagingRoot, "session-e2e", "parsed-records.json")), {
        code: "ENOENT",
      });
      await access(join(stagingRoot, "session-e2e", "reduced-session.json"));
      await assert.rejects(access(join(runtimeRoot, "staging")), { code: "ENOENT" });
      await access(join(runtimeRoot, "summaries", "by-session", "session-e2e", "summary.json"));

      const explainResult = runCli(["explain", "session-e2e"], {
        HOME: homeDir,
        [runtimeOverrideEnvVar]: runtimeRoot,
      });
      assert.equal(explainResult.status, 0, explainResult.stderr);
      assert.match(explainResult.stdout, /deletion_candidate/);
      assert.match(explainResult.stdout, /run_history/);
    } finally {
      database.close();
    }
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }

    if (previousRuntimeRoot === undefined) {
      delete process.env[runtimeOverrideEnvVar];
    } else {
      process.env[runtimeOverrideEnvVar] = previousRuntimeRoot;
    }

    if (previousStagingRoot === undefined) {
      delete process.env[stagingOverrideEnvVar];
    } else {
      process.env[stagingOverrideEnvVar] = previousStagingRoot;
    }

    await rm(sandboxRoot, { force: true, recursive: true });
  }
});
