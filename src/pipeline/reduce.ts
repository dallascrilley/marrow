import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type { CursorTranscriptRecord } from "../adapters/cursor/intermediate.js";
import { getRuntimePath } from "../config/paths.js";
import {
  getPhaseCheckpoint,
  insertRunHistory,
  transitionPhase
} from "../db/ledger.js";
import type { SourceSessionRow } from "../db/queries.js";
import type { Event, Turn } from "../models/canonical.js";
import { turnSchema } from "../models/canonical.js";
import { extractCommandsByTurn } from "../reducers/command-extraction.js";
import { tagTurnEvents } from "../reducers/event-tagging.js";
import { groupRecordsIntoTurns, type GroupedTurn } from "../reducers/turn-grouping.js";

export type ReducedArtifact = {
  events: Event[];
  turns: Turn[];
};

export type ReducePhaseResult = ReducedArtifact & {
  artifactPath: string;
  resumed: boolean;
};

export async function runReducePhase(input: {
  database: DatabaseSync;
  parsedRecords: readonly CursorTranscriptRecord[];
  resume?: boolean;
  sourceSession: SourceSessionRow;
}): Promise<ReducePhaseResult> {
  const artifactPath = getReducedArtifactPath(input.sourceSession.session_id);
  const checkpoint = getPhaseCheckpoint(input.database, input.sourceSession.id, "reduced");

  if (
    input.resume === true &&
    checkpoint?.phase_state === "completed" &&
    checkpoint.source_hash === input.sourceSession.source_hash &&
    (await fileExists(artifactPath))
  ) {
    const resumed = JSON.parse(await readFile(artifactPath, "utf8")) as ReducedArtifact;
    return {
      artifactPath,
      events: resumed.events,
      resumed: true,
      turns: resumed.turns
    };
  }

  try {
    const groupedTurns = groupRecordsIntoTurns({
      records: [...input.parsedRecords],
      sessionId: input.sourceSession.session_id
    });
    const commandResult = extractCommandsByTurn(groupedTurns);
    const taggedEvents = tagTurnEvents(groupedTurns);
    const turns = groupedTurns.map((turn) =>
      toCanonicalTurn(turn, input.sourceSession, commandResult.byTurn[turn.turnId] ?? [], taggedEvents)
    );
    const artifact: ReducedArtifact = {
      events: taggedEvents,
      turns
    };

    await writeJsonArtifact(artifactPath, artifact);
    const detailsJson = JSON.stringify({
      artifact_path: artifactPath,
      event_count: taggedEvents.length,
      turn_count: turns.length
    });
    const run = insertRunHistory(input.database, {
      detailsJson,
      finishedAt: new Date().toISOString(),
      phaseName: "reduced",
      phaseState: "completed",
      sessionId: input.sourceSession.session_id,
      sourceHash: input.sourceSession.source_hash,
      sourceSessionId: input.sourceSession.id
    });

    transitionPhase(input.database, {
      detailsJson,
      phaseName: "reduced",
      phaseState: "completed",
      runId: run.id,
      sourceHash: input.sourceSession.source_hash,
      sourceSessionId: input.sourceSession.id
    });

    return {
      artifactPath,
      events: taggedEvents,
      resumed: false,
      turns
    };
  } catch (error) {
    const detailsJson = JSON.stringify({
      error: error instanceof Error ? error.message : String(error)
    });
    const run = insertRunHistory(input.database, {
      detailsJson,
      finishedAt: new Date().toISOString(),
      phaseName: "reduced",
      phaseState: "failed",
      sessionId: input.sourceSession.session_id,
      sourceHash: input.sourceSession.source_hash,
      sourceSessionId: input.sourceSession.id
    });
    transitionPhase(input.database, {
      detailsJson,
      phaseName: "reduced",
      phaseState: "failed",
      runId: run.id,
      sourceHash: input.sourceSession.source_hash,
      sourceSessionId: input.sourceSession.id
    });
    throw error;
  }
}

export function getReducedArtifactPath(sessionId: string): string {
  return join(getRuntimePath("staging"), sessionId, "reduced-session.json");
}

function toCanonicalTurn(
  turn: GroupedTurn,
  sourceSession: SourceSessionRow,
  commandsSeen: readonly string[],
  events: readonly Event[]
): Turn {
  const assistantSummary = turn.assistantMessages.join(" ").trim() || "No assistant summary captured.";
  const turnEvents = events.filter((event) => event.turn_id === turn.turnId);

  return turnSchema.parse({
    assistant_summary: truncateInline(assistantSummary, 240),
    commands_seen: [...commandsSeen],
    ended_at: turn.endedAtHint ?? turn.startedAtHint ?? sourceSession.updated_at,
    files_touched: turn.filePaths,
    index: turn.index,
    session_id: sourceSession.session_id,
    started_at: turn.startedAtHint ?? sourceSession.started_at,
    tool_stub_count: turn.records.filter(
      (record) => record.kind === "tool_use_stub" || record.kind === "tool_result_stub"
    ).length,
    turn_id: turn.turnId,
    user_prompt: turn.userPrompt,
    verification_seen: turnEvents.some((event) => event.type === "verification")
  });
}

function truncateInline(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

async function writeJsonArtifact(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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
