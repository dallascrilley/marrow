import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { deriveClaudeCodeWorkspaceMapping } from "../dist/adapters/claude-code/workspace-map.js";

test("decodes the leading-dash workspace slug back to an absolute path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "asd-ccwm-"));
  try {
    const projectsRoot = join(dir, ".claude", "projects");
    const workspaceDir = join(projectsRoot, "-Users-example-Code-demo");
    await mkdir(workspaceDir, { recursive: true });
    const transcriptPath = join(workspaceDir, "session.jsonl");
    await writeFile(transcriptPath, "", "utf8");

    const mapping = await deriveClaudeCodeWorkspaceMapping(transcriptPath, {
      claudeCodeProjectsRoot: projectsRoot,
    });

    assert.equal(mapping.workspaceSlug, "-Users-example-Code-demo");
    assert.equal(mapping.workspacePath, "/Users/example/Code/demo");
    assert.equal(mapping.projectKey, "demo");
    assert.equal(mapping.claudeCodeProjectPath, workspaceDir);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("handles deleted-workspace paths by returning the decoded value anyway", async () => {
  const dir = await mkdtemp(join(tmpdir(), "asd-ccwm-deleted-"));
  try {
    const projectsRoot = join(dir, ".claude", "projects");
    const workspaceDir = join(projectsRoot, "-tmp-no-longer-exists");
    await mkdir(workspaceDir, { recursive: true });
    const transcriptPath = join(workspaceDir, "session.jsonl");
    await writeFile(transcriptPath, "", "utf8");

    const mapping = await deriveClaudeCodeWorkspaceMapping(transcriptPath, {
      claudeCodeProjectsRoot: projectsRoot,
    });

    assert.equal(mapping.workspacePath, "/tmp/no/longer/exists");
    assert.equal(mapping.projectKey, "exists");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("throws when a transcript path is not nested under the projects root", async () => {
  const dir = await mkdtemp(join(tmpdir(), "asd-ccwm-bad-"));
  try {
    const looseTranscriptPath = join(dir, "stray.jsonl");
    await writeFile(looseTranscriptPath, "", "utf8");

    assert.throws(() =>
      deriveClaudeCodeWorkspaceMapping(looseTranscriptPath, {
        claudeCodeProjectsRoot: join(dir, "no-such-projects-root"),
      }),
    );
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});
