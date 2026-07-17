import type { CursorTranscriptRecord } from "../adapters/cursor/intermediate.js";
import type { GroupedTurn } from "./turn-grouping.js";

// Exported so downstream consumers (summary useful_commands) apply the same
// starter gate as reduction instead of drifting onto a narrower list.
export const commandStarterPattern =
  /^(?:\.\/[\w./-]+|script\/[\w./-]+|(?:npm|pnpm|yarn|bun|node|python3?|uv|git|just|make|cargo|go|docker|sqlite3|gh|jq|curl|wget|rg|grep|ls|cat|sed|awk|ssh|kubectl|brew|td|hubctl|qa|wt|op|gog|mise|tar)\b)/i;
const inlineCodePattern = /`([^`\n]+)`/g;
const trailingPunctuationPattern = /[.,;:!?]+$/;
// td task ids (td-2a8b94, td-2a8b94-some-slug) match the `td` starter via the
// word boundary before `-` but are identifiers, not invocations — real td
// commands are `td <subcommand> …`.
const tdTaskIdPattern = /^td-[0-9a-z]{4,}/i;
// Bare invocations of these print usage/help or open a REPL — no signal.
// (Bare `ls`/`just`/`make`/`qa` do real work and stay allowed.)
const disallowedBareCommands = new Set([
  "awk",
  "brew",
  "bun",
  "cargo",
  "cat",
  "curl",
  "docker",
  "gh",
  "git",
  "go",
  "gog",
  "grep",
  "hubctl",
  "jq",
  "kubectl",
  "mise",
  "node",
  "npm",
  "op",
  "pnpm",
  "python",
  "python3",
  "rg",
  "sed",
  "sqlite3",
  "ssh",
  "tar",
  "td",
  "uv",
  "wget",
  "wt",
  "yarn",
]);

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
  // Multi-line tool inputs (heredocs, chained scripts) are represented by their
  // first line — the collapsed remainder is noise, not a command stub.
  const firstLine = (
    value
      .trim()
      .replace(/^`+|`+$/g, "")
      .split("\n", 1)[0] ?? ""
  ).trim();
  const trimmed = firstLine.replace(/\s+/g, " ").replace(trailingPunctuationPattern, "");

  if (trimmed.length === 0 || !commandStarterPattern.test(trimmed)) {
    return null;
  }

  if (tdTaskIdPattern.test(trimmed)) {
    return null;
  }

  if (!trimmed.includes(" ") && disallowedBareCommands.has(trimmed.toLowerCase())) {
    return null;
  }

  return trimmed;
}
