import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildSessionIndex,
  type SessionIndexRecord,
  sessionIndexRecordSchema,
} from "../commands/export-index.js";
import { getRuntimePath } from "../config/paths.js";

export async function loadSessionIndexRecords(): Promise<SessionIndexRecord[]> {
  const indexPath = join(getRuntimePath("index"), "session-index.jsonl");

  try {
    await access(indexPath);
    const contents = await readFile(indexPath, "utf8");
    const records: SessionIndexRecord[] = [];
    for (const line of contents.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      records.push(sessionIndexRecordSchema.parse(JSON.parse(trimmed)));
    }
    return records;
  } catch {
    return buildSessionIndex();
  }
}
