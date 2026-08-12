import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { getRuntimePath } from "../dist/config/paths.js";
import { instinctSchema } from "../dist/v2/instinct/schema.js";
import { serializeInstinct } from "../dist/v2/instinct/yaml-io.js";
import { hashToProjectId } from "../dist/v2/project/resolve.js";
import {
  renderGlobalMemoryToVault,
  renderProjectMemoryToVault,
} from "../dist/v2/vault/render-memory.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(testDir);
const cliPath = join(projectRoot, "dist", "cli.js");

function globalInstinct(overrides = {}) {
  return instinctSchema.parse({
    schema_version: 1,
    id: "always-run-lint-before-push-99999999",
    trigger: "When pushing a branch",
    finding: "Always run the lint gate before pushing across every repo.",
    confidence: 0.9,
    domain: "workflow",
    maturity: "proven",
    scope: "global",
    // Promoted global instincts carry an empty project_id (see schema).
    project_id: "",
    source: {
      first_session: "sess-g",
      first_observed_at: "2026-05-19T10:00:00Z",
      source_refs: [],
      observations: [{ session: "sess-g", reinforcing: true, at: "2026-05-19T10:00:00Z" }],
    },
    related: [],
    created_at: "2026-05-19T10:00:00Z",
    updated_at: "2026-05-19T10:00:00Z",
    last_promoted_at: "2026-05-19T10:00:00Z",
    ...overrides,
  });
}

async function seedGlobalStore(instinct) {
  const dir = getRuntimePath("instinctsGlobal");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${instinct.id}.yaml`), serializeInstinct(instinct), "utf8");
}

test("renderGlobalMemoryToVault writes _global/MEMORY.md and project render excludes it", async () => {
  const previousRoot = process.env.MARROW_ROOT;
  const sandbox = await mkdtemp(join(tmpdir(), "marrow-global-"));
  const runtimeRoot = join(sandbox, "runtime");
  const vaultRoot = join(sandbox, "vault");
  process.env.MARROW_ROOT = runtimeRoot;

  try {
    await seedGlobalStore(globalInstinct());

    const global = await renderGlobalMemoryToVault({ vaultRoot });
    assert.match(global.memoryPath, /\/wiki\/projects\/_global\/MEMORY\.md$/);
    const globalMemory = await readFile(global.memoryPath, "utf8");
    assert.match(globalMemory, /# Global memory \(curated\)/);
    assert.match(globalMemory, /Always run the lint gate before pushing/);
    assert.equal(global.includedCount, 1);

    // A project with no instincts renders a header-only file that must NOT carry
    // the global finding — global instincts live only in the _global rollup.
    const project = await renderProjectMemoryToVault({
      projectId: "emptyproj00001",
      vaultRoot,
    });
    const projectMemory = await readFile(project.memoryPath, "utf8");
    assert.doesNotMatch(projectMemory, /Always run the lint gate before pushing/);
    assert.match(projectMemory, /# Project memory \(curated\)/);
    assert.equal(project.includedCount, 0);
  } finally {
    if (previousRoot === undefined) {
      delete process.env.MARROW_ROOT;
    } else {
      process.env.MARROW_ROOT = previousRoot;
    }
    await rm(sandbox, { recursive: true, force: true });
  }
});

function runCli(args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env },
  });
}

async function seedVaultFile(vaultRoot, projectId, name, content) {
  const dir = join(vaultRoot, "wiki", "projects", projectId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), content, "utf8");
}

const GLOBAL_BODY = `---
tags: [marrow, memory, curated]
generated_at: 2026-06-29T07:40:12.416Z
---

# Global memory (curated)

- **workflow** (proven, 0.90): Always run the lint gate before pushing across every repo. \`always-run-lint-99999999\`
`;

const PROJECT_BODY = `---
tags: [marrow, memory, curated]
---

# Project memory (curated)

- **tooling** (candidate, 0.62): Use pnpm for installs in this repo. \`use-pnpm-11111111\`
`;

test("recall surfaces the global rollup ahead of the project rollup", async () => {
  const work = await mkdtemp(join(tmpdir(), "marrow-grecall-work-"));
  const vault = await mkdtemp(join(tmpdir(), "marrow-grecall-vault-"));
  try {
    const projectId = hashToProjectId(work);
    await seedVaultFile(vault, "_global", "MEMORY.md", GLOBAL_BODY);
    await seedVaultFile(vault, projectId, "MEMORY.md", PROJECT_BODY);

    const result = runCli(["recall", "--cwd", work, "--vault-root", vault]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Global memory \(curated\)/);
    assert.match(result.stdout, /Always run the lint gate before pushing/);
    assert.match(result.stdout, /Use pnpm for installs/);
    // Global content leads the injected block.
    assert.ok(
      result.stdout.indexOf("Always run the lint gate") <
        result.stdout.indexOf("Use pnpm for installs"),
      "global section should precede the project section",
    );
    assert.doesNotMatch(result.stdout, /generated_at:/);
  } finally {
    await rm(work, { recursive: true, force: true });
    await rm(vault, { recursive: true, force: true });
  }
});

test("recall ignores a header-only _global rollup with no instinct bullets", async () => {
  const work = await mkdtemp(join(tmpdir(), "marrow-grecall-work-"));
  const vault = await mkdtemp(join(tmpdir(), "marrow-grecall-vault-"));
  try {
    const projectId = hashToProjectId(work);
    const headerOnlyGlobal = `---
tags: [marrow, memory, curated]
---

# Global memory (curated)

Cross-project instincts promoted to global scope. Surfaced in every session via \`marrow recall\`.
`;
    await seedVaultFile(vault, "_global", "MEMORY.md", headerOnlyGlobal);
    await seedVaultFile(vault, projectId, "MEMORY.md", PROJECT_BODY);

    const result = runCli(["recall", "--cwd", work, "--vault-root", vault]);
    assert.equal(result.status, 0, result.stderr);
    // The empty global rollup is dropped; the project rollup still delivers.
    assert.doesNotMatch(result.stdout, /Global memory \(curated\)/);
    assert.match(result.stdout, /Use pnpm for installs/);
  } finally {
    await rm(work, { recursive: true, force: true });
    await rm(vault, { recursive: true, force: true });
  }
});
