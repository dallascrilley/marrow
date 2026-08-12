import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  hashToProjectId,
  isDefinitiveGitMiss,
  normaliseGitRemote,
  resetProjectIdCache,
  resolveProjectId,
} from "../dist/v2/project/resolve.js";

const execFileAsync = promisify(execFile);

// Strip inherited git env vars (GIT_DIR/GIT_WORK_TREE, exported when this suite
// runs inside a git hook like pre-push) so the temp-repo setup below targets the
// fixture dir via -C/cwd instead of the ambient host repo.
const GIT_ENV = (() => {
  const env = { ...process.env };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_PREFIX",
    "GIT_COMMON_DIR",
  ]) {
    delete env[key];
  }
  return env;
})();

test("normaliseGitRemote strips scheme and .git suffix", () => {
  assert.equal(normaliseGitRemote("https://GitHub.com/Org/Repo.git"), "github.com/org/repo");
});

test("resolveProjectId prefers git remote over path and declared key", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "marrow-v2-proj-"));
  await execFileAsync("git", ["init"], { cwd: workspace, env: GIT_ENV });
  await execFileAsync("git", ["remote", "add", "origin", "git@github.com:acme/demo.git"], {
    cwd: workspace,
    env: GIT_ENV,
  });
  await writeFile(join(workspace, ".marrow-project-key"), "manual-key", "utf8");

  const resolved = await resolveProjectId({
    workspacePath: workspace,
    sessionRoot: workspace,
  });

  assert.equal(resolved.source, "git-remote");
  assert.equal(resolved.id, hashToProjectId("github.com/acme/demo"));
  assert.notEqual(resolved.id, "manual-key");
});

test("resolveProjectId uses declared key when workspace missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "marrow-v2-declared-"));
  await writeFile(join(root, ".marrow-project-key"), "my-stable-key", "utf8");

  const resolved = await resolveProjectId({
    workspacePath: null,
    sessionRoot: root,
  });

  assert.equal(resolved.source, "declared-key");
  assert.equal(resolved.id, hashToProjectId("my-stable-key"));
});

test("resolveProjectId path-hash when no git remote", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "marrow-v2-path-"));
  const resolved = await resolveProjectId({
    workspacePath: workspace,
    sessionRoot: workspace,
  });

  assert.equal(resolved.source, "path-hash");
  assert.match(resolved.id, /^[0-9a-f]{12}$/u);
});

test("resolveProjectId uses declared key over path hash when no git remote", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "marrow-v2-declared-ws-"));
  await writeFile(join(workspace, ".marrow-project-key"), "my-stable-key", "utf8");

  const resolved = await resolveProjectId({
    workspacePath: workspace,
    sessionRoot: workspace,
  });

  assert.equal(resolved.source, "declared-key");
  assert.equal(resolved.id, hashToProjectId("my-stable-key"));
});

test("resolveProjectId memoizes the git-remote probe per workspace path", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "marrow-v2-memo-ws-"));
  await execFileAsync("git", ["init"], { cwd: workspace, env: GIT_ENV });
  await execFileAsync("git", ["remote", "add", "origin", "git@github.com:acme/first.git"], {
    cwd: workspace,
    env: GIT_ENV,
  });

  resetProjectIdCache();
  const first = await resolveProjectId({ workspacePath: workspace, sessionRoot: workspace });
  assert.equal(first.id, hashToProjectId("github.com/acme/first"));

  // Change origin on disk but DON'T clear the cache: the memoized probe must
  // still return the original id (proving the second resolve skipped the fork).
  await execFileAsync("git", ["remote", "set-url", "origin", "git@github.com:acme/second.git"], {
    cwd: workspace,
    env: GIT_ENV,
  });
  const cached = await resolveProjectId({ workspacePath: workspace, sessionRoot: workspace });
  assert.equal(cached.id, hashToProjectId("github.com/acme/first"), "served from cache");

  // After a reset, the probe re-runs and picks up the new remote.
  resetProjectIdCache();
  const refreshed = await resolveProjectId({ workspacePath: workspace, sessionRoot: workspace });
  assert.equal(refreshed.id, hashToProjectId("github.com/acme/second"), "re-forked after reset");

  resetProjectIdCache();
});

test("isDefinitiveGitMiss distinguishes a git 'no' from an environmental failure", () => {
  // git actually RAN and answered no (not a repo / no origin): numeric exit
  // code, not killed → definitive, safe to cache.
  assert.equal(isDefinitiveGitMiss({ code: 1 }), true, "exit 1 (no origin) is definitive");
  assert.equal(isDefinitiveGitMiss({ code: 128 }), true, "exit 128 (not a repo) is definitive");
  assert.equal(
    isDefinitiveGitMiss({ code: 2, killed: false }),
    true,
    "explicit killed:false stays definitive",
  );

  // Environmental failures must NOT be cached, so the probe can retry later.
  assert.equal(
    isDefinitiveGitMiss({ code: "ENOENT" }),
    false,
    "git-not-found (string code) is environmental",
  );
  assert.equal(
    isDefinitiveGitMiss({ code: null, killed: true }),
    false,
    "timeout kill is environmental",
  );
  assert.equal(isDefinitiveGitMiss({}), false, "a shapeless rejection is not definitive");
  assert.equal(isDefinitiveGitMiss(new Error("boom")), false, "a bare Error is not definitive");
});

test("the pre-rename project-key filename is still honoured", async () => {
  // Marrow was called agent-session-distillery and read `.asd-project-key`.
  // A repo that already declares a key must keep the same project id.
  const root = await mkdtemp(join(tmpdir(), "marrow-legacy-project-key-"));
  try {
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, ".asd-project-key"), "legacy-key", "utf8");

    const resolved = await resolveProjectId({ workspacePath: workspace });
    assert.equal(resolved.source, "declared-key");
    assert.equal(resolved.id, hashToProjectId("legacy-key"));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("the current project-key filename wins over the pre-rename one", async () => {
  const root = await mkdtemp(join(tmpdir(), "marrow-project-key-precedence-"));
  try {
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, ".asd-project-key"), "legacy-key", "utf8");
    await writeFile(join(workspace, ".marrow-project-key"), "current-key", "utf8");

    const resolved = await resolveProjectId({ workspacePath: workspace });
    assert.equal(resolved.id, hashToProjectId("current-key"));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
