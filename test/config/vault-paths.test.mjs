import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertAllowedVaultProjectPath,
  isAllowedVaultProjectPath,
  vaultProjectDir,
  vaultProjectPath,
} from "../../dist/config/vault-paths.js";

const PROJECT_ID = "abc123def456";
const VAULT_ROOT = join(tmpdir(), "marrow-vault-paths-test");

test("vaultProjectDir returns the project directory under wiki/projects", () => {
  const dir = vaultProjectDir(VAULT_ROOT, PROJECT_ID);
  assert.equal(dir, join(VAULT_ROOT, "wiki", "projects", PROJECT_ID));
});

test("vaultProjectPath returns absolute paths for allowed files", () => {
  assert.equal(
    vaultProjectPath(VAULT_ROOT, PROJECT_ID, "MEMORY.md"),
    join(VAULT_ROOT, "wiki", "projects", PROJECT_ID, "MEMORY.md"),
  );
  assert.equal(
    vaultProjectPath(VAULT_ROOT, PROJECT_ID, "_asd-manifest.json"),
    join(VAULT_ROOT, "wiki", "projects", PROJECT_ID, "_asd-manifest.json"),
  );
  assert.equal(
    vaultProjectPath(VAULT_ROOT, PROJECT_ID, "marrow-learnings/page.md"),
    join(VAULT_ROOT, "wiki", "projects", PROJECT_ID, "marrow-learnings", "page.md"),
  );
});

test("isAllowedVaultProjectPath accepts the eight carved-out patterns", () => {
  assert.ok(isAllowedVaultProjectPath(PROJECT_ID, "marrow-learnings/any-file.md"));
  assert.ok(isAllowedVaultProjectPath(PROJECT_ID, "_asd-manifest.json"));
  assert.ok(isAllowedVaultProjectPath(PROJECT_ID, "MEMORY.md"));
  assert.ok(isAllowedVaultProjectPath(PROJECT_ID, "workflow.md"));
  assert.ok(isAllowedVaultProjectPath(PROJECT_ID, "tooling.md"));
  assert.ok(isAllowedVaultProjectPath(PROJECT_ID, "preferences.md"));
  assert.ok(isAllowedVaultProjectPath(PROJECT_ID, "pitfalls.md"));
  assert.ok(isAllowedVaultProjectPath(PROJECT_ID, "debugging.md"));
});

test("isAllowedVaultProjectPath rejects paths outside the carve-out", () => {
  assert.equal(isAllowedVaultProjectPath(PROJECT_ID, "hot.md"), false);
  assert.equal(isAllowedVaultProjectPath(PROJECT_ID, "index.md"), false);
  assert.equal(isAllowedVaultProjectPath(PROJECT_ID, "log.md"), false);
  assert.equal(isAllowedVaultProjectPath(PROJECT_ID, ".raw/.manifest.json"), false);
  assert.equal(isAllowedVaultProjectPath(PROJECT_ID, "random.md"), false);
  assert.equal(isAllowedVaultProjectPath(PROJECT_ID, "marrow-learnings/nested/dir/page.md"), false);
  assert.equal(isAllowedVaultProjectPath(PROJECT_ID, "marrow-learnings/.hidden.md"), false);
});

test("isAllowedVaultProjectPath rejects traversal and absolute paths", () => {
  assert.equal(isAllowedVaultProjectPath(PROJECT_ID, "../MEMORY.md"), false);
  assert.equal(isAllowedVaultProjectPath(PROJECT_ID, "marrow-learnings/../../hot.md"), false);
  assert.equal(isAllowedVaultProjectPath(PROJECT_ID, "/etc/passwd"), false);
  assert.equal(isAllowedVaultProjectPath(PROJECT_ID, "MEMORY.md/../hot.md"), false);
});

test("isAllowedVaultProjectPath normalises backslashes as separators", () => {
  assert.ok(isAllowedVaultProjectPath(PROJECT_ID, "marrow-learnings\\page.md"));
  assert.equal(isAllowedVaultProjectPath(PROJECT_ID, "marrow-learnings\\subdir\\page.md"), false);
});

test("assertAllowedVaultProjectPath throws on forbidden paths", () => {
  assert.throws(
    () => assertAllowedVaultProjectPath(PROJECT_ID, "hot.md"),
    /Vault write outside allowed carve-out/,
  );
  assert.throws(
    () => assertAllowedVaultProjectPath(PROJECT_ID, "marrow-learnings/subdir/page.md"),
    /Vault write outside allowed carve-out/,
  );
});

test("vaultProjectPath throws on forbidden paths", () => {
  assert.throws(
    () => vaultProjectPath(VAULT_ROOT, PROJECT_ID, "hot.md"),
    /Vault write outside allowed carve-out/,
  );
  assert.throws(
    () => vaultProjectPath(VAULT_ROOT, PROJECT_ID, "../hot.md"),
    /Vault write outside allowed carve-out/,
  );
});

test("vaultProjectDir sanitises malicious project ids", () => {
  assert.equal(vaultProjectDir(VAULT_ROOT, "../etc"), join(VAULT_ROOT, "wiki", "projects", "etc"));
});
