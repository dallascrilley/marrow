import { readFile } from "node:fs/promises";

import type { DatabaseSync } from "node:sqlite";

import type { CommandContext } from "../cli.js";
import { getSourceSessionBySessionId, listSourceSessions } from "../db/ledger.js";
import type { SourceSessionRow } from "../db/queries.js";
import type { Event, Turn } from "../models/canonical.js";
import { runArchivePhase } from "../pipeline/archive.js";
import { hasProcessChatter } from "../pipeline/artifact-heuristics.js";
import { getReducedArtifactPath } from "../pipeline/reduce.js";
import { runSummarizePhase } from "../pipeline/summarize-phase.js";
import { getSessionSummaryJsonPath } from "../writers/summary-writer.js";
import { runExtractPhase } from "./ingest-backfill.js";

export type ReextractOptions = {
  dryRun: boolean;
  processChatterOnly: boolean;
  sessionIds: string[];
};

/**
 * Retroactively re-run summarize + extract + archive on already-ingested
 * sessions, regenerating their artifacts with the current pipeline (current
 * process-chatter filters, learning cap, sanitizers). The reduced artifact is
 * reused as-is, so this is fully deterministic and makes no LLM calls.
 *
 * Requires an explicit selector — it refuses to reprocess the whole corpus by
 * accident.
 */
export async function executePipelineReextract(
  context: CommandContext,
  database: DatabaseSync,
): Promise<number> {
  const options = parseReextractOptions(context.args);

  if (options.sessionIds.length === 0 && !options.processChatterOnly) {
    throw new Error(
      "Refusing to re-extract all sessions without an explicit selector. Pass --process-chatter-only or --session-id <id>.",
    );
  }

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
      ) as { events: Event[]; turns: Turn[] };

      // force=true, resume=false, llmTopic=false → deterministic regeneration.
      const summary = await runSummarizePhase(
        database,
        session,
        reduced.turns,
        reduced.events,
        false,
        false,
        true,
      );
      const knowledge = await runExtractPhase(
        database,
        session,
        reduced.turns,
        reduced.events,
        false,
      );
      await runArchivePhase({
        database,
        events: reduced.events,
        knowledge,
        sourceSession: session,
        sourceSessionId: session.id,
        summary,
        turns: reduced.turns,
      });

      processed.push({
        project_learning_count: knowledge.project.count,
        session_id: session.session_id,
        summary_path: summary.summaryPath,
      });
    } catch (error) {
      // A throw partway through the phases (e.g. summary written but extract
      // failed) leaves this session partially regenerated. The phases are
      // overwrite-safe, so re-running `reextract --session-id <id>` heals it;
      // the session is reported below so the operator can re-target it.
      processed.push({
        error: error instanceof Error ? error.message : String(error),
        session_id: session.session_id,
        skipped: true,
      });
    }
  }

  const reextractedCount = processed.filter((entry) => entry.skipped !== true).length;
  const skippedCount = sessions.length - reextractedCount;
  context.output.info(
    JSON.stringify(
      {
        matched_count: sessions.length,
        processed,
        reextracted_count: reextractedCount,
        skipped_count: skippedCount,
        ...(skippedCount > 0
          ? { note: "Re-run with --session-id <id> to heal partially-processed sessions." }
          : {}),
      },
      null,
      2,
    ),
  );
  return reextractedCount === 0 && sessions.length > 0 ? 1 : 0;
}

async function selectReextractSessions(
  database: DatabaseSync,
  options: ReextractOptions,
): Promise<SourceSessionRow[]> {
  if (options.sessionIds.length > 0) {
    return options.sessionIds
      .map((sessionId) => getSourceSessionBySessionId(database, sessionId))
      .filter((session): session is SourceSessionRow => session !== null);
  }

  // processChatterOnly: pick sessions whose current summary the audit would
  // flag as process_chatter, using the same detection as quality-audit.
  const matched: SourceSessionRow[] = [];
  for (const session of listSourceSessions(database)) {
    if (await summaryHasProcessChatter(session.session_id)) {
      matched.push(session);
    }
  }
  return matched;
}

async function summaryHasProcessChatter(sessionId: string): Promise<boolean> {
  try {
    const summary = JSON.parse(await readFile(getSessionSummaryJsonPath(sessionId), "utf8")) as {
      next_step?: string;
      project_learnings?: string[];
      topic?: string;
      user_learnings?: string[];
      what_failed?: string[];
      what_was_decided?: string[];
      what_worked?: string[];
    };
    const summaryText = [
      summary.topic ?? "",
      ...(summary.what_worked ?? []),
      ...(summary.what_failed ?? []),
      ...(summary.what_was_decided ?? []),
      summary.next_step ?? "",
      ...(summary.project_learnings ?? []),
      ...(summary.user_learnings ?? []),
    ].join("\n");
    return hasProcessChatter(summaryText);
  } catch {
    return false;
  }
}

export function parseReextractOptions(args: readonly string[]): ReextractOptions {
  let dryRun = false;
  let processChatterOnly = false;
  const sessionIds: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (arg === "--process-chatter-only") {
      processChatterOnly = true;
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

    throw new Error(`Unknown reextract option: ${arg}`);
  }

  return { dryRun, processChatterOnly, sessionIds };
}
