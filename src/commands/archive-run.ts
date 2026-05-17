import { readFile } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";

import type { CommandContext } from "../cli.js";
import { listSourceSessionsByLifecycle } from "../db/ledger.js";
import { runArchivePhase } from "../pipeline/archive.js";
import { getReducedArtifactPath } from "../pipeline/reduce.js";
import { getProjectKnowledgeSessionPath, getUserKnowledgeSessionPath } from "../writers/knowledge-writer.js";
import { getSessionSummaryJsonPath, getSessionSummaryMarkdownPath } from "../writers/summary-writer.js";

export async function executeArchiveRun(context: CommandContext, database: DatabaseSync): Promise<number> {
  const sessions = listSourceSessionsByLifecycle(database, ["extracted"]);
  const processed: Array<Record<string, unknown>> = [];

  for (const session of sessions) {
    const reduced = JSON.parse(await readFile(getReducedArtifactPath(session.session_id), "utf8")) as {
      events: import("../models/canonical.js").Event[];
      turns: import("../models/canonical.js").Turn[];
    };
    const result = await runArchivePhase({
      database,
      events: reduced.events,
      knowledge: {
        project: {
          count: 0,
          path: getProjectKnowledgeSessionPath(session.project_key, session.session_id)
        },
        user: {
          count: 0,
          path: getUserKnowledgeSessionPath("operator", session.session_id)
        }
      },
      sourceSession: session,
      sourceSessionId: session.id,
      summary: {
        markdownPath: getSessionSummaryMarkdownPath(session.session_id),
        sessionDirectoryPath: "",
        summary: JSON.parse(await readFile(getSessionSummaryJsonPath(session.session_id), "utf8")),
        summaryPath: getSessionSummaryJsonPath(session.session_id)
      },
      turns: reduced.turns
    });

    processed.push({
      result,
      session_id: session.session_id
    });
  }

  context.output.info(JSON.stringify({ processed }, null, 2));
  return 0;
}
