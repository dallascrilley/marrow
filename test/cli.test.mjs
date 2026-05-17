import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const testDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(testDir);
const cliPath = join(projectRoot, "dist", "cli.js");
const runtimeOverrideEnvVar = "AGENT_SESSION_DISTILLERY_ROOT";

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...env
    }
  });
}

test("asd --help lists every Task 1 command", () => {
  const result = runCli(["--help"]);

  assert.equal(result.status, 0, result.stderr);

  const output = result.stdout;
  const expectedCommands = [
    "ingest backfill",
    "ingest sync",
    "review queue",
    "review show",
    "archive run",
    "delete candidates",
    "delete apply",
    "search",
    "stats",
    "explain"
  ];

  for (const command of expectedCommands) {
    assert.match(output, new RegExp(command.replace(" ", "\\s+")));
  }
});

test("unknown command exits non-zero and prints help", () => {
  const result = runCli(["bogus"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown command: bogus/);
  assert.match(result.stdout, /Usage: asd/);
});

test("missing subcommand exits non-zero and prints available subcommands", () => {
  const result = runCli(["ingest"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown or missing subcommand for ingest/);
  assert.match(result.stderr, /backfill/);
  assert.match(result.stderr, /sync/);
  assert.match(result.stdout, /Usage: asd/);
});

test("stub dispatch succeeds and reports the prepared runtime path", async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "asd-dispatch-"));

  try {
    const result = runCli(["search", "alpha"], {
      [runtimeOverrideEnvVar]: runtimeRoot
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^search alpha/m);
    assert.match(result.stdout, new RegExp(`Runtime path ready: ${runtimeRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/index`));
    assert.match(result.stdout, /Command scaffolded for Task 1\./);
  } finally {
    await rm(runtimeRoot, { force: true, recursive: true });
  }
});

test("runtime-path creation is isolated by the root override", async () => {
  const sandboxBase = await mkdtemp(join(tmpdir(), "asd-runtime-"));
  const runtimeRoot = join(sandboxBase, "runtime-root");

  try {
    const beforeEntries = await readdir(sandboxBase);
    assert.deepEqual(beforeEntries, []);

    const result = runCli(["review", "queue"], {
      [runtimeOverrideEnvVar]: runtimeRoot
    });

    assert.equal(result.status, 0, result.stderr);

    const reviewsPath = join(runtimeRoot, "reviews");
    const reviewsStats = await stat(reviewsPath);
    assert.ok(reviewsStats.isDirectory());

    const runtimeEntries = await readdir(runtimeRoot);
    assert.deepEqual(runtimeEntries, ["ledger", "reviews"]);

    const sandboxEntries = await readdir(sandboxBase);
    assert.deepEqual(sandboxEntries, ["runtime-root"]);
  } finally {
    await rm(sandboxBase, { force: true, recursive: true });
  }
});
