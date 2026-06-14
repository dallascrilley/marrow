import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { enrichCursorStateDb } from "../dist/adapters/cursor/enrich-state-db.js";
import { enrichCursorTrackingDb } from "../dist/adapters/cursor/enrich-tracking-db.js";

const fixturesRoot = join(import.meta.dirname, "fixtures", "cursor");

test("state DB enrichment reads composer and workspace metadata from the frozen fixture", () => {
  const enrichment = enrichCursorStateDb({
    databasePath: join(fixturesRoot, "state.vscdb"),
  });

  assert.deepEqual(enrichment, {
    activeComposerIds: ["cmp-active"],
    conversationIds: ["conv-123", "conv-older"],
    matchedKeys: ["cursor.composer.active", "cursor.composer.recent", "cursor.workspace.roots"],
    workspaceIds: ["ws-001"],
    workspacePaths: ["/Users/example/Code/distillery", "/Users/example/Code/shared"],
  });
});

test("tracking DB enrichment is optional and non-fatal while still improving attribution", () => {
  const enrichment = enrichCursorTrackingDb({
    databasePath: join(fixturesRoot, "tracking-state.vscdb"),
  });

  assert.deepEqual(enrichment, {
    activeComposerIds: ["cmp-active"],
    matchedKeys: ["tracking.attribution", "tracking.session.active", "tracking.workspace.paths"],
    requestIds: ["req-9"],
    sessionIds: ["session-42"],
    workspaceIds: ["ws-001"],
    workspacePaths: ["/Users/example/Code/distillery"],
    workspaceStorageIds: ["workspace-storage-777"],
  });
});

test("tracking DB enrichment swallows read failures and returns no attribution", () => {
  const enrichment = enrichCursorTrackingDb({
    databasePath: join(fixturesRoot, "missing-tracking-state.vscdb"),
  });

  assert.equal(enrichment, null);
});
