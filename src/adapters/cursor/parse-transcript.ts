import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

import type { JsonValue } from "../../models/canonical.js";
import type {
  CursorTranscriptRecord,
  CursorTranscriptRecordKind,
  ParseCursorTranscriptOptions,
  ParseCursorTranscriptResult
} from "./intermediate.js";

const commandStarterPattern =
  /(?:^|\s)(\.\/[\w./-]+|(?:npm|pnpm|yarn|bun|node|python3?|uv|git|just|make|cargo|go|docker|sqlite3)\b(?: [^`"\n,.;:!?]+)*)/g;
const commandLinePattern =
  /^(?:[-*]\s*)?(?:\.\/[\w./-]+|(?:npm|pnpm|yarn|bun|node|python3?|uv|git|just|make|cargo|go|docker|sqlite3)\b)/i;
const runCommandPattern =
  /\brun\s+(\.\/[\w./-]+|(?:npm|pnpm|yarn|bun|node|python3?|uv|git|just|make|cargo|go|docker|sqlite3)\b[^`\n,.;:!?]*)/gi;
const inlineCodePattern = /`([^`\n]+)`/g;
const posixPathPattern = /\/(?:Users|home|tmp|var|opt|private|Volumes)\/[^\s"'`]+/g;
const windowsPathPattern = /[A-Za-z]:\\[^\s"'`]+/g;
const attachedFilesPattern = /<attached_files>[\s\S]*?<\/attached_files>/gi;
const codeSelectionPattern = /<code_selection\b[^>]*>[\s\S]*?<\/code_selection>/gi;
const pluginInfoPattern = /<plugin_info\b[^>]*>[\s\S]*?<\/plugin_info>/gi;
const xmlTagPattern = /<\/?[a-z_:-]+(?:\s+[^>]*)?>/gi;

export async function parseCursorTranscript(
  options: ParseCursorTranscriptOptions
): Promise<ParseCursorTranscriptResult> {
  const records: CursorTranscriptRecord[] = [];
  const stream = createReadStream(options.sourcePath, { encoding: "utf8" });
  const lines = createInterface({
    crlfDelay: Infinity,
    input: stream
  });

  let lineNumber = 0;

  try {
    for await (const line of lines) {
      lineNumber += 1;

      if (line.trim().length === 0) {
        continue;
      }

      const parsedLine = parseJsonLine(line, options.sourcePath, lineNumber);
      const normalizedRecord = normalizeTranscriptRecord(parsedLine, {
        lineNumber,
        sourceHash: options.sourceHash,
        sourcePath: options.sourcePath
      });

      records.push(normalizedRecord);
    }
  } finally {
    lines.close();
    stream.close();
  }

  return { records };
}

type RecordContext = {
  lineNumber: number;
  sourceHash: string;
  sourcePath: string;
};

type JsonRecord = Record<string, JsonValue>;

function parseJsonLine(line: string, sourcePath: string, lineNumber: number): JsonRecord {
  let parsed: unknown;

  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new Error(
      `Failed to parse Cursor transcript JSONL at ${sourcePath}:${lineNumber}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  if (!isJsonRecord(parsed)) {
    throw new Error(
      `Cursor transcript JSONL line must be an object at ${sourcePath}:${lineNumber}`
    );
  }

  return parsed;
}

function normalizeTranscriptRecord(
  parsedLine: JsonRecord,
  context: RecordContext
): CursorTranscriptRecord {
  const rawType = pickFirstString(parsedLine, [
    ["type"],
    ["role"],
    ["kind"],
    ["eventType"],
    ["event", "type"]
  ]);
  const kind = classifyRecordKind(rawType);
  const contentRedacted = detectRedaction(parsedLine);
  const messageText = contentRedacted ? null : extractMessageText(parsedLine, kind);
  const toolInputText =
    kind === "tool_use_stub" || kind === "tool_result_stub" ? extractToolInputText(parsedLine) : null;
  const filePaths = uniquePreservingOrder(extractFilePaths(parsedLine, messageText, toolInputText));
  const commandStrings = uniquePreservingOrder(
    extractCommandStrings(parsedLine, messageText, toolInputText)
  );

  return {
    commandStrings,
    contentRedacted,
    filePaths,
    kind,
    messageText,
    provenance: {
      lineNumber: context.lineNumber,
      sourceHash: context.sourceHash,
      sourcePath: context.sourcePath
    },
    rawEvent: parsedLine,
    rawType,
    timestampHint: extractTimestampHint(parsedLine),
    toolUse:
      kind === "tool_use_stub" || kind === "tool_result_stub"
        ? {
            callId: pickFirstString(parsedLine, [["id"], ["callId"], ["toolCallId"]]),
            inputText: toolInputText,
            name: pickFirstString(parsedLine, [["name"], ["toolName"], ["tool", "name"]]),
            status: pickFirstString(parsedLine, [["status"], ["state"], ["tool", "status"]])
          }
        : null
  };
}

function classifyRecordKind(rawType: string | null): CursorTranscriptRecordKind {
  const normalized = rawType?.toLowerCase() ?? "";

  if (normalized.includes("tool_result") || normalized === "result") {
    return "tool_result_stub";
  }

  if (
    normalized.includes("tool_call") ||
    normalized.includes("tool_use") ||
    normalized.includes("function_call")
  ) {
    return "tool_use_stub";
  }

  if (normalized.includes("assistant")) {
    return "assistant_message";
  }

  if (normalized.includes("user") || normalized.includes("human")) {
    return "user_message";
  }

  return "event";
}

function extractMessageText(
  parsedLine: JsonRecord,
  kind: CursorTranscriptRecordKind
): string | null {
  const candidates =
    kind === "user_message" || kind === "assistant_message"
      ? [
          ["text"],
          ["message", "content"],
          ["message", "text"],
          ["content"],
          ["body"],
          ["prompt"]
        ]
      : [
          ["summary"],
          ["message"],
          ["text"],
          ["content"]
        ];

  for (const path of candidates) {
    const candidate = readValueAtPath(parsedLine, path);
    const normalized = sanitizeExtractedText(extractNormalizedText(candidate), kind);

    if (normalized !== null && !looksRedacted(normalized)) {
      return normalized;
    }
  }

  return null;
}

function extractNormalizedText(value: JsonValue | undefined): string | null {
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

function sanitizeExtractedText(
  value: string | null,
  kind: CursorTranscriptRecordKind
): string | null {
  if (value === null) {
    return null;
  }

  const userQuery = extractTaggedSection(value, "user_query");

  if (kind === "user_message" && userQuery !== null) {
    return normalizeFreeformText(userQuery);
  }

  return normalizeFreeformText(value);
}

function extractTaggedSection(value: string, tagName: string): string | null {
  const pattern = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const match = value.match(pattern);
  return match?.[1]?.trim() || null;
}

function normalizeFreeformText(value: string): string | null {
  const stripped = value
    .replace(pluginInfoPattern, " ")
    .replace(attachedFilesPattern, " ")
    .replace(codeSelectionPattern, " ")
    .replace(xmlTagPattern, " ")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return stripped.length > 0 ? stripped : null;
}

function extractToolInputText(parsedLine: JsonRecord): string | null {
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

function extractTimestampHint(parsedLine: JsonRecord): string | null {
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

function extractFilePaths(
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

function extractCommandStrings(
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

function detectRedaction(parsedLine: JsonRecord): boolean {
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

function looksRedacted(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "[redacted]" || normalized === "<redacted>" || normalized === "redacted";
}

function pickFirstString(
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

function readValueAtPath(
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

function* iterateStrings(value: JsonValue): Generator<string> {
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

function collectFocusedStringSources(
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

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
