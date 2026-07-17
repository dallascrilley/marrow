import { access, readFile } from "node:fs/promises";

import type { DatabaseSync } from "node:sqlite";

import type { CursorTranscriptRecord } from "../adapters/cursor/intermediate.js";
import type { CommandContext } from "../cli.js";
import { getSourceSessionBySessionId, listSourceSessions } from "../db/ledger.js";
import type { SourceSessionRow } from "../db/queries.js";
import { getParsedArtifactPath } from "../pipeline/parse.js";
import { runReducePhase } from "../pipeline/reduce.js";
import { regenerateFromReduced } from "./pipeline-reextract.js";

export type RereduceOptions = {
  allWithParsed: boolean;
  dryRun: boolean;
  sessionIds: string[];
};

/**
 * Retroactively re-run the reduce phase (then summarize + extract + archive) on
 * already-ingested sessions from their surviving `parsed-records.json` staging
 * artifact, so reduce-layer improvements (assistant-summary fidelity, command
 * coverage) reach historical sessions. Sessions whose parsed records were
 * purged cannot be re-reduced — their reduced artifact is final — and are
 * reported as locked.
 *
 * Requires an explicit selector — it refuses to reprocess the whole corpus by
 * accident. Deterministic; makes no LLM calls.
 */
export async function executePipelineRereduce(
  context: CommandContext,
  database: DatabaseSync,
): Promise<number> {
  const options = parseRereduceOptions(context.args);

  if (options.sessionIds.length === 0 && !options.allWithParsed) {
    throw new Error(
      "Refusing to re-reduce all sessions without an explicit selector. Pass --all-with-parsed or --session-id <id>.",
    );
  }

  const sessions = selectSessions(database, options);
  const candidates: SourceSessionRow[] = [];
  const lockedSessionIds: string[] = [];

  for (const session of sessions) {
    if (await fileExists(getParsedArtifactPath(session.session_id))) {
      candidates.push(session);
    } else {
      lockedSessionIds.push(session.session_id);
    }
  }

  if (options.dryRun) {
    context.output.info(
      JSON.stringify(
        {
          candidate_session_ids: candidates.map((session) => session.session_id),
          dry_run: true,
          locked_session_ids: lockedSessionIds,
          matched_count: sessions.length,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  const processed: Array<Record<string, unknown>> = [];

  for (const session of candidates) {
    try {
      const parsedRecords = JSON.parse(
        await readFile(getParsedArtifactPath(session.session_id), "utf8"),
      ) as CursorTranscriptRecord[];

      const reduced = await runReducePhase({
        database,
        parsedRecords,
        resume: false,
        sourceSession: session,
      });
      const { knowledge, summary } = await regenerateFromReduced({
        database,
        events: reduced.events,
        sourceSession: session,
        turns: reduced.turns,
      });

      processed.push({
        project_learning_count: knowledge.project.count,
        session_id: session.session_id,
        summary_path: summary.summaryPath,
        turn_count: reduced.turns.length,
      });
    } catch (error) {
      // A throw partway through the phases leaves this session partially
      // regenerated. The phases are overwrite-safe, so re-running
      // `rereduce --session-id <id>` heals it; the session is reported so the
      // operator can re-target it.
      processed.push({
        error: error instanceof Error ? error.message : String(error),
        session_id: session.session_id,
        skipped: true,
      });
    }
  }

  const rereducedCount = processed.filter((entry) => entry.skipped !== true).length;
  const skippedCount = processed.length - rereducedCount;
  const notes: string[] = [];
  if (lockedSessionIds.length > 0) {
    notes.push(
      "Sessions without parsed-records.json cannot be re-reduced; their existing reduced artifacts are final.",
    );
  }
  if (skippedCount > 0) {
    notes.push("Re-run with --session-id <id> to heal partially-processed sessions.");
  }
  context.output.info(
    JSON.stringify(
      {
        locked_session_ids: lockedSessionIds,
        matched_count: sessions.length,
        processed,
        rereduced_count: rereducedCount,
        skipped_count: skippedCount,
        ...(notes.length > 0 ? { notes } : {}),
      },
      null,
      2,
    ),
  );
  return rereducedCount === 0 && sessions.length > 0 ? 1 : 0;
}

function selectSessions(database: DatabaseSync, options: RereduceOptions): SourceSessionRow[] {
  if (options.sessionIds.length > 0) {
    return options.sessionIds
      .map((sessionId) => getSourceSessionBySessionId(database, sessionId))
      .filter((session): session is SourceSessionRow => session !== null);
  }

  return listSourceSessions(database);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    return isMissingFileError(error) ? false : Promise.reject(error);
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export function parseRereduceOptions(args: readonly string[]): RereduceOptions {
  let allWithParsed = false;
  let dryRun = false;
  const sessionIds: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (arg === "--all-with-parsed") {
      allWithParsed = true;
      continue;
    }

    if (arg === "--session-id") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--session-id requires a value");
      }
      sessionIds.push(value);
      index += 1;
      continue;
    }

    throw new Error(`Unknown rereduce option: ${arg}`);
  }

  return { allWithParsed, dryRun, sessionIds };
}
