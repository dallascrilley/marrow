import assert from "node:assert/strict";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  getRuntimePath,
  runtimeRootOverrideEnvVar,
  stagingRootOverrideEnvVar,
} from "../dist/config/paths.js";
import { selectParsedCleanupQuarantineRoot } from "../dist/pipeline/parsed-cleanup.js";
import {
  ensureStagingRoot,
  getParsedStagingArtifactPath,
  getReducedStagingArtifactPath,
  getStagingQuarantineRoot,
  getStagingRoot,
  inspectStagingRoot,
  requireStagingRoot,
} from "../dist/storage/staging.js";

async function withStagingEnvironment(run) {
  const sandboxBase = await mkdtemp(join(await realpath(tmpdir()), "asd-staging-storage-"));
  const runtimeRoot = join(sandboxBase, "runtime");
  const previousRuntimeRoot = process.env[runtimeRootOverrideEnvVar];
  const previousStagingRoot = process.env[stagingRootOverrideEnvVar];
  process.env[runtimeRootOverrideEnvVar] = runtimeRoot;
  delete process.env[stagingRootOverrideEnvVar];

  try {
    await run({ runtimeRoot, sandboxBase });
  } finally {
    if (previousRuntimeRoot === undefined) {
      delete process.env[runtimeRootOverrideEnvVar];
    } else {
      process.env[runtimeRootOverrideEnvVar] = previousRuntimeRoot;
    }
    if (previousStagingRoot === undefined) {
      delete process.env[stagingRootOverrideEnvVar];
    } else {
      process.env[stagingRootOverrideEnvVar] = previousStagingRoot;
    }
    await rm(sandboxBase, { force: true, recursive: true });
  }
}

test("staging defaults beneath the runtime root and is created for writes", async () => {
  await withStagingEnvironment(async ({ runtimeRoot }) => {
    const expectedRoot = join(runtimeRoot, "staging");

    assert.equal(getStagingRoot(), expectedRoot);
    assert.deepEqual(await inspectStagingRoot(), {
      available: false,
      configured: false,
      device: null,
      error: `staging root is unavailable: ${expectedRoot}`,
      root: expectedRoot,
      writable: false,
    });

    assert.equal(await ensureStagingRoot(), expectedRoot);
    await access(expectedRoot);
    assert.equal(await requireStagingRoot("write"), expectedRoot);
  });
});

test("a pre-created absolute override owns parsed, reduced, and quarantine paths", async () => {
  await withStagingEnvironment(async ({ runtimeRoot, sandboxBase }) => {
    const stagingRoot = join(sandboxBase, "external", "staging");
    await mkdir(stagingRoot, { recursive: true });
    process.env[stagingRootOverrideEnvVar] = stagingRoot;

    assert.equal(getRuntimePath("staging"), join(runtimeRoot, "staging"));
    assert.equal(await ensureStagingRoot(), stagingRoot);
    const inspection = await inspectStagingRoot("write");
    assert.equal(inspection.available, true);
    assert.equal(inspection.configured, true);
    assert.equal(inspection.device, (await stat(stagingRoot)).dev);
    assert.equal(inspection.error, null);
    assert.equal(inspection.root, stagingRoot);
    assert.equal(inspection.writable, true);
    assert.equal(
      getParsedStagingArtifactPath("session-1"),
      join(stagingRoot, "session-1", "parsed-records.json"),
    );
    assert.equal(
      getReducedStagingArtifactPath("session-1"),
      join(stagingRoot, "session-1", "reduced-session.json"),
    );
    assert.equal(getStagingQuarantineRoot(), join(stagingRoot, ".parsed-cleanup-quarantine"));
  });
});

test("configured staging failures never create or redirect the requested root", async () => {
  await withStagingEnvironment(async ({ sandboxBase }) => {
    process.env[stagingRootOverrideEnvVar] = "relative/staging";
    await assert.rejects(() => ensureStagingRoot(), /must be an absolute path/);

    const missingRoot = join(sandboxBase, "missing", "staging");
    process.env[stagingRootOverrideEnvVar] = missingRoot;
    await assert.rejects(() => ensureStagingRoot(), /is unavailable/);
    await assert.rejects(() => access(dirname(missingRoot)));

    const fileRoot = join(sandboxBase, "staging-file");
    await writeFile(fileRoot, "not a directory\n", "utf8");
    process.env[stagingRootOverrideEnvVar] = fileRoot;
    await assert.rejects(() => ensureStagingRoot(), /must be a directory/);

    const realRoot = join(sandboxBase, "real-staging");
    const linkedRoot = join(sandboxBase, "linked-staging");
    await mkdir(realRoot);
    await symlink(realRoot, linkedRoot);
    process.env[stagingRootOverrideEnvVar] = linkedRoot;
    await assert.rejects(() => ensureStagingRoot(), /must not traverse symbolic links/);
  });
});

test("configured staging requires write and traversal permission", async () => {
  await withStagingEnvironment(async ({ sandboxBase }) => {
    const stagingRoot = join(sandboxBase, "read-only-staging");
    await mkdir(stagingRoot);
    process.env[stagingRootOverrideEnvVar] = stagingRoot;
    await chmod(stagingRoot, 0o500);

    try {
      await assert.rejects(() => ensureStagingRoot(), /is not writable/);
    } finally {
      await chmod(stagingRoot, 0o700);
    }
  });
});

test("session artifact paths reject traversal and ambiguous directory names", async () => {
  await withStagingEnvironment(async () => {
    for (const sessionId of ["", ".", "..", "../escape", "nested/session", "nested\\session"]) {
      assert.throws(() => getParsedStagingArtifactPath(sessionId), /invalid staging session id/);
      assert.throws(() => getReducedStagingArtifactPath(sessionId), /invalid staging session id/);
    }
  });
});

test("parsed cleanup chooses a same-device local quarantine and cross-device staging quarantine", async () => {
  await withStagingEnvironment(async ({ runtimeRoot, sandboxBase }) => {
    const stagingRoot = join(sandboxBase, "external-staging");
    await mkdir(stagingRoot);
    process.env[stagingRootOverrideEnvVar] = stagingRoot;

    const fakeFileSystem = (stagingDevice, deletesDevice) => ({
      stat: async (path) => ({ dev: path === stagingRoot ? stagingDevice : deletesDevice }),
    });

    assert.equal(
      await selectParsedCleanupQuarantineRoot(fakeFileSystem(10, 10)),
      join(runtimeRoot, "deletes", "parsed-cleanup-quarantine"),
    );
    assert.equal(
      await selectParsedCleanupQuarantineRoot(fakeFileSystem(10, 20)),
      join(stagingRoot, ".parsed-cleanup-quarantine"),
    );
  });
});
