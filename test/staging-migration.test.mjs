import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { parseStorageMigrateStagingOptions } from "../dist/commands/storage-migrate-staging.js";
import { runtimeRootOverrideEnvVar, stagingRootOverrideEnvVar } from "../dist/config/paths.js";
import { runStagingMigration } from "../dist/pipeline/staging-migration.js";

test("storage migrate-staging options are explicit and dry-run by default", () => {
  assert.deepEqual(parseStorageMigrateStagingOptions(["--to", "/Volumes/SSK/staging"]), {
    apply: false,
    to: "/Volumes/SSK/staging",
  });
  assert.deepEqual(parseStorageMigrateStagingOptions(["--apply", "--to", "/Volumes/SSK/staging"]), {
    apply: true,
    to: "/Volumes/SSK/staging",
  });
  assert.throws(() => parseStorageMigrateStagingOptions([]), /requires --to/);
  assert.throws(() => parseStorageMigrateStagingOptions(["--nope"]), /Unknown/);
});

async function withMigrationSandbox(run) {
  const sandbox = await mkdtemp(join(await realpath(tmpdir()), "asd-staging-migration-"));
  const runtimeRoot = join(sandbox, "runtime");
  const sourceRoot = join(runtimeRoot, "staging");
  const destinationRoot = join(sandbox, "destination");
  const previousRuntime = process.env[runtimeRootOverrideEnvVar];
  const previousStaging = process.env[stagingRootOverrideEnvVar];
  process.env[runtimeRootOverrideEnvVar] = runtimeRoot;
  delete process.env[stagingRootOverrideEnvVar];
  try {
    await mkdir(join(sourceRoot, "session-a"), { recursive: true });
    await mkdir(destinationRoot);
    await writeFile(join(sourceRoot, "session-a", "parsed-records.json"), "[1,2,3]\n");
    await writeFile(join(sourceRoot, "session-a", "reduced-session.json"), '{"turns":[]}\n');
    await run({ destinationRoot, runtimeRoot, sandbox, sourceRoot });
  } finally {
    if (previousRuntime === undefined) delete process.env[runtimeRootOverrideEnvVar];
    else process.env[runtimeRootOverrideEnvVar] = previousRuntime;
    if (previousStaging === undefined) delete process.env[stagingRootOverrideEnvVar];
    else process.env[stagingRootOverrideEnvVar] = previousStaging;
    await rm(sandbox, { force: true, recursive: true });
  }
}

test("staging migration dry run is non-mutating and apply is verified and idempotent", async () => {
  await withMigrationSandbox(async ({ destinationRoot, runtimeRoot, sourceRoot }) => {
    const dryRun = await runStagingMigration({ apply: false, to: destinationRoot });
    assert.equal(dryRun.apply, false);
    assert.equal(dryRun.files.length, 2);
    assert.equal(dryRun.total_bytes, 21);
    assert.deepEqual(await readdir(destinationRoot), []);

    const applied = await runStagingMigration({
      apply: true,
      now: new Date("2026-07-18T12:00:00.000Z"),
      to: destinationRoot,
    });
    assert.equal(applied.apply, true);
    assert.equal(applied.copied_count, 2);
    assert.equal(applied.skipped_count, 0);
    assert.ok(applied.receipt_path?.startsWith(join(runtimeRoot, "reports", "storage-migrations")));
    assert.ok(
      applied.manifest_path?.startsWith(join(runtimeRoot, "reports", "storage-migrations")),
    );
    assert.equal(
      await readFile(join(destinationRoot, "session-a", "parsed-records.json"), "utf8"),
      "[1,2,3]\n",
    );
    await access(join(destinationRoot, ".asd-staging-root.json"));
    await access(join(sourceRoot, "session-a", "parsed-records.json"));

    const rerun = await runStagingMigration({ apply: true, to: destinationRoot });
    assert.equal(rerun.copied_count, 0);
    assert.equal(rerun.skipped_count, 2);
  });
});

test("staging migration rejects nested, symlinked, and unsupported destinations or sources", async () => {
  await withMigrationSandbox(async ({ destinationRoot, sandbox, sourceRoot }) => {
    const nested = join(sourceRoot, "nested-destination");
    await mkdir(nested);
    await assert.rejects(
      runStagingMigration({ apply: false, to: nested }),
      /must not equal or nest/,
    );

    const linked = join(sandbox, "linked-destination");
    await symlink(destinationRoot, linked);
    await assert.rejects(runStagingMigration({ apply: false, to: linked }), /symbolic link/);

    await writeFile(join(sourceRoot, "unexpected.txt"), "unsafe");
    await assert.rejects(
      runStagingMigration({ apply: false, to: destinationRoot }),
      /unsupported staging entry/,
    );
  });
});

test("staging migration refuses a missing configured source and leaves the destination untouched", async () => {
  await withMigrationSandbox(async ({ destinationRoot, sandbox }) => {
    process.env[stagingRootOverrideEnvVar] = join(sandbox, "missing-volume", "staging");
    await assert.rejects(
      runStagingMigration({ apply: false, to: destinationRoot }),
      /staging root is unavailable/,
    );
    assert.deepEqual(await readdir(destinationRoot), []);
  });
});

test("staging migration blocks pending cleanup and insufficient capacity before mutation", async () => {
  await withMigrationSandbox(async ({ destinationRoot }) => {
    await assert.rejects(
      runStagingMigration(
        { apply: true, to: destinationRoot },
        {
          loadPending: async () => ({
            candidates: [],
            conflicts: [],
            pendingReceiptCount: 1,
            quarantines: [],
            receiptPaths: ["pending.json"],
          }),
        },
      ),
      /pending parsed cleanup receipts/,
    );
    assert.deepEqual(await readdir(destinationRoot), []);

    await assert.rejects(
      runStagingMigration(
        { apply: true, to: destinationRoot },
        {
          statfs: async () => ({ bavail: 0, bsize: 4096 }),
        },
      ),
      /insufficient destination capacity/,
    );
    assert.deepEqual(await readdir(destinationRoot), []);
  });
});

test("staging migration never overwrites a mismatched destination artifact", async () => {
  await withMigrationSandbox(async ({ destinationRoot }) => {
    await runStagingMigration({ apply: true, to: destinationRoot });
    const destinationArtifact = join(destinationRoot, "session-a", "parsed-records.json");
    await writeFile(destinationArtifact, "different\n");
    await assert.rejects(
      runStagingMigration({ apply: true, to: destinationRoot }),
      /destination artifact hash mismatch/,
    );
    assert.equal(await readFile(destinationArtifact, "utf8"), "different\n");
  });
});

test("staging migration rejects a destination owned by another source or containing stale sessions", async () => {
  await withMigrationSandbox(async ({ destinationRoot, runtimeRoot, sandbox }) => {
    await runStagingMigration({ apply: true, to: destinationRoot });

    const staleArtifact = join(destinationRoot, "stale-session", "reduced-session.json");
    await mkdir(dirname(staleArtifact), { recursive: true });
    await writeFile(staleArtifact, '{"turns":[]}\n');
    await assert.rejects(
      runStagingMigration({ apply: false, to: destinationRoot }),
      /artifact absent from source/,
    );
    await rm(dirname(staleArtifact), { force: true, recursive: true });

    const otherRuntime = join(sandbox, "other-runtime");
    await mkdir(join(otherRuntime, "staging", "session-a"), { recursive: true });
    await writeFile(join(otherRuntime, "staging", "session-a", "parsed-records.json"), "[1,2,3]\n");
    process.env[runtimeRootOverrideEnvVar] = otherRuntime;
    await assert.rejects(
      runStagingMigration({ apply: false, to: destinationRoot }),
      /ownership marker source mismatch/,
    );
    process.env[runtimeRootOverrideEnvVar] = runtimeRoot;
  });
});
