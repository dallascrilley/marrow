import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { discoverCursorInputs } from "../dist/adapters/cursor/discover.js";

async function withSyntheticHome(run) {
  const sandboxRoot = await mkdtemp(join(tmpdir(), "marrow-cursor-discovery-"));
  const homeDir = join(sandboxRoot, "home");
  await mkdir(homeDir, { recursive: true });

  try {
    await run(homeDir);
  } finally {
    await rm(sandboxRoot, { force: true, recursive: true });
  }
}

async function writeFixture(filePath, content, modifiedAt) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");

  if (modifiedAt) {
    await utimes(filePath, modifiedAt, modifiedAt);
  }
}

function sha256(content) {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

test("discovers Cursor transcripts with hashes, metadata, and optional support databases", async () => {
  await withSyntheticHome(async (homeDir) => {
    const workspaceOne = join(homeDir, "Code", "marrow");
    const workspaceTwo = join(homeDir, "Code", "secondary-workspace");
    await mkdir(workspaceOne, { recursive: true });
    await mkdir(workspaceTwo, { recursive: true });

    const encodedSlug = encodeURIComponent(workspaceOne);
    const firstProjectRoot = join(homeDir, ".cursor", "projects", encodedSlug);
    const secondProjectRoot = join(homeDir, ".cursor", "projects", "secondary-workspace");
    const firstTranscriptPath = join(
      firstProjectRoot,
      "agent-transcripts",
      "composer-2026-05-16T08-30-00.000Z",
      "composer-2026-05-16T08-30-00.000Z.jsonl",
    );
    const secondTranscriptPath = join(
      secondProjectRoot,
      "agent-transcripts",
      "chat-2026-05-16T08-45-00.000Z",
      "subagents",
      "chat-2026-05-16T08-45-00.000Z.txt",
    );
    const firstTranscriptContent = '{"type":"user","message":"hello"}\n';
    const secondTranscriptContent = "assistant: hi there\n";
    const firstModifiedAt = new Date("2026-05-16T08:31:00.000Z");
    const secondModifiedAt = new Date("2026-05-16T08:46:00.000Z");

    await writeFixture(
      join(firstProjectRoot, "workspace.json"),
      JSON.stringify({ workspacePath: workspaceOne }, null, 2),
    );
    await writeFixture(firstTranscriptPath, firstTranscriptContent, firstModifiedAt);
    await writeFixture(secondTranscriptPath, secondTranscriptContent, secondModifiedAt);
    await writeFixture(
      join(
        homeDir,
        "Library",
        "Application Support",
        "Cursor",
        "User",
        "globalStorage",
        "state.vscdb",
      ),
      "global-state",
    );
    await writeFixture(
      join(
        homeDir,
        "Library",
        "Application Support",
        "Cursor",
        "User",
        "workspaceStorage",
        "workspace-0001",
        "state.vscdb",
      ),
      "tracking-state",
    );
    await writeFixture(
      join(secondProjectRoot, "agent-transcripts", "ignore.md"),
      "# not a transcript\n",
    );

    const result = await discoverCursorInputs({ homeDir });

    assert.equal(result.transcripts.length, 2);
    assert.deepEqual(
      result.transcripts.map((entry) => ({
        modifiedAt: entry.modifiedAt,
        projectKey: entry.projectKey,
        sizeBytes: entry.sizeBytes,
        sourceFormat: entry.sourceFormat,
        sourceHash: entry.sourceHash,
        sourcePath: entry.sourcePath,
        workspacePath: entry.workspacePath,
        workspaceSlug: entry.workspaceSlug,
      })),
      [
        {
          modifiedAt: firstModifiedAt.toISOString(),
          projectKey: "marrow",
          sizeBytes: Buffer.byteLength(firstTranscriptContent),
          sourceFormat: "jsonl",
          sourceHash: sha256(firstTranscriptContent),
          sourcePath: firstTranscriptPath,
          workspacePath: workspaceOne,
          workspaceSlug: encodedSlug,
        },
        {
          modifiedAt: secondModifiedAt.toISOString(),
          projectKey: "secondary-workspace",
          sizeBytes: Buffer.byteLength(secondTranscriptContent),
          sourceFormat: "txt",
          sourceHash: sha256(secondTranscriptContent),
          sourcePath: secondTranscriptPath,
          workspacePath: null,
          workspaceSlug: "secondary-workspace",
        },
      ],
    );

    assert.deepEqual(result.supportDatabases, [
      {
        kind: "global-state",
        path: join(
          homeDir,
          "Library",
          "Application Support",
          "Cursor",
          "User",
          "globalStorage",
          "state.vscdb",
        ),
      },
      {
        kind: "tracking",
        path: join(
          homeDir,
          "Library",
          "Application Support",
          "Cursor",
          "User",
          "workspaceStorage",
          "workspace-0001",
          "state.vscdb",
        ),
      },
    ]);
  });
});

test("missing Cursor tracking databases do not fail transcript discovery", async () => {
  await withSyntheticHome(async (homeDir) => {
    const workspaceDir = join(homeDir, "Code", "solo-workspace");
    const transcriptPath = join(
      homeDir,
      ".cursor",
      "projects",
      "solo-workspace",
      "agent-transcripts",
      "composer-2026-05-16T09-00-00.000Z",
      "composer-2026-05-16T09-00-00.000Z.jsonl",
    );
    const transcriptContent = '{"type":"assistant","message":"ok"}\n';

    await mkdir(workspaceDir, { recursive: true });
    await writeFixture(transcriptPath, transcriptContent, new Date("2026-05-16T09:00:30.000Z"));

    const result = await discoverCursorInputs({ homeDir });

    assert.equal(result.transcripts.length, 1);
    assert.equal(result.transcripts[0].projectKey, "solo-workspace");
    assert.deepEqual(result.supportDatabases, []);
  });
});

test("skips root-level Cursor agent-transcripts directory without aborting sibling discovery", async () => {
  await withSyntheticHome(async (homeDir) => {
    const workspaceDir = join(homeDir, "Code", "valid-workspace");
    const validProjectRoot = join(homeDir, ".cursor", "projects", "valid-workspace");
    const validTranscriptPath = join(
      validProjectRoot,
      "agent-transcripts",
      "session-valid",
      "session-valid.jsonl",
    );
    const validTranscriptContent = '{"type":"assistant","message":"ok"}\n';
    const strayTranscriptPath = join(
      homeDir,
      ".cursor",
      "projects",
      "agent-transcripts",
      "e6b6e195-9815-466a-bfb6-c493b5c302f9",
      "e6b6e195-9815-466a-bfb6-c493b5c302f9.jsonl",
    );

    await mkdir(workspaceDir, { recursive: true });
    await writeFixture(
      join(validProjectRoot, "workspace.json"),
      JSON.stringify({ workspacePath: workspaceDir }, null, 2),
    );
    await writeFixture(validTranscriptPath, validTranscriptContent);
    await writeFixture(strayTranscriptPath, '{"type":"assistant","message":"stray"}\n');

    const result = await discoverCursorInputs({ homeDir });

    assert.equal(result.transcripts.length, 1);
    assert.equal(result.transcripts[0].sourcePath, validTranscriptPath);
    assert.equal(result.transcripts[0].sourceHash, sha256(validTranscriptContent));
    assert.equal(result.transcripts[0].workspaceSlug, "valid-workspace");
    assert.equal(result.transcripts[0].projectKey, "valid-workspace");
  });
});
