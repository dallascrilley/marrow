import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { assessReadbackSetup } from "../dist/commands/readback-check.js";

test("read-back setup distinguishes missing, installed, drifted, and unverifiable surfaces", async () => {
  const root = await mkdtemp(join(tmpdir(), "asd-readback-check-"));
  try {
    const settingsPath = join(root, "project", ".claude", "settings.json");
    const hookPath = join(root, "project", ".claude", "hooks", "asd-session-start-recall.sh");
    const mcpConfigPath = join(root, "claude.json");
    const missingVault = join(root, "missing-vault");

    const missing = await assessReadbackSetup({
      hookPath,
      mcpConfigPath,
      settingsPath,
      vaultRoot: missingVault,
    });
    assert.deepEqual(
      [missing.hook.status, missing.mcp.status, missing.recall.status],
      ["missing", "missing", "unverifiable"],
    );

    await mkdir(join(hookPath, ".."), { recursive: true });
    await writeFile(hookPath, "#!/bin/sh\n", "utf8");
    await mkdir(join(settingsPath, ".."), { recursive: true });
    await writeFile(
      settingsPath,
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: "asd-session-start-recall" }] }],
        },
      }),
      "utf8",
    );
    await writeFile(
      mcpConfigPath,
      JSON.stringify({
        mcpServers: { asd: { type: "stdio", command: "node", args: ["cli.js", "mcp", "serve"] } },
      }),
      "utf8",
    );
    const vaultRoot = join(root, "vault");
    await mkdir(vaultRoot, { recursive: true });

    const installed = await assessReadbackSetup({
      hookPath,
      mcpConfigPath,
      settingsPath,
      vaultRoot,
    });
    assert.deepEqual(
      [installed.hook.status, installed.mcp.status, installed.recall.status],
      ["installed", "installed", "missing"],
    );

    await rm(hookPath);
    await writeFile(
      mcpConfigPath,
      JSON.stringify({ mcpServers: { asd: { type: "http" } } }),
      "utf8",
    );
    const drifted = await assessReadbackSetup({ hookPath, mcpConfigPath, settingsPath, vaultRoot });
    assert.deepEqual([drifted.hook.status, drifted.mcp.status], ["drifted", "drifted"]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
