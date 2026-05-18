import type { JsonValue } from "../../models/canonical.js";
import { isJsonRecord, type JsonRecord } from "./jsonl.js";

/**
 * Generic regex constants used by every adapter's text extractor. None of
 * these are language- or tool-specific; they describe POSIX/Windows paths,
 * common interpreter command lines, and inline-code markup found across
 * agent transcript shapes.
 */
export const commandStarterPattern =
  /(?:^|\s)(\.\/[\w./-]+|(?:npm|pnpm|yarn|bun|node|python3?|uv|git|just|make|cargo|go|docker|sqlite3)\b(?: [^`"\n,.;:!?]+)*)/g;
export const commandLinePattern =
  /^(?:[-*]\s*)?(?:\.\/[\w./-]+|(?:npm|pnpm|yarn|bun|node|python3?|uv|git|just|make|cargo|go|docker|sqlite3)\b)/i;
export const runCommandPattern =
  /\brun\s+(\.\/[\w./-]+|(?:npm|pnpm|yarn|bun|node|python3?|uv|git|just|make|cargo|go|docker|sqlite3)\b[^`\n,.;:!?]*)/gi;
export const inlineCodePattern = /`([^`\n]+)`/g;
export const posixPathPattern = /\/(?:Users|home|tmp|var|opt|private|Volumes)\/[^\s"'`]+/g;
export const windowsPathPattern = /[A-Za-z]:\\[^\s"'`]+/g;

/**
 * Walk a JSON tree along `path` and return the value at the leaf, or
 * `undefined` if any segment is missing or non-object.
 */
export function readValueAtPath(
  value: JsonValue,
  path: ReadonlyArray<string>
): JsonValue | undefined {
  let current: JsonValue | undefined = value;

  for (const segment of path) {
    if (!isJsonRecord(current)) {
      return undefined;
    }

    current = current[segment];
  }

  return current;
}

/**
 * Try each candidate path in order; return the first non-empty string found,
 * or `null` if none match.
 */
export function pickFirstString(
  value: JsonRecord,
  paths: ReadonlyArray<ReadonlyArray<string>>
): string | null {
  for (const path of paths) {
    const candidate = readValueAtPath(value, path);

    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }
  }

  return null;
}

/**
 * Recursively extract a single normalized text value from a JSON tree.
 * Handles strings, arrays of strings, and nested `{ text }` / `{ content }` /
 * `{ message }` / `{ body }` shapes that show up across agent transcript
 * formats.
 */
export function extractNormalizedText(value: JsonValue | undefined): string | null {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => extractNormalizedText(entry))
      .filter((entry): entry is string => entry !== null);

    if (parts.length === 0) {
      return null;
    }

    return parts.join("\n\n");
  }

  if (isJsonRecord(value)) {
    const textValue = value.text;

    if (typeof textValue === "string") {
      const normalized = textValue.trim();
      if (normalized.length > 0) {
        return normalized;
      }
    }

    const nestedCandidates: JsonValue[] = [];

    if ("content" in value) {
      nestedCandidates.push(value.content);
    }

    if ("message" in value) {
      nestedCandidates.push(value.message);
    }

    if ("body" in value) {
      nestedCandidates.push(value.body);
    }

    for (const candidate of nestedCandidates) {
      const normalized = extractNormalizedText(candidate);

      if (normalized !== null) {
        return normalized;
      }
    }
  }

  return null;
}

/**
 * Pull a tool-call's input text from common JSON paths. Returns the trimmed
 * value, or `null` when no candidate path resolves to a non-empty string.
 */
export function extractToolInputText(parsedLine: JsonRecord): string | null {
  const candidate = pickFirstString(parsedLine, [
    ["arguments", "command"],
    ["arguments", "input"],
    ["arguments", "path"],
    ["input"],
    ["command"],
    ["path"]
  ]);

  return candidate?.trim() || null;
}

/** Pull a timestamp hint from the usual ISO-shaped fields. */
export function extractTimestampHint(parsedLine: JsonRecord): string | null {
  return (
    pickFirstString(parsedLine, [
      ["timestamp"],
      ["createdAt"],
      ["updatedAt"],
      ["time"],
      ["ts"],
      ["date"]
    ]) ?? null
  );
}

/** Walk a JSON tree and yield every string value it contains. */
export function* iterateStrings(value: JsonValue): Generator<string> {
  if (typeof value === "string") {
    yield value;
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      yield* iterateStrings(entry);
    }

    return;
  }

  if (isJsonRecord(value)) {
    for (const entry of Object.values(value)) {
      yield* iterateStrings(entry);
    }
  }
}

/** True when `value` is the textual marker `[redacted]` (any case/bracket form). */
export function looksRedacted(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "[redacted]" || normalized === "<redacted>" || normalized === "redacted";
}

/**
 * Return true when the parsed line carries the `isRedacted: true` flag or
 * contains a string value matching `looksRedacted`.
 */
export function detectRedaction(parsedLine: JsonRecord): boolean {
  const explicitFlag = readValueAtPath(parsedLine, ["isRedacted"]);

  if (explicitFlag === true) {
    return true;
  }

  for (const value of iterateStrings(parsedLine)) {
    if (looksRedacted(value)) {
      return true;
    }
  }

  return false;
}

/**
 * Build the set of strings the adapter should scan for file-path and
 * command-string mentions: the message body, the tool input text, and any
 * generic `arguments.path`/`cwd` / `metadata.path`/`cwd` / top-level
 * `path`/`cwd` fields the line carries.
 */
export function collectFocusedStringSources(
  parsedLine: JsonRecord,
  messageText: string | null,
  toolInputText: string | null
): string[] {
  const sources: string[] = [];

  if (messageText !== null) {
    sources.push(messageText);
  }

  if (toolInputText !== null) {
    sources.push(toolInputText);
  }

  for (const path of [
    ["arguments", "path"],
    ["arguments", "cwd"],
    ["metadata", "path"],
    ["metadata", "cwd"],
    ["path"],
    ["cwd"]
  ] satisfies ReadonlyArray<ReadonlyArray<string>>) {
    const candidate = pickFirstString(parsedLine, [path]);

    if (candidate !== null) {
      sources.push(candidate);
    }
  }

  return sources;
}

/** Extract POSIX and Windows file paths mentioned in any string source. */
export function extractFilePaths(
  parsedLine: JsonRecord,
  messageText: string | null,
  toolInputText: string | null
): string[] {
  const paths: string[] = [];

  for (const value of collectFocusedStringSources(parsedLine, messageText, toolInputText)) {
    paths.push(...value.match(posixPathPattern) ?? []);
    paths.push(...value.match(windowsPathPattern) ?? []);
  }

  return paths;
}

/** Extract shell command strings from inline code, command lines, and `run X` phrases. */
export function extractCommandStrings(
  parsedLine: JsonRecord,
  messageText: string | null,
  toolInputText: string | null
): string[] {
  const commands: string[] = [];

  if (toolInputText !== null) {
    if (commandLinePattern.test(toolInputText.trim())) {
      commands.push(toolInputText);
    }
  }

  for (const value of collectFocusedStringSources(parsedLine, messageText, null)) {
    commands.push(...matchInlineCommands(value));
    commands.push(...matchShellCommandLines(value));
    commands.push(...matchRunCommands(value));
  }

  return commands;
}

function matchInlineCommands(value: string): string[] {
  const commands: string[] = [];

  for (const match of value.matchAll(inlineCodePattern)) {
    const command = match[1]?.trim();

    if (command) {
      commands.push(command);
    }
  }

  return commands;
}

function matchShellCommandLines(value: string): string[] {
  const commands: string[] = [];

  for (const line of value.split(/\r?\n+/)) {
    const normalizedLine = line.trim();

    if (!commandLinePattern.test(normalizedLine)) {
      continue;
    }

    for (const command of normalizedLine.match(commandStarterPattern) ?? []) {
      const normalized = command.trim();

      if (normalized.length > 0) {
        commands.push(normalized);
      }
    }
  }

  return commands;
}

function matchRunCommands(value: string): string[] {
  const commands: string[] = [];

  for (const match of value.matchAll(runCommandPattern)) {
    const command = match[1]?.trim();

    if (command) {
      commands.push(command);
    }
  }

  return commands;
}

/** Deduplicate an array while preserving the first occurrence's order. */
export function uniquePreservingOrder(values: string[]): string[] {
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
