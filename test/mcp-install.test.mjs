import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(testDir);
const cliPath = join(projectRoot, "dist", "cli.js");

function runCli(args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env },
  });
}

async function withConfig(initial, run) {
  const dir = await mkdtemp(join(tmpdir(), "marrow-mcp-install-"));
  const configPath = join(dir, ".claude.json");
  try {
    if (initial !== undefined) {
      await writeFile(configPath, `${JSON.stringify(initial, null, 2)}\n`, "utf8");
    }
    await run(configPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("mcp install registers marrow as a stdio server, preserving other keys", async () => {
  await withConfig(
    { numStartups: 7, mcpServers: { exa: { type: "http", url: "https://example" } } },
    async (configPath) => {
      const result = runCli([
        "mcp",
        "install",
        "--config",
        configPath,
        "--node",
        "/usr/bin/node",
        "--cli",
        "/opt/marrow/dist/cli.js",
      ]);
      assert.equal(result.status, 0, result.stderr);
      const config = JSON.parse(await readFile(configPath, "utf8"));
      // Unrelated keys and pre-existing servers are preserved.
      assert.equal(config.numStartups, 7);
      assert.deepEqual(config.mcpServers.exa, { type: "http", url: "https://example" });
      // marrow entry is a stdio server invoking `mcp serve`.
      assert.deepEqual(config.mcpServers.marrow, {
        type: "stdio",
        command: "/usr/bin/node",
        args: ["/opt/marrow/dist/cli.js", "mcp", "serve"],
      });
    },
  );
});

test("mcp install is idempotent and leaves the file byte-identical on re-run", async () => {
  await withConfig({ mcpServers: {} }, async (configPath) => {
    const args = [
      "mcp",
      "install",
      "--config",
      configPath,
      "--node",
      "/usr/bin/node",
      "--cli",
      "/opt/marrow/dist/cli.js",
    ];
    const first = runCli(args);
    assert.equal(first.status, 0, first.stderr);
    const afterFirst = await readFile(configPath, "utf8");

    const second = runCli(args);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /already registered/);
    const afterSecond = await readFile(configPath, "utf8");
    assert.equal(afterSecond, afterFirst);
  });
});

test("mcp install --dry-run reports the change without writing", async () => {
  await withConfig({ mcpServers: {} }, async (configPath) => {
    const before = await readFile(configPath, "utf8");
    const result = runCli([
      "mcp",
      "install",
      "--dry-run",
      "--config",
      configPath,
      "--node",
      "/usr/bin/node",
      "--cli",
      "/opt/marrow/dist/cli.js",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.dry_run, true);
    assert.equal(payload.would_change, true);
    assert.equal(payload.entry.args[1], "mcp");
    // No mutation on dry-run.
    assert.equal(await readFile(configPath, "utf8"), before);
  });
});

test("mcp install creates ~/.claude.json when it does not exist", async () => {
  await withConfig(undefined, async (configPath) => {
    const result = runCli([
      "mcp",
      "install",
      "--config",
      configPath,
      "--node",
      "/usr/bin/node",
      "--cli",
      "/opt/marrow/dist/cli.js",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const config = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(config.mcpServers.marrow.type, "stdio");
  });
});
