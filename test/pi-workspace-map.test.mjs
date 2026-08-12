import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { derivePiWorkspaceMapping, readPiSessionMeta } from "../dist/adapters/pi/workspace-map.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(testDir);
const fixturePath = join(
  projectRoot,
  "test",
  "fixtures",
  "pi",
  "sessions",
  "--Users-example-Code-demo--",
  "2026-05-18T00-28-01-780Z_019e387b-8d74-7c8b-9578-ff8d1151ae4f.jsonl",
);

test("reads session line 0 with cwd, id, timestamp, and version", async () => {
  const meta = await readPiSessionMeta(fixturePath);
  assert.ok(meta);
  assert.equal(meta.cwd, "/Users/example/Code/demo");
  assert.equal(meta.id, "019e387b-8d74-7c8b-9578-ff8d1151ae4f");
  assert.equal(meta.version, 3);
});

test("workspace mapping prefers session.cwd over decoded slug", async () => {
  const meta = await readPiSessionMeta(fixturePath);
  const mapping = derivePiWorkspaceMapping(fixturePath, meta);
  assert.equal(mapping.workspacePath, "/Users/example/Code/demo");
  assert.equal(mapping.projectKey, "demo");
  assert.equal(mapping.workspaceSlug, "--Users-example-Code-demo--");
  assert.equal(mapping.piSessionPath, fixturePath);
});

test("workspace mapping falls back to decoded slug when session_meta is null", () => {
  const mapping = derivePiWorkspaceMapping(fixturePath, null);
  assert.equal(mapping.workspacePath, "/Users/example/Code/demo");
  assert.equal(mapping.projectKey, "demo");
});

test("reads session after OMP title pad preamble", async () => {
  const dir = await mkdtemp(join(tmpdir(), "marrow-omp-title-"));
  try {
    const sessionPath = join(dir, "session.jsonl");
    await writeFile(
      sessionPath,
      [
        JSON.stringify({
          type: "title",
          v: 1,
          title: "",
          updatedAt: "2026-07-31T00:00:00.000Z",
          pad: " ".repeat(80),
        }),
        JSON.stringify({
          type: "session",
          version: 3,
          id: "019f-omp-title-preamble",
          timestamp: "2026-07-31T00:00:00.000Z",
          cwd: "/Users/example/Code/omp-demo",
        }),
        "",
      ].join("\n"),
      "utf8",
    );
    const meta = await readPiSessionMeta(sessionPath);
    assert.ok(meta);
    assert.equal(meta.cwd, "/Users/example/Code/omp-demo");
    assert.equal(meta.id, "019f-omp-title-preamble");
    assert.equal(meta.version, 3);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("extracts workspace slug from .omp/agent/sessions layout", () => {
  const ompPath =
    "/Users/example/.omp/agent/sessions/-Code-demo/2026-07-31T00-00-00-000Z_abc.jsonl";
  const mapping = derivePiWorkspaceMapping(ompPath, {
    cwd: "/Users/example/Code/demo",
    id: "abc",
    timestamp: "2026-07-31T00:00:00.000Z",
    version: 3,
  });
  assert.equal(mapping.workspaceSlug, "-Code-demo");
  assert.equal(mapping.workspacePath, "/Users/example/Code/demo");
  assert.equal(mapping.projectKey, "demo");
});
