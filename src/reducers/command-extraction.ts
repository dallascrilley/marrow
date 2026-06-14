import type { CursorTranscriptRecord } from "../adapters/cursor/intermediate.js";
import type { GroupedTurn } from "./turn-grouping.js";

const commandStarterPattern =
  /^(?:\.\/[\w./-]+|(?:npm|pnpm|yarn|bun|node|python3?|uv|git|just|make|cargo|go|docker|sqlite3)\b)/i;
const inlineCodePattern = /`([^`\n]+)`/g;
const trailingPunctuationPattern = /[.,;:!?]+$/;
const disallowedBareCommands = new Set(["node", "python", "python3"]);

export type ExtractedCommand = {
  command: string;
  firstSeenLineNumber: number;
  normalizedCommand: string;
  turnId: string;
};

export type CommandExtractionResult = {
  allCommands: string[];
  byTurn: Record<string, string[]>;
  entries: ExtractedCommand[];
};

export function extractCommandsByTurn(turns: GroupedTurn[]): CommandExtractionResult {
  const byTurn: Record<string, string[]> = {};
  const entries: ExtractedCommand[] = [];
  const seenGlobal = new Set<string>();

  for (const turn of turns) {
    const seenTurn = new Set<string>();
    const turnCommands: string[] = [];

    for (const record of turn.records) {
      for (const candidate of collectCommandCandidates(record)) {
        const normalizedCommand = normalizeCommand(candidate);

        if (normalizedCommand === null || seenTurn.has(normalizedCommand)) {
          continue;
        }

        seenTurn.add(normalizedCommand);
        turnCommands.push(normalizedCommand);

        if (!seenGlobal.has(normalizedCommand)) {
          seenGlobal.add(normalizedCommand);
          entries.push({
            command: normalizedCommand,
            firstSeenLineNumber: record.provenance.lineNumber,
            normalizedCommand,
            turnId: turn.turnId,
          });
        }
      }
    }

    byTurn[turn.turnId] = turnCommands;
  }

  return {
    allCommands: entries.map((entry) => entry.command),
    byTurn,
    entries,
  };
}

function collectCommandCandidates(record: CursorTranscriptRecord): string[] {
  const candidates = [...record.commandStrings];
  const messageText = record.messageText;

  const toolInput = record.toolUse?.inputText;

  if (toolInput !== null && toolInput !== undefined) {
    candidates.push(toolInput);
  }

  if (messageText !== null) {
    for (const match of messageText.matchAll(inlineCodePattern)) {
      const command = match[1]?.trim();

      if (command !== undefined) {
        candidates.push(command);
      }
    }
  }

  return candidates;
}

function normalizeCommand(value: string): string | null {
  const trimmed = value
    .trim()
    .replace(/^`+|`+$/g, "")
    .replace(/\s+/g, " ")
    .replace(trailingPunctuationPattern, "");

  if (trimmed.length === 0 || !commandStarterPattern.test(trimmed) || trimmed.includes("\n")) {
    return null;
  }

  if (!trimmed.includes(" ") && disallowedBareCommands.has(trimmed.toLowerCase())) {
    return null;
  }

  return trimmed;
}
