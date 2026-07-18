import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type { CursorTranscriptRecord } from "../adapters/cursor/intermediate.js";
import { getPhaseCheckpoint, insertRunHistory, transitionPhase } from "../db/ledger.js";
import type { SourceSessionRow } from "../db/queries.js";
import type { Event, Turn } from "../models/canonical.js";
import { turnSchema } from "../models/canonical.js";
import { extractCommandsByTurn } from "../reducers/command-extraction.js";
import { tagTurnEvents } from "../reducers/event-tagging.js";
import { type GroupedTurn, groupRecordsIntoTurns } from "../reducers/turn-grouping.js";
import { ensureStagingRoot, getReducedStagingArtifactPath } from "../storage/staging.js";

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
  await ensureStagingRoot();
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
      turns: resumed.turns,
    };
  }

  try {
    const groupedTurns = groupRecordsIntoTurns({
      records: [...input.parsedRecords],
      sessionId: input.sourceSession.session_id,
    });
    const commandResult = extractCommandsByTurn(groupedTurns);
    const taggedEvents = tagTurnEvents(groupedTurns);
    const turns = groupedTurns.map((turn) =>
      toCanonicalTurn(
        turn,
        input.sourceSession,
        commandResult.byTurn[turn.turnId] ?? [],
        taggedEvents,
      ),
    );
    const artifact: ReducedArtifact = {
      events: taggedEvents,
      turns,
    };

    await writeJsonArtifact(artifactPath, artifact);
    const detailsJson = JSON.stringify({
      artifact_path: artifactPath,
      event_count: taggedEvents.length,
      turn_count: turns.length,
    });
    const run = insertRunHistory(input.database, {
      detailsJson,
      finishedAt: new Date().toISOString(),
      phaseName: "reduced",
      phaseState: "completed",
      sessionId: input.sourceSession.session_id,
      sourceHash: input.sourceSession.source_hash,
      sourceSessionId: input.sourceSession.id,
    });

    transitionPhase(input.database, {
      detailsJson,
      phaseName: "reduced",
      phaseState: "completed",
      runId: run.id,
      sourceHash: input.sourceSession.source_hash,
      sourceSessionId: input.sourceSession.id,
    });

    return {
      artifactPath,
      events: taggedEvents,
      resumed: false,
      turns,
    };
  } catch (error) {
    const detailsJson = JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    });
    const run = insertRunHistory(input.database, {
      detailsJson,
      finishedAt: new Date().toISOString(),
      phaseName: "reduced",
      phaseState: "failed",
      sessionId: input.sourceSession.session_id,
      sourceHash: input.sourceSession.source_hash,
      sourceSessionId: input.sourceSession.id,
    });
    transitionPhase(input.database, {
      detailsJson,
      phaseName: "reduced",
      phaseState: "failed",
      runId: run.id,
      sourceHash: input.sourceSession.source_hash,
      sourceSessionId: input.sourceSession.id,
    });
    throw error;
  }
}

export function getReducedArtifactPath(sessionId: string): string {
  return getReducedStagingArtifactPath(sessionId);
}

export const defaultAssistantSummaryBudget = 240;
export const highSignalAssistantSummaryBudget = 1600;
export const failureFocusExcerptBudget = 600;

const maxFailureFocusExcerpts = 2;
const minimumExcerptBudget = 20;

function toCanonicalTurn(
  turn: GroupedTurn,
  sourceSession: SourceSessionRow,
  commandsSeen: readonly string[],
  events: readonly Event[],
): Turn {
  const turnEvents = events.filter((event) => event.turn_id === turn.turnId);

  return turnSchema.parse({
    assistant_summary: buildAssistantSummary(turn, turnEvents),
    commands_seen: [...commandsSeen],
    ended_at: turn.endedAtHint ?? turn.startedAtHint ?? sourceSession.updated_at,
    files_touched: turn.filePaths,
    index: turn.index,
    session_id: sourceSession.session_id,
    started_at: turn.startedAtHint ?? sourceSession.started_at,
    tool_stub_count: turn.records.filter(
      (record) => record.kind === "tool_use_stub" || record.kind === "tool_result_stub",
    ).length,
    turn_id: turn.turnId,
    user_prompt: turn.userPrompt,
    verification_seen: turnEvents.some((event) => event.type === "verification"),
  });
}

/**
 * Composes the turn's assistant summary. Normal turns keep the historic 240-char
 * head truncation. Turns with error/verification signal (failed tool result, or a
 * failure/verification event) get a wider budget that leads with the assistant
 * messages around the signal — that is where root-cause reasoning concentrates —
 * followed by the remaining head context.
 */
export function buildAssistantSummary(turn: GroupedTurn, turnEvents: readonly Event[]): string {
  const focusMessages = collectFocusMessages(turn, turnEvents);

  if (focusMessages.length === 0) {
    return (
      truncateInline(turn.assistantMessages.join(" "), defaultAssistantSummaryBudget) ||
      "No assistant summary captured."
    );
  }

  const parts: string[] = [];
  let remaining = highSignalAssistantSummaryBudget;

  for (const message of focusMessages.slice(0, maxFailureFocusExcerpts)) {
    const budget = Math.min(failureFocusExcerptBudget, remaining);
    if (budget < minimumExcerptBudget) {
      break;
    }

    const excerpt = truncateFocusMessage(message, budget);
    if (excerpt.length === 0) {
      continue;
    }

    parts.push(excerpt);
    remaining -= excerpt.length + 1;
  }

  if (remaining >= minimumExcerptBudget) {
    const focusSet = new Set(focusMessages);
    const head = truncateInline(
      turn.assistantMessages.filter((message) => !focusSet.has(message)).join(" "),
      remaining,
    );
    if (head.length > 0) {
      parts.push(head);
    }
  }

  const summary = parts.join(" ").trim();
  return summary.length > 0 ? summary : "No assistant summary captured.";
}

/**
 * Returns the assistant messages anchoring the turn's error/verification signal:
 * the message containing a failure/verification event, or the first assistant
 * message after a failed tool result. Order follows record order.
 */
function collectFocusMessages(turn: GroupedTurn, turnEvents: readonly Event[]): string[] {
  const signalLines: number[] = [];

  for (const record of turn.records) {
    if (record.kind === "tool_result_stub" && /fail|error/i.test(record.toolUse?.status ?? "")) {
      signalLines.push(record.provenance.lineNumber);
    }
  }
  for (const event of turnEvents) {
    if (event.type === "failure" || event.type === "verification") {
      const startLine = event.source_offsets.start_line;
      if (startLine !== null) {
        signalLines.push(startLine);
      }
    }
  }

  const messagesByLine = new Map<number, string>();
  for (const line of signalLines) {
    const anchorIndex = turn.records.findIndex((record) => record.provenance.lineNumber >= line);
    if (anchorIndex === -1) {
      continue;
    }

    const anchor = turn.records[anchorIndex];
    const target =
      anchor?.kind === "assistant_message"
        ? anchor
        : turn.records.slice(anchorIndex).find((record) => record.kind === "assistant_message");

    if (
      target !== undefined &&
      target.messageText !== null &&
      target.messageText.trim().length > 0
    ) {
      messagesByLine.set(target.provenance.lineNumber, target.messageText);
    }
  }

  return [...messagesByLine.values()];
}

function truncateInline(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

/**
 * Focus-message truncation keeps head AND tail: diagnosis messages build up to
 * their conclusion, so the root cause ("the root cause was X", "fixed by Y")
 * sits near the end. A pure head cut repeats the original 240-char loss at a
 * larger budget.
 */
function truncateFocusMessage(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  const headLength = Math.floor((maxLength - 5) / 3);
  const tailLength = maxLength - 5 - headLength;
  return `${normalized.slice(0, headLength).trimEnd()} ... ${normalized.slice(-tailLength).trimStart()}`;
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
