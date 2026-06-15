import { readFile } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";

import type { CommandContext } from "../cli.js";
import { getSourceSessionBySessionId, listSourceSessions } from "../db/ledger.js";
import type { SourceSessionRow } from "../db/queries.js";
import { runArchivePhase } from "../pipeline/archive.js";
import { DEFAULT_MAX_PROJECT_LEARNINGS_PER_SESSION } from "../pipeline/extract.js";
import { countProjectLearnings } from "../pipeline/quality-audit.js";
import { getReducedArtifactPath } from "../pipeline/reduce.js";
import {
  getProjectKnowledgeSessionPath,
  getUserKnowledgeSessionPath,
} from "../writers/knowledge-writer.js";
import {
  getSessionSummaryJsonPath,
  getSessionSummaryMarkdownPath,
} from "../writers/summary-writer.js";
import { runExtractPhase } from "./ingest-backfill.js";

export type ReextractOptions = {
  dryRun?: boolean;
  overExtractedOnly?: boolean;
  sessionIds?: string[];
};

export async function executePipelineReextract(
  context: CommandContext,
  database: DatabaseSync,
): Promise<number> {
  const options = parseReextractOptions(context.args);
  const sessions = await selectReextractSessions(database, options);

  if (options.dryRun) {
    context.output.info(
      JSON.stringify(
        {
          dry_run: true,
          matched_count: sessions.length,
          matched_session_ids: sessions.map((session) => session.session_id),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  const processed: Array<Record<string, unknown>> = [];

  for (const session of sessions) {
    try {
      const reduced = JSON.parse(
        await readFile(getReducedArtifactPath(session.session_id), "utf8"),
      ) as {
        events: import("../models/canonical.js").Event[];
        turns: import("../models/canonical.js").Turn[];
      };
      const extracted = await runExtractPhase(
        database,
        session,
        reduced.turns,
        reduced.events,
        false,
      );
      const archived = await runArchivePhase({
        allowManifestOverwrite: true,
        database,
        events: reduced.events,
        knowledge: extracted,
        sourceSession: session,
        sourceSessionId: session.id,
        summary: {
          markdownPath: getSessionSummaryMarkdownPath(session.session_id),
          sessionDirectoryPath: "",
          summary: JSON.parse(
            await readFile(getSessionSummaryJsonPath(session.session_id), "utf8"),
          ),
          summaryPath: getSessionSummaryJsonPath(session.session_id),
        },
        turns: reduced.turns,
      });

      processed.push({
        archived,
        extracted,
        session_id: session.session_id,
      });
    } catch (error) {
      processed.push({
        error: error instanceof Error ? error.message : String(error),
        session_id: session.session_id,
        skipped: true,
      });
    }
  }

  context.output.info(JSON.stringify({ processed }, null, 2));
  return 0;
}

async function selectReextractSessions(
  database: DatabaseSync,
  options: ReextractOptions,
): Promise<SourceSessionRow[]> {
  if (options.sessionIds !== undefined && options.sessionIds.length > 0) {
    return options.sessionIds
      .map((sessionId) => getSourceSessionBySessionId(database, sessionId))
      .filter((session): session is SourceSessionRow => session !== null);
  }

  if (options.overExtractedOnly) {
    const candidates = listSourceSessions(database);
    const overExtracted: SourceSessionRow[] = [];

    for (const session of candidates) {
      const projectLearningCount = await countProjectLearnings(session);
      if (projectLearningCount > DEFAULT_MAX_PROJECT_LEARNINGS_PER_SESSION) {
        overExtracted.push(session);
      }
    }

    return overExtracted;
  }

  return listSourceSessions(database);
}

export function parseReextractOptions(args: readonly string[]): ReextractOptions {
  let dryRun = false;
  let overExtractedOnly = false;
  const sessionIds: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (arg === "--over-extracted-only") {
      overExtractedOnly = true;
      continue;
    }

    if (arg === "--session-id") {
      sessionIds.push(requireOptionValue("--session-id", args[index + 1]));
      index += 1;
      continue;
    }

    throw new Error(`Unknown reextract option: ${arg}`);
  }

  return {
    ...(dryRun ? { dryRun: true } : {}),
    ...(overExtractedOnly ? { overExtractedOnly: true } : {}),
    ...(sessionIds.length > 0 ? { sessionIds } : {}),
  };
}

function requireOptionValue(flag: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing value for ${flag}`);
  }

  return value;
}
