import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { DatabaseSync } from "node:sqlite";

import type { CommandContext } from "../cli.js";
import { ensureRuntimePath } from "../config/paths.js";
import { listSourceSessionsByLifecycle } from "../db/ledger.js";
import { buildSessionIndex } from "../read/session-index.js";

export async function executeExportIndex(
  context: CommandContext,
  database: DatabaseSync,
): Promise<number> {
  const deletedSessionIds = new Set(
    listSourceSessionsByLifecycle(database, ["deleted"]).map((session) => session.session_id),
  );
  const records = await buildSessionIndex({ excludeSessionIds: deletedSessionIds });
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
