import { isAbsolute, join, normalize, sep } from "node:path";

/**
 * Allowed relative paths under `wiki/projects/<project-id>/` for marrow vault
 * writes. ADR-0004 defines the carve-out; this array is the source of truth
 * enforced in code.
 *
 * - `marrow-learnings/**` is interpreted strictly: files must sit directly inside
 *   `marrow-learnings/`, not in nested subdirectories.
 * - All other entries are exact filenames.
 */
export const VAULT_PROJECT_ALLOWLIST = [
  "marrow-learnings/**",
  "_asd-manifest.json",
  "MEMORY.md",
  "workflow.md",
  "tooling.md",
  "preferences.md",
  "pitfalls.md",
  "debugging.md",
] as const;

export type VaultProjectAllowlistEntry = (typeof VAULT_PROJECT_ALLOWLIST)[number];

/**
 * Return the absolute path to a project vault directory. This directory itself
 * is not a written file; callers use it for `mkdir` and as the base for
 * `vaultProjectPath`.
 */
export function vaultProjectDir(vaultRoot: string, projectId: string): string {
  return join(vaultRoot, "wiki", "projects", sanitiseProjectId(projectId));
}

/**
 * Return the absolute path for an allowed vault write, throwing if the
 * requested relative path is outside the ADR-0004 carve-out.
 *
 * This is the single call-site that should be used when marrow needs to compute a
 * vault file path. It prevents accidental writes to `hot.md`, `index.md`,
 * `.raw/.manifest.json`, or any other off-limits location.
 */
export function vaultProjectPath(
  vaultRoot: string,
  projectId: string,
  relativePath: string,
): string {
  assertAllowedVaultProjectPath(projectId, relativePath);
  return join(vaultProjectDir(vaultRoot, projectId), relativePath);
}

/**
 * Check whether a path is within the allowed vault carve-out for the given
 * project. Rejects absolute paths, traversal (`..`), hidden files, and any
 * entry not explicitly listed.
 */
export function isAllowedVaultProjectPath(_projectId: string, relativePath: string): boolean {
  const normalised = normaliseRelativePath(relativePath);
  if (normalised === null) return false;
  if (normalised.includes("/")) {
    const parts = normalised.split("/");
    if (parts.length !== 2 || parts[0] !== "marrow-learnings") return false;
    const filename = parts[1] ?? "";
    return filename.length > 0 && !filename.startsWith(".");
  }
  return (
    normalised === "_asd-manifest.json" ||
    normalised === "MEMORY.md" ||
    normalised === "workflow.md" ||
    normalised === "tooling.md" ||
    normalised === "preferences.md" ||
    normalised === "pitfalls.md" ||
    normalised === "debugging.md"
  );
}

/**
 * Throw an informative error when a path is outside the vault carve-out.
 */
export function assertAllowedVaultProjectPath(projectId: string, relativePath: string): void {
  if (!isAllowedVaultProjectPath(projectId, relativePath)) {
    throw new Error(
      `Vault write outside allowed carve-out for project ${sanitiseProjectId(projectId)}: ${relativePath}. ` +
        `Allowed paths: ${VAULT_PROJECT_ALLOWLIST.join(", ")}.`,
    );
  }
}

function sanitiseProjectId(projectId: string): string {
  return projectId
    .replace(/[\\/]+/g, "")
    .replace(/\.\.+/g, "")
    .replace(/^\.+/, "")
    .trim();
}

/**
 * Normalise a user-supplied relative path for allowlist checks.
 * Returns `null` if the path is absolute, contains traversal, or is empty.
 */
function normaliseRelativePath(relativePath: string): string | null {
  const trimmed = relativePath.trim();
  if (trimmed.length === 0) return null;

  const withForwardSlashes = trimmed.replaceAll(sep, "/");
  const platformNormalised = normalize(withForwardSlashes);
  if (isAbsolute(platformNormalised)) return null;
  const normalised = platformNormalised.replace(/^\.\//, "").replaceAll("\\", "/");

  if (normalised.startsWith("/")) return null;
  if (normalised === "..") return null;
  if (normalised.startsWith("../")) return null;
  if (normalised.includes("/../")) return null;
  if (normalised.endsWith("/..")) return null;
  if (normalised.startsWith(".")) return null;

  return normalised;
}
