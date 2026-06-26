import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { DatabaseSync } from "node:sqlite";

import type { CommandContext } from "../cli.js";
import { ensureRuntimePath } from "../config/paths.js";
import { buildSearchableSessionIndex } from "../read/session-index.js";

export async function executeExportIndex(
  context: CommandContext,
  database: DatabaseSync,
): Promise<number> {
  const records = await buildSearchableSessionIndex(database);
  const indexDir = await ensureRuntimePath("index");
  const exportPath = join(indexDir, "session-index.jsonl");
  const contents =
    records.length === 0 ? "" : `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;

  await writeFile(exportPath, contents, "utf8");

  context.output.info(
    `Exported ${records.length} session index ${records.length === 1 ? "record" : "records"}.`,
  );
  context.output.info(`Export path: ${exportPath}`);

  return 0;
}
