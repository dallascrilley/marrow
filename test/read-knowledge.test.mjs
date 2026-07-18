import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createLedger, upsertSourceSession } from "../dist/db/ledger.js";
import { listKnowledgeSnapshot } from "../dist/read/knowledge.js";
import { saveInstinct } from "../dist/v2/instinct/store.js";

import { hashToProjectId } from "../dist/v2/project/resolve.js";

const runtimeOverrideEnvVar = "AGENT_SESSION_DISTILLERY_ROOT";

async function withRuntime(run) {
  const sandbox = await mkdtemp(join(tmpdir(), "asd-read-knowledge-"));
  const runtimeRoot = join(sandbox, "runtime-root");
  const previousOverride = process.env[runtimeOverrideEnvVar];

  process.env[runtimeOverrideEnvVar] = runtimeRoot;

  try {
    await run(runtimeRoot, sandbox);
  } finally {
    if (previousOverride === undefined) {
      delete process.env[runtimeOverrideEnvVar];
    } else {
      process.env[runtimeOverrideEnvVar] = previousOverride;
    }
    await rm(sandbox, { force: true, recursive: true });
  }
}

test("listKnowledgeSnapshot returns merged project learnings and project instincts", async () => {
  await withRuntime(async (runtimeRoot, sandbox) => {
    const projectId = hashToProjectId("/Users/example/Code/demo");
    const database = await createLedger();
    const sessionId = "knowledge-session";
    const sourcePath = join(sandbox, "knowledge-session.jsonl");
    await writeFile(sourcePath, '{"type":"session"}\n', "utf8");
    upsertSourceSession(database, {
      conversation_id: `demo:${sessionId}`,
      ingest_status: "archived",
      project_key: "demo",
      retention_status: "kept",
      session_id: sessionId,
      source_format: "jsonl",
      source_hash: `sha256:${sessionId}`,
      source_path: sourcePath,
      source_tool: "cursor",
      started_at: "2026-06-24T00:00:00.000Z",
      updated_at: "2026-06-24T00:10:00.000Z",
      workspace_path: "/Users/example/Code/demo",
    });

    const knowledgeDir = join(runtimeRoot, "knowledge", "projects", "demo");
    await mkdir(knowledgeDir, { recursive: true });
    await writeFile(
      join(knowledgeDir, `${sessionId}.jsonl`),
      `${JSON.stringify({
        learning_id: `${sessionId}:project:workflow:event-1`,
        scope: "project",
        scope_key: "demo",
        kind: "workflow",
        title: "Reuse shared read surfaces",
        trigger: "When adding a dashboard view in ASD.",
        statement: "Reuse shared typed readers instead of adding a dashboard-only query path.",
        evidence: ["The report exporter already consumed shared read modules."],
        confidence: "high",
        evidence_type: "inferred",
        promotion_basis: "Observed during dashboard implementation.",
        source_refs: [
          {
            source_path: sourcePath,
            source_hash: `sha256:${sessionId}`,
            session_id: sessionId,
            turn_id: `${sessionId}:turn-0000`,
            event_id: "event-1",
            line: 12,
          },
        ],
      })}\n`,
      "utf8",
    );

    await saveInstinct(projectId, {
      schema_version: 1,
      id: "dashboard-instinct-aaaa1111",
      trigger: "When extending the dashboard",
      finding: "Keep the knowledge explorer read-only and reuse shared readers.",
      confidence: 0.74,
      domain: "workflow",
      maturity: "established",
      scope: "project",
      project_id: projectId,
      source: {
        first_session: sessionId,
        first_observed_at: "2026-06-24T00:10:00.000Z",
        source_refs: [{ kind: "file", path: "src/read/knowledge.ts", session: sessionId }],
        observations: [{ session: sessionId, reinforcing: true, at: "2026-06-24T00:10:00.000Z" }],
      },
      related: [],
      created_at: "2026-06-24T00:10:00.000Z",
      updated_at: "2026-06-24T00:11:00.000Z",
      last_promoted_at: null,
    });

    const snapshot = await listKnowledgeSnapshot(database);
    database.close();

    assert.equal(snapshot.total_learnings, 1);
    assert.equal(snapshot.total_instincts, 1);
    assert.equal(snapshot.projects.length, 1);
    assert.equal(snapshot.projects[0]?.project_id, projectId);
    assert.equal(snapshot.projects[0]?.learnings[0]?.title, "Reuse shared read surfaces");
    assert.equal(snapshot.instincts[0]?.id, "dashboard-instinct-aaaa1111");
    assert.equal(snapshot.instincts[0]?.source.source_refs[0]?.path, "src/read/knowledge.ts");
  });
});

test("listKnowledgeSnapshot ignores metadata files beside reviewed project directories", async () => {
  await withRuntime(async (runtimeRoot) => {
    const database = await createLedger();
    const reviewedRoot = join(runtimeRoot, "knowledge", "projects-reviewed");
    await mkdir(join(reviewedRoot, "demo"), { recursive: true });
    await writeFile(join(reviewedRoot, ".DS_Store"), "metadata", "utf8");

    try {
      const snapshot = await listKnowledgeSnapshot(database);
      assert.equal(snapshot.projects.length, 1);
      assert.equal(snapshot.projects[0]?.source, "reviewed-export");
    } finally {
      database.close();
    }
  });
});
