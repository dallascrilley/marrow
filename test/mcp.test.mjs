import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { getRuntimePath } from "../dist/config/paths.js";
import { saveInstinct } from "../dist/v2/instinct/store.js";
import { serializeInstinct } from "../dist/v2/instinct/yaml-io.js";
import { refreshPromotionQueue } from "../dist/v2/promotion/queue.js";

async function saveGlobalInstinct(instinct) {
  const dir = getRuntimePath("instinctsGlobal");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${instinct.id}.yaml`), serializeInstinct(instinct), "utf8");
}

const testDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(testDir);
const cliPath = join(projectRoot, "dist", "cli.js");
const runtimeOverrideEnvVar = "MARROW_ROOT";
const projectId = "mcptestproj01";
const matureObservations = [
  { session: "sess-1", reinforcing: true, at: "2026-05-20T00:00:00.000Z" },
  { session: "sess-2", reinforcing: true, at: "2026-05-28T00:00:00.000Z" },
  { session: "sess-3", reinforcing: true, at: "2026-06-05T00:00:00.000Z" },
];

function makeInstinct(overrides = {}) {
  return {
    schema_version: 1,
    id: "sqlite-migration-aaaa1111",
    trigger: "When migrating to SQLite",
    finding: "Update shared/db_sqlite.py and verify ./scripts/qa.",
    confidence: 0.74,
    domain: "tooling",
    maturity: "established",
    scope: "project",
    project_id: projectId,
    source: {
      first_session: "sess-1",
      first_observed_at: "2026-06-10T10:00:00.000Z",
      source_refs: [{ kind: "file", path: "shared/db_sqlite.py", session: "sess-1" }],
      observations: matureObservations,
    },
    related: [],
    created_at: "2026-06-10T10:00:00.000Z",
    updated_at: "2026-06-12T11:00:00.000Z",
    last_promoted_at: null,
    ...overrides,
  };
}

async function withRuntime(run) {
  const root = await mkdtemp(join(tmpdir(), "marrow-mcp-"));
  try {
    const prior = process.env[runtimeOverrideEnvVar];
    process.env[runtimeOverrideEnvVar] = root;
    try {
      await saveInstinct(projectId, makeInstinct());
      await run(root);
    } finally {
      if (prior === undefined) {
        delete process.env[runtimeOverrideEnvVar];
      } else {
        process.env[runtimeOverrideEnvVar] = prior;
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function runCli(root, args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, [runtimeOverrideEnvVar]: root },
  });
}

async function writeQueuedPromotionCandidate() {
  await saveInstinct(
    "proj-two00002",
    makeInstinct({
      id: "prefer-pnpm-aaaaaaaa",
      project_id: "proj-two00002",
      trigger: "When installing packages",
      finding: "Use pnpm in this repo.",
      confidence: 0.86,
      created_at: "2026-06-01T10:00:00.000Z",
      updated_at: "2026-06-12T11:00:00.000Z",
      source: {
        first_session: "sess-2",
        first_observed_at: "2026-05-20T00:00:00.000Z",
        source_refs: [{ kind: "file", path: "package.json", session: "sess-2" }],
        observations: matureObservations,
      },
    }),
  );
  await saveInstinct(
    "proj-three003",
    makeInstinct({
      id: "prefer-pnpm-aaaaaaaa",
      project_id: "proj-three003",
      trigger: "When installing packages",
      finding: "Use pnpm in this repo.",
      confidence: 0.88,
      created_at: "2026-06-01T10:00:00.000Z",
      updated_at: "2026-06-12T11:00:00.000Z",
      source: {
        first_session: "sess-3",
        first_observed_at: "2026-05-20T00:00:00.000Z",
        source_refs: [{ kind: "file", path: "package.json", session: "sess-3" }],
        observations: matureObservations,
      },
    }),
  );
  await refreshPromotionQueue("2026-06-25T00:00:00.000Z");
}

test("mcp search_instincts returns lexical hits scoped to the project", async () => {
  await withRuntime((root) => {
    const result = runCli(root, [
      "mcp",
      "search_instincts",
      "--project-id",
      projectId,
      "--query",
      "sqlite",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.hits.length, 1);
    assert.equal(payload.hits[0].instinct.id, "sqlite-migration-aaaa1111");
    assert.equal(payload.total_in_corpus, 1);
  });
});

test("mcp instincts_for_file matches an exact source_ref path", async () => {
  await withRuntime((root) => {
    const result = runCli(root, [
      "mcp",
      "instincts_for_file",
      "--project-id",
      projectId,
      "--path",
      "shared/db_sqlite.py",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.exact_hits.length, 1);
    assert.equal(payload.exact_hits[0].score, 1);
  });
});

test("mcp recent_instincts returns instincts in the window", async () => {
  await withRuntime((root) => {
    const result = runCli(root, [
      "mcp",
      "recent_instincts",
      "--project-id",
      projectId,
      "--window-days",
      "365",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.hits.length, 1);
    assert.ok(payload.window_start <= payload.window_end);
  });
});

test("mcp search_instincts does not expose queued promotion candidates as approved global instincts", async () => {
  await withRuntime(async (root) => {
    await writeQueuedPromotionCandidate();
    const result = runCli(root, [
      "mcp",
      "search_instincts",
      "--scope",
      "global",
      "--query",
      "pnpm",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.hits.length, 0);
    assert.equal(payload.total_in_corpus, 0);
  });
});

test("mcp search_instincts loads genuinely global-scoped instincts (U2 fix)", async () => {
  await withRuntime(async (root) => {
    // Before the fix, loadScopedInstincts only ever read the project store, so
    // a global-scope query silently returned nothing even when the global
    // store held instincts. Persist one to the global store and assert the
    // combined-scope default now surfaces it.
    await saveGlobalInstinct(
      makeInstinct({
        id: "always-pin-versions-bbbb2222",
        scope: "global",
        project_id: "globalstore0",
        trigger: "When adding a dependency",
        finding: "Pin exact versions across every repo.",
      }),
    );
    const result = runCli(root, [
      "mcp",
      "search_instincts",
      "--scope",
      "global",
      "--query",
      "pin versions",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.hits.length, 1);
    assert.equal(payload.hits[0].instinct.id, "always-pin-versions-bbbb2222");
    assert.equal(payload.hits[0].instinct.scope, "global");
  });
});

test("mcp serve speaks JSON-RPC: initialize, tools/list, tools/call", async () => {
  await withRuntime((root) => {
    const requests = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "recent_instincts",
          arguments: { project_id: projectId, window_days: 365 },
        },
      },
    ]
      .map((message) => JSON.stringify(message))
      .join("\n");
    const result = spawnSync(process.execPath, [cliPath, "mcp", "serve"], {
      cwd: projectRoot,
      encoding: "utf8",
      input: requests,
      env: { ...process.env, [runtimeOverrideEnvVar]: root },
    });
    assert.equal(result.status, 0, result.stderr);
    const responses = result.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(responses.length, 3);
    assert.equal(responses[0].result.protocolVersion, "2025-11-25");
    assert.equal(responses[1].result.tools.length, 3);
    assert.equal(responses[2].result.isError, false);
    assert.ok(responses[2].result.content[0].text.includes("sqlite-migration-aaaa1111"));
  });
});
