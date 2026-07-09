import type { Event, Turn } from "../../models/canonical.js";
import { normalizeFilePath } from "../file-paths.js";
import { uniqueStrings } from "./strings.js";

export function extractCommandFromText(value: string): string | null {
  for (const match of value.matchAll(/`([^`\n]+)`/g)) {
    const candidate = match[1]?.trim();

    if (
      candidate !== undefined &&
      /^(?:\.\/[\w./-]+|(?:npm|pnpm|yarn|bun|node|python3?|uv|git|just|make|cargo|go|docker|sqlite3)\b)/i.test(
        candidate,
      )
    ) {
      return candidate;
    }
  }

  return null;
}

export function commandFromEvent(event: Event): string | undefined {
  return readPayloadString(event, "verification_command") ?? usefulCommandsForEvent(event)[0];
}

export function usefulCommandsForTurn(turn: Turn, events: readonly Event[]): string[] {
  return uniqueStrings([
    ...turn.commands_seen,
    ...events.flatMap((event) => usefulCommandsForEvent(event)),
  ]);
}

function usefulCommandsForEvent(event: Event): string[] {
  return uniqueStrings([
    ...readPayloadStringArray(event, "command_strings"),
    ...extractCommandsFromText(event.summary),
  ]).filter(isUsefulCommand);
}

function extractCommandsFromText(value: string): string[] {
  const commands: string[] = [];

  for (const match of value.matchAll(/`([^`\n]+)`/g)) {
    const candidate = match[1]?.trim();

    if (candidate !== undefined) {
      commands.push(candidate);
    }
  }

  return commands;
}

export function usefulFilesForTurn(turn: Turn, events: readonly Event[]): string[] {
  return uniqueStrings([
    ...turn.files_touched,
    ...events.flatMap((event) => readPayloadStringArray(event, "command_strings")),
    ...events.flatMap((event) => readPayloadStringArray(event, "files_touched")),
    ...events.flatMap((event) => readPayloadStringArray(event, "file_paths")),
    ...events.flatMap((event) => readPayloadStringArray(event, "paths")),
  ])
    .map((value) => normalizeFilePath(value))
    .filter((value): value is string => value !== null);
}

function isUsefulCommand(command: string): boolean {
  const normalized = command.trim().toLowerCase();

  if (["node", "python", "python3"].includes(normalized)) {
    return false;
  }

  return /^(?:\.\/[\w./-]+|(?:npm|pnpm|yarn|bun|node|python3?|uv|git|just|make|cargo|go|docker|sqlite3)\b)/i.test(
    command.trim(),
  );
}

export function readPayloadString(event: Event, key: string): string | null {
  const value = event.payload_small[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function readPayloadStringArray(event: Event, key: string): string[] {
  const value = event.payload_small[key];

  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(
    (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
  );
}
