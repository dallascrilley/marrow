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
  resolveProjectId,
} from "../dist/v2/project/resolve.js";

const execFileAsync = promisify(execFile);

test("normaliseGitRemote strips scheme and .git suffix", () => {
  assert.equal(normaliseGitRemote("https://GitHub.com/Org/Repo.git"), "github.com/org/repo");
});

test("resolveProjectId prefers git remote over path and declared key", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "asd-v2-proj-"));
  await execFileAsync("git", ["init"], { cwd: workspace });
  await execFileAsync("git", ["remote", "add", "origin", "git@github.com:acme/demo.git"], {
    cwd: workspace,
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
