import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { deriveCursorWorkspaceMapping } from "../dist/adapters/cursor/workspace-map.js";

async function withSyntheticProjects(run) {
  const sandboxRoot = await mkdtemp(join(tmpdir(), "marrow-cursor-map-"));

  try {
    await run(sandboxRoot);
  } finally {
    await rm(sandboxRoot, { force: true, recursive: true });
  }
}

test("derives project_key from local workspace hints before falling back to slug text", async () => {
  await withSyntheticProjects(async (sandboxRoot) => {
    const cursorProjectsRoot = join(sandboxRoot, ".cursor", "projects");
    const workspacePath = join(sandboxRoot, "Code", "marrow");
    const workspaceSlug = encodeURIComponent(workspacePath);
    const transcriptPath = join(
      cursorProjectsRoot,
      workspaceSlug,
      "agent-transcripts",
      "composer-2026-05-16T08-30-00.000Z.jsonl",
    );

    await mkdir(workspacePath, { recursive: true });
    await mkdir(dirname(transcriptPath), { recursive: true });
    await writeFile(
      join(cursorProjectsRoot, workspaceSlug, "metadata.json"),
      JSON.stringify({ folders: [{ path: workspacePath }] }, null, 2),
      "utf8",
    );
    await writeFile(transcriptPath, '{"ok":true}\n', "utf8");

    const mapping = await deriveCursorWorkspaceMapping(transcriptPath, { cursorProjectsRoot });

    assert.deepEqual(mapping, {
      cursorProjectPath: join(cursorProjectsRoot, workspaceSlug),
      projectKey: "marrow",
      workspacePath,
      workspaceSlug,
    });
  });
});

test("falls back to the workspace slug when no local workspace hint resolves", async () => {
  await withSyntheticProjects(async (sandboxRoot) => {
    const cursorProjectsRoot = join(sandboxRoot, ".cursor", "projects");
    const workspaceSlug = "forum-documented-sample";
    const transcriptPath = join(
      cursorProjectsRoot,
      workspaceSlug,
      "agent-transcripts",
      "chat-2026-05-16T08-45-00.000Z.txt",
    );

    await mkdir(dirname(transcriptPath), { recursive: true });
    await writeFile(transcriptPath, "assistant: ok\n", "utf8");

    const mapping = await deriveCursorWorkspaceMapping(transcriptPath, { cursorProjectsRoot });

    assert.deepEqual(mapping, {
      cursorProjectPath: join(cursorProjectsRoot, workspaceSlug),
      projectKey: "forum-documented-sample",
      workspacePath: null,
      workspaceSlug,
    });
  });
});
