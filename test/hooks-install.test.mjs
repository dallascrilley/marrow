import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  mergeSessionEndHook,
  parseHooksInstallOptions,
  resolveSettingsPath,
} from "../dist/commands/hooks-install.js";

test("parseHooksInstallOptions accepts --dry-run and --global", () => {
  assert.deepEqual(parseHooksInstallOptions(["--dry-run", "--global"]), {
    dryRun: true,
    global: true,
  });
});

test("mergeSessionEndHook appends SessionEnd command when missing", () => {
  const merged = mergeSessionEndHook(
    {},
    `"$CLAUDE_PROJECT_DIR/.claude/hooks/asd-session-end-ingest.sh"`,
  );
  const sessionEnd = merged.hooks?.SessionEnd;
  assert.ok(Array.isArray(sessionEnd));
  assert.equal(sessionEnd.length, 1);
  assert.equal(
    sessionEnd[0]?.hooks?.[0]?.command,
    `"$CLAUDE_PROJECT_DIR/.claude/hooks/asd-session-end-ingest.sh"`,
  );
});

test("mergeSessionEndHook is idempotent for existing asd hook", () => {
  const before = mergeSessionEndHook(
    {},
    `"$CLAUDE_PROJECT_DIR/.claude/hooks/asd-session-end-ingest.sh"`,
  );
  const after = mergeSessionEndHook(
    before,
    `"$CLAUDE_PROJECT_DIR/.claude/hooks/asd-session-end-ingest.sh"`,
  );
  assert.deepEqual(after, before);
});

test("hooks install writes project hook script and settings", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "asd-hooks-install-"));
  const { spawnSync } = await import("node:child_process");
  const { dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");

  const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const cliPath = join(projectRoot, "dist", "cli.js");

  try {
    const result = spawnSync(process.execPath, [cliPath, "hooks", "install"], {
      cwd: sandbox,
      encoding: "utf8",
      env: process.env,
    });

    assert.equal(result.status, 0, result.stderr);

    const hookPath = join(sandbox, ".claude", "hooks", "asd-session-end-ingest.sh");
    const settingsPath = resolveSettingsPath(sandbox, false);
    await access(hookPath);
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.ok(Array.isArray(settings.hooks?.SessionEnd));
  } finally {
    await rm(sandbox, { force: true, recursive: true });
  }
});
