import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  hashToProjectId,
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
  const workspace = await mkdtemp(join(tmpdir(), "asd-v2-proj-"));
  await execFileAsync("git", ["init"], { cwd: workspace, env: GIT_ENV });
  await execFileAsync("git", ["remote", "add", "origin", "git@github.com:acme/demo.git"], {
    cwd: workspace,
    env: GIT_ENV,
  });
  await writeFile(join(workspace, ".asd-project-key"), "manual-key", "utf8");

  const resolved = await resolveProjectId({
    workspacePath: workspace,
    sessionRoot: workspace,
  });

  assert.equal(resolved.source, "git-remote");
  assert.equal(resolved.id, hashToProjectId("github.com/acme/demo"));
  assert.notEqual(resolved.id, "manual-key");
});

test("resolveProjectId uses declared key when workspace missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "asd-v2-declared-"));
  await writeFile(join(root, ".asd-project-key"), "my-stable-key", "utf8");

  const resolved = await resolveProjectId({
    workspacePath: null,
    sessionRoot: root,
  });

  assert.equal(resolved.source, "declared-key");
  assert.equal(resolved.id, hashToProjectId("my-stable-key"));
});

test("resolveProjectId path-hash when no git remote", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "asd-v2-path-"));
  const resolved = await resolveProjectId({
    workspacePath: workspace,
    sessionRoot: workspace,
  });

  assert.equal(resolved.source, "path-hash");
  assert.match(resolved.id, /^[0-9a-f]{12}$/u);
});

test("resolveProjectId uses declared key over path hash when no git remote", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "asd-v2-declared-ws-"));
  await writeFile(join(workspace, ".asd-project-key"), "my-stable-key", "utf8");

  const resolved = await resolveProjectId({
    workspacePath: workspace,
    sessionRoot: workspace,
  });

  assert.equal(resolved.source, "declared-key");
  assert.equal(resolved.id, hashToProjectId("my-stable-key"));
});

test("resolveProjectId memoizes the git-remote probe per workspace path", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "asd-v2-memo-ws-"));
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
