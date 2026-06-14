import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { hashToProjectId } from "../dist/v2/project/resolve.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(testDir);
const cliPath = join(projectRoot, "dist", "cli.js");
const runtimeOverrideEnvVar = "AGENT_SESSION_DISTILLERY_ROOT";

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
    },
  });
}

test("memory export-wiki writes stable reviewed-memory JSONL from project learnings", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "asd-wiki-export-"));
  const runtimeRoot = join(sandbox, "runtime-root");

  try {
    const knowledgeDir = join(runtimeRoot, "knowledge", "projects", "agent-session-distillery");
    await mkdir(knowledgeDir, { recursive: true });
    await writeFile(
      join(knowledgeDir, "session-1.jsonl"),
      `${JSON.stringify({
        learning_id: "session-1:project:decision:event-1",
        scope: "project",
        scope_key: "agent-session-distillery",
        kind: "decision",
        title: "Keep the wiki import boundary narrow",
        statement:
          "Use a versioned JSONL export contract between distillery and the wiki importer.",
        evidence: ["The integration design selected a hybrid export/import boundary."],
        confidence: "high",
        promotion_basis: "Explicit implementation decision captured during integration planning.",
        source_refs: [
          {
            source_path: "/tmp/session-1.jsonl",
            source_hash: "sha256:session-1",
            session_id: "session-1",
            turn_id: "turn-1",
            event_id: "event-1",
            line: 42,
          },
        ],
      })}\n`,
      "utf8",
    );

    const result = runCli(["memory", "export-wiki"], {
      [runtimeOverrideEnvVar]: runtimeRoot,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Exported 1 wiki memory record/);

    const exportPath = join(runtimeRoot, "exports", "wiki-memory", "reviewed-memory.jsonl");
    const lines = (await readFile(exportPath, "utf8")).trim().split("\n");
    assert.equal(lines.length, 1);
    const firstExport = await readFile(exportPath, "utf8");
    const rerun = runCli(["memory", "export-wiki"], {
      [runtimeOverrideEnvVar]: runtimeRoot,
    });
    assert.equal(rerun.status, 0, rerun.stderr);
    assert.equal(await readFile(exportPath, "utf8"), firstExport);

    const record = JSON.parse(lines[0]);
    assert.equal(record.schema_version, "asd.wiki_memory.v1");
    assert.match(record.id, /^sha256:[a-f0-9]{64}$/);
    assert.equal(record.kind, "project_learning");
    assert.equal(record.project.key, hashToProjectId("agent-session-distillery"));
    assert.equal(record.project.root, null);
    assert.equal(record.title, "Keep the wiki import boundary narrow");
    assert.equal(
      record.body,
      "Use a versioned JSONL export contract between distillery and the wiki importer.",
    );
    assert.deepEqual(record.evidence.source_refs[0], {
      source_path: "/tmp/session-1.jsonl",
      source_hash: "sha256:session-1",
      session_id: "session-1",
      turn_id: "turn-1",
      event_id: "event-1",
      line: 42,
    });
    assert.deepEqual(record.review, {
      verdict: "keep",
      confidence: "high",
      source: "deterministic-export",
    });
  } finally {
    await rm(sandbox, { force: true, recursive: true });
  }
});

test("memory export-wiki prefers reviewed project learnings when present", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "asd-wiki-reviewed-export-"));
  const runtimeRoot = join(sandbox, "runtime-root");

  try {
    const deterministicDir = join(runtimeRoot, "knowledge", "projects", "agent-session-distillery");
    const reviewedDir = join(
      runtimeRoot,
      "knowledge",
      "projects-reviewed",
      "agent-session-distillery",
    );
    await mkdir(deterministicDir, { recursive: true });
    await mkdir(reviewedDir, { recursive: true });
    const baseLearning = {
      learning_id: "session-1:project:decision:event-1",
      scope: "project",
      scope_key: "agent-session-distillery",
      kind: "decision",
      title: "Keep the wiki import boundary narrow",
      statement: "Use deterministic project learning only as fallback.",
      evidence: ["The integration design selected a hybrid export/import boundary."],
      confidence: "high",
      promotion_basis: "Explicit implementation decision captured during integration planning.",
      source_refs: [
        {
          source_path: "/tmp/session-1.jsonl",
          source_hash: "sha256:session-1",
          session_id: "session-1",
          turn_id: "turn-1",
          event_id: "event-1",
          line: 42,
        },
      ],
    };
    await writeFile(
      join(deterministicDir, "session-1.jsonl"),
      `${JSON.stringify(baseLearning)}\n`,
      "utf8",
    );
    await writeFile(
      join(reviewedDir, "session-1.jsonl"),
      `${JSON.stringify({
        ...baseLearning,
        statement: "Use reviewed project learnings for wiki export when they exist.",
        promotion_basis:
          "Explicit implementation decision captured during integration planning. LLM-reviewed with rewrite verdict.",
      })}\n`,
      "utf8",
    );

    const result = runCli(["memory", "export-wiki"], {
      [runtimeOverrideEnvVar]: runtimeRoot,
    });

    assert.equal(result.status, 0, result.stderr);
    const exportPath = join(runtimeRoot, "exports", "wiki-memory", "reviewed-memory.jsonl");
    const [line] = (await readFile(exportPath, "utf8")).trim().split("\n");
    const record = JSON.parse(line);
    assert.equal(record.body, "Use reviewed project learnings for wiki export when they exist.");
    assert.deepEqual(record.review, {
      verdict: "keep",
      confidence: "high",
      source: "reviewed-export",
    });
  } finally {
    await rm(sandbox, { force: true, recursive: true });
  }
});
