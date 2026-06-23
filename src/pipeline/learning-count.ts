import { readFile } from "node:fs/promises";

import type { SourceSessionRow } from "../db/queries.js";
import { getProjectKnowledgeSessionPath } from "../writers/knowledge-writer.js";

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/**
 * Count the project learnings written for a session by counting non-empty
 * lines in its project-knowledge file. Returns 0 when no file exists. Shared by
 * the quality audit (distribution reporting) and resummarize (over-extraction
 * selection) so both agree on what "learning count" means.
 */
export async function countProjectLearnings(
  sourceSession: Pick<SourceSessionRow, "project_key" | "session_id">,
): Promise<number> {
  try {
    const contents = await readFile(
      getProjectKnowledgeSessionPath(sourceSession.project_key, sourceSession.session_id),
      "utf8",
    );
    return contents.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
  } catch (error) {
    if (isMissingFileError(error)) {
      return 0;
    }

    throw error;
  }
}
