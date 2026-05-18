import { access } from "node:fs/promises";

/**
 * Return whether `targetPath` exists on disk. Wraps `fs.access` so callers can
 * branch without writing the same try/catch in every adapter.
 */
export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }

    throw error;
  }
}

/**
 * Return true when `error` is an `ENOENT` filesystem error. Kept as a plain
 * boolean (not a type guard) for source-compatibility with the original
 * Cursor adapter helpers it replaces.
 */
export function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
