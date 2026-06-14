import assert from "node:assert/strict";
import test from "node:test";

import { processDiscoveredSessions } from "../dist/commands/ingest-backfill.js";
import { createLedger } from "../dist/db/ledger.js";

test("processDiscoveredSessions continues after a per-session failure", async () => {
  const database = await createLedger();
  const goodEntry = {
    ledger: {
      sourceChanged: false,
      sourceSession: {
        id: 1,
        conversation_id: "demo:good",
        ingest_status: "discovered",
        project_key: "demo",
        retention_status: "kept",
        session_id: "good-session",
        source_format: "jsonl",
        source_hash: "sha256:good",
        source_path: "/nonexistent/good.jsonl",
        source_tool: "cursor",
        started_at: "2026-05-22T19:00:00.000Z",
        updated_at: "2026-05-22T20:00:00.000Z",
        workspace_path: "/tmp/demo",
      },
    },
  };
  const badEntry = {
    ledger: {
      sourceChanged: false,
      sourceSession: {
        id: 2,
        conversation_id: "demo:bad",
        ingest_status: "discovered",
        project_key: "demo",
        retention_status: "kept",
        session_id: "bad-session",
        source_format: "jsonl",
        source_hash: "sha256:bad",
        source_path: "/nonexistent/bad.jsonl",
        source_tool: "cursor",
        started_at: "2026-05-22T19:00:00.000Z",
        updated_at: "2026-05-22T20:00:00.000Z",
        workspace_path: "/tmp/demo",
      },
    },
  };

  const result = await processDiscoveredSessions(database, [badEntry, goodEntry], false, false);

  assert.equal(result.sessions.length, 0);
  assert.equal(result.failed_count, 2);
  assert.equal(result.failures.length, 2);
  assert.ok(result.failures[0]?.error.length > 0);
  assert.ok(result.failures[1]?.error.length > 0);
});
