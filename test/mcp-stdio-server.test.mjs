import assert from "node:assert/strict";
import test from "node:test";
import { saveInstinct } from "../dist/v2/instinct/store.js";
import {
  handleMcpMessage,
  MCP_PROTOCOL_VERSION,
  runMcpStdioServer,
} from "../dist/v2/mcp/stdio-server.js";
import { withRuntimeRoot } from "./helpers/with-runtime-root.mjs";

const projectId = "stdiotestproj";
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

async function seedOneInstinct() {
  await saveInstinct(projectId, makeInstinct());
}

test("handleMcpMessage initialize reports protocol version and server info", async () => {
  const response = await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "initialize" });

  assert.equal(response.id, 1);
  assert.equal(response.result.protocolVersion, MCP_PROTOCOL_VERSION);
  assert.equal(response.result.serverInfo.name, "marrow");
  assert.deepEqual(response.result.capabilities, { tools: { listChanged: false } });
});

test("handleMcpMessage ping returns an empty result", async () => {
  const response = await handleMcpMessage({ jsonrpc: "2.0", id: "p1", method: "ping" });
  assert.deepEqual(response, { jsonrpc: "2.0", id: "p1", result: {} });
});

test("handleMcpMessage tools/list advertises exactly the 3 capped tools with schemas", async () => {
  const response = await handleMcpMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" });

  const names = response.result.tools.map((tool) => tool.name);
  assert.deepEqual(names.sort(), ["instincts_for_file", "recent_instincts", "search_instincts"]);
  const searchTool = response.result.tools.find((tool) => tool.name === "search_instincts");
  assert.equal(searchTool.inputSchema.required[0], "query");
});

test("handleMcpMessage is a no-op (returns null) for a notification without an id", async () => {
  const response = await handleMcpMessage({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(response, null);
});

test("handleMcpMessage rejects a null id as an invalid request", async () => {
  const response = await handleMcpMessage({ jsonrpc: "2.0", id: null, method: "ping" });
  assert.equal(response.error.code, -32600);
  assert.match(response.error.message, /Invalid request id/);
});

test("handleMcpMessage rejects a non-string method", async () => {
  const response = await handleMcpMessage({ jsonrpc: "2.0", id: 3, method: 42 });
  assert.equal(response.error.code, -32600);
});

test("handleMcpMessage reports method-not-found for unknown methods", async () => {
  const response = await handleMcpMessage({ jsonrpc: "2.0", id: 4, method: "resources/list" });
  assert.equal(response.error.code, -32601);
  assert.match(response.error.message, /resources\/list/);
});

test("handleMcpMessage tools/call rejects non-object params", async () => {
  const response = await handleMcpMessage({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: "not-an-object",
  });
  assert.equal(response.error.code, -32602);
  assert.match(response.error.message, /must be an object/);
});

test("handleMcpMessage tools/call rejects an unknown tool name", async () => {
  const response = await handleMcpMessage({
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: { name: "delete_everything", arguments: {} },
  });
  assert.equal(response.error.code, -32602);
  assert.match(response.error.message, /Unknown mcp tool/);
});

test("handleMcpMessage tools/call rejects invalid arguments with the zod issues attached", async () => {
  const response = await handleMcpMessage({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    // search_instincts requires a non-empty `query` string.
    params: { name: "search_instincts", arguments: {} },
  });
  assert.equal(response.error.code, -32602);
  assert.ok(Array.isArray(response.error.data));
  assert.ok(response.error.data.length > 0);
});

test("handleMcpMessage tools/call search_instincts executes the real query engine end to end", async () => {
  await withRuntimeRoot(async () => {
    await seedOneInstinct();

    const response = await handleMcpMessage({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: {
        name: "search_instincts",
        arguments: { project_id: projectId, query: "sqlite" },
      },
    });

    assert.equal(response.result.isError, false);
    const payload = JSON.parse(response.result.content[0].text);
    assert.equal(payload.hits.length, 1);
    assert.equal(payload.hits[0].instinct.id, "sqlite-migration-aaaa1111");
  });
});

test("handleMcpMessage tools/call instincts_for_file executes the real query engine end to end", async () => {
  await withRuntimeRoot(async () => {
    await seedOneInstinct();

    const response = await handleMcpMessage({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: {
        name: "instincts_for_file",
        arguments: { project_id: projectId, path: "shared/db_sqlite.py" },
      },
    });

    assert.equal(response.result.isError, false);
    const payload = JSON.parse(response.result.content[0].text);
    assert.equal(payload.exact_hits.length, 1);
    assert.equal(payload.exact_hits[0].score, 1);
  });
});

test("handleMcpMessage tools/call recent_instincts executes the real query engine end to end", async () => {
  await withRuntimeRoot(async () => {
    await seedOneInstinct();

    const response = await handleMcpMessage({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "recent_instincts",
        arguments: { project_id: projectId, window_days: 365 },
      },
    });

    assert.equal(response.result.isError, false);
    const payload = JSON.parse(response.result.content[0].text);
    assert.equal(payload.hits.length, 1);
    assert.ok(payload.window_start <= payload.window_end);
  });
});

// --- runMcpStdioServer: line-buffering over the raw stream, independent of ---
// --- the JSON-RPC dispatch already covered above.                          ---

function chunkedInputStream(chunks) {
  return {
    setEncoding() {
      // no-op: chunks are already strings.
    },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
}

function collectingOutputStream() {
  const written = [];
  return {
    lines: () =>
      written
        .join("")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line)),
    write(data) {
      written.push(data);
    },
  };
}

test("runMcpStdioServer reassembles a JSON-RPC line split across multiple stream chunks", async () => {
  const fullLine = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\n`;
  const splitPoint = Math.floor(fullLine.length / 2);
  const input = chunkedInputStream([fullLine.slice(0, splitPoint), fullLine.slice(splitPoint)]);
  const output = collectingOutputStream();

  await runMcpStdioServer(input, output);

  const responses = output.lines();
  assert.equal(responses.length, 1);
  assert.deepEqual(responses[0], { jsonrpc: "2.0", id: 1, result: {} });
});

test("runMcpStdioServer handles multiple requests delivered in one chunk plus a trailing unterminated line", async () => {
  const first = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
  const second = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize" });
  // No trailing "\n" after `second`: exercises the trailing-buffer branch.
  const input = chunkedInputStream([`${first}\n${second}`]);
  const output = collectingOutputStream();

  await runMcpStdioServer(input, output);

  const responses = output.lines();
  assert.equal(responses.length, 2);
  assert.equal(responses[0].id, 1);
  assert.equal(responses[1].id, 2);
  assert.equal(responses[1].result.protocolVersion, MCP_PROTOCOL_VERSION);
});

test("runMcpStdioServer replies with a JSON-RPC parse error for a malformed line", async () => {
  const input = chunkedInputStream(["{not valid json\n"]);
  const output = collectingOutputStream();

  await runMcpStdioServer(input, output);

  const responses = output.lines();
  assert.equal(responses.length, 1);
  assert.equal(responses[0].error.code, -32700);
});

test("runMcpStdioServer emits nothing for a blank line and no response for a notification (no id)", async () => {
  const notification = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
  const input = chunkedInputStream([`\n${notification}\n`]);
  const output = collectingOutputStream();

  await runMcpStdioServer(input, output);

  assert.equal(output.lines().length, 0);
});
