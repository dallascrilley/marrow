import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(projectRoot, "dist", "cli.js");

test("the CLI runs when invoked through a symlink, the way an installed binary is", async () => {
  // `npm link` and `npm install -g` both put a SYMLINK named `marrow` on PATH.
  // The entry-point guard used to compare the resolved module path against the
  // unresolved `process.argv[1]`, so every installed invocation fell through the
  // guard and the binary exited 0 while printing nothing.
  const dir = await mkdtemp(join(tmpdir(), "marrow-bin-link-"));
  try {
    const linkPath = join(dir, "marrow");
    await symlink(cliPath, linkPath);

    const viaLink = spawnSync(process.execPath, [linkPath, "--help"], { encoding: "utf8" });
    assert.equal(viaLink.status, 0, viaLink.stderr);
    assert.match(viaLink.stdout, /Usage: marrow <command>/);

    const viaRealPath = spawnSync(process.execPath, [cliPath, "--help"], { encoding: "utf8" });
    assert.equal(viaLink.stdout, viaRealPath.stdout);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});
