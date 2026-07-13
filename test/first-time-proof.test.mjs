import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("first-time proof exercises the offline core workflow without mutating the live runtime", async () => {
  const result = spawnSync("bash", ["script/proof-first-time"], {
    cwd: projectRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  const proof = report.suites.first_time;

  try {
    assert.equal(proof.success, true);
    assert.equal(proof.runtime_root_isolated, true);
    assert.match(proof.next_live_command, /ingest sync --resume/);
    assert.match(proof.artifacts.cleanup_command, /^rm -rf /);
    assert.match(await readFile(proof.artifacts.summary_path, "utf8"), /\S/);
    assert.match(await readFile(proof.artifacts.learning_path, "utf8"), /"learning_id"/);
    assert.match(await readFile(proof.artifacts.recall_path, "utf8"), /"session-e2e"/);
    assert.match(
      proof.steps.find((step) => step.name === "bounded search")?.stdout ?? "",
      /session-e2e/,
    );
    assert.equal(
      proof.steps.find((step) => step.name === "deletion readiness without source deletion")
        ?.status,
      "passed",
    );
  } finally {
    await rm(proof.sandbox, { recursive: true, force: true });
  }
});
