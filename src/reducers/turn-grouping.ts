import type { CursorTranscriptRecord } from "../adapters/cursor/intermediate.js";

export type GroupedTurn = {
  turnId: string;
  sessionId: string;
  index: number;
  userPrompt: string;
  assistantMessages: string[];
  commandStrings: string[];
  filePaths: string[];
  records: CursorTranscriptRecord[];
  sourceLineEnd: number;
  sourceLineStart: number;
  startedAtHint: string | null;
  endedAtHint: string | null;
};

export type GroupTurnsOptions = {
  records: CursorTranscriptRecord[];
  sessionId: string;
};

export function groupRecordsIntoTurns(options: GroupTurnsOptions): GroupedTurn[] {
  const groupedTurns: GroupedTurn[] = [];
  let currentTurn: GroupedTurn | null = null;
  let leadingRecords: CursorTranscriptRecord[] = [];

  for (const record of options.records) {
    if (record.kind === "user_message") {
      if (currentTurn !== null) {
        groupedTurns.push(finalizeTurn(currentTurn));
      }

      currentTurn = createTurn({
        index: groupedTurns.length,
        leadingRecords,
        record,
        sessionId: options.sessionId,
      });
      leadingRecords = [];
      continue;
    }

    if (currentTurn === null) {
      leadingRecords.push(record);
      continue;
    }

    currentTurn.records.push(record);
  }

  if (currentTurn !== null) {
    groupedTurns.push(finalizeTurn(currentTurn));
  }

  return groupedTurns;
}

function createTurn(options: {
  index: number;
  leadingRecords: CursorTranscriptRecord[];
  record: CursorTranscriptRecord;
  sessionId: string;
}): GroupedTurn {
  const records = [...options.leadingRecords, options.record];
  const lineNumbers = records.map((record) => record.provenance.lineNumber);

  return {
    turnId: `${options.sessionId}:turn-${String(options.index).padStart(4, "0")}`,
    sessionId: options.sessionId,
    index: options.index,
    userPrompt: deriveUserPrompt(options.record),
    assistantMessages: [],
    commandStrings: [],
    filePaths: [],
    records,
    sourceLineEnd: Math.max(...lineNumbers),
    sourceLineStart: Math.min(...lineNumbers),
    startedAtHint: pickFirstTimestamp(records),
    endedAtHint: pickLastTimestamp(records),
  };
}

function finalizeTurn(turn: GroupedTurn): GroupedTurn {
  const assistantMessages: string[] = [];
  const commandStrings: string[] = [];
  const filePaths: string[] = [];

  for (const record of turn.records) {
    if (record.kind === "assistant_message" && record.messageText !== null) {
      assistantMessages.push(record.messageText);
    }

    commandStrings.push(...record.commandStrings);
    filePaths.push(...record.filePaths);
  }

  return {
    ...turn,
    assistantMessages: uniquePreservingOrder(assistantMessages),
    commandStrings: uniquePreservingOrder(commandStrings),
    filePaths: uniquePreservingOrder(filePaths),
    sourceLineEnd:
      turn.records[turn.records.length - 1]?.provenance.lineNumber ?? turn.sourceLineEnd,
    sourceLineStart: turn.records[0]?.provenance.lineNumber ?? turn.sourceLineStart,
    startedAtHint: pickFirstTimestamp(turn.records),
    endedAtHint: pickLastTimestamp(turn.records),
  };
}

function deriveUserPrompt(record: CursorTranscriptRecord): string {
  if (record.messageText !== null && record.messageText.trim().length > 0) {
    return record.messageText.trim();
  }

  if (record.contentRedacted) {
    return "[redacted user message]";
  }

  return "[user message unavailable]";
}

function pickFirstTimestamp(records: CursorTranscriptRecord[]): string | null {
  for (const record of records) {
    if (record.timestampHint !== null) {
      return record.timestampHint;
    }
  }

  return null;
}

function pickLastTimestamp(records: CursorTranscriptRecord[]): string | null {
  for (const record of [...records].reverse()) {
    if (record.timestampHint !== null) {
      return record.timestampHint;
    }
  }

  return null;
}

function uniquePreservingOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }

    seen.add(value);
    unique.push(value);
  }

  return unique;
}
