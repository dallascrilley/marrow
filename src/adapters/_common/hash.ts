import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

/**
 * Read the file at `filePath` and return the sha256 digest of its bytes as
 * `sha256:<hex>`. Used by every adapter to compute the `sourceHash` recorded
 * on each transcript discovery.
 */
export async function hashFileContents(filePath: string): Promise<string> {
  const fileContents = await readFile(filePath);
  return `sha256:${createHash("sha256").update(fileContents).digest("hex")}`;
}
