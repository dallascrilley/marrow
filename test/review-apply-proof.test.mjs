import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("exactly-once proof runner records duplicate, skip, and retry evidence", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "marrow-proof-runner-test-"));
  const reportPath = join(sandbox, "proof.json");
  try {
    const result = spawnSync(
      process.execPath,
      ["scripts/proof-review-apply-exactly-once.mjs", "--write-json", reportPath],
      {
        cwd: projectRoot,
        encoding: "utf8",
        env: { ...process.env, OPENROUTER_API_KEY: "" },
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const proof = JSON.parse(await readFile(reportPath, "utf8"));
    assert.equal(proof.success, true);
    assert.equal(proof.deterministic.duplicate_apply.no_op, true);
    assert.equal(proof.deterministic.duplicate_apply.outputs_unchanged, true);
    assert.equal(proof.deterministic.duplicate_apply.receipt_recreated, true);
    assert.equal(proof.deterministic.skipped_generation.state_unchanged, true);
    assert.deepEqual(proof.deterministic.interrupted_retry.ledger_transitions, [
      "applying",
      "failed",
      "applying",
      "applied",
    ]);
    assert.equal(proof.deterministic.interrupted_retry.converged, true);
    assert.equal(proof.live.status, "skipped");
  } finally {
    await rm(sandbox, { force: true, recursive: true });
  }
});
