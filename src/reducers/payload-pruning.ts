import type { CursorTranscriptRecord } from "../adapters/cursor/intermediate.js";
import type { JsonValue } from "../models/canonical.js";

const MAX_COMMANDS = 6;
const MAX_FILE_PATHS = 6;
const MAX_STRING_LENGTH = 200;
const MAX_TOOL_INPUT_LENGTH = 160;
const MAX_TOP_LEVEL_KEYS = 8;

export function pruneTranscriptPayload(record: CursorTranscriptRecord): Record<string, JsonValue> {
  const rawRecord = asJsonRecord(record.rawEvent);
  const rawKeys = rawRecord === null ? [] : Object.keys(rawRecord).sort();
  const pruned: Record<string, JsonValue> = {
    content_redacted: record.contentRedacted,
    line_number: record.provenance.lineNumber,
    raw_kind: record.kind
  };

  if (record.rawType !== null) {
    pruned.raw_type = record.rawType;
  }

  if (record.timestampHint !== null) {
    pruned.timestamp_hint = record.timestampHint;
  }

  if (record.messageText !== null) {
    pruned.message_excerpt = truncateText(record.messageText, MAX_STRING_LENGTH);
  }

  if (record.filePaths.length > 0) {
    pruned.file_paths = record.filePaths.slice(0, MAX_FILE_PATHS);
  }

  if (record.commandStrings.length > 0) {
    pruned.command_strings = record.commandStrings
      .slice(0, MAX_COMMANDS)
      .map((command) => truncateText(command, MAX_STRING_LENGTH));
  }

  if (record.toolUse !== null) {
    pruned.tool_use = compactObject({
      call_id: record.toolUse.callId,
      input_excerpt:
        record.toolUse.inputText === null
          ? null
          : truncateText(record.toolUse.inputText, MAX_TOOL_INPUT_LENGTH),
      name: record.toolUse.name,
      status: record.toolUse.status
    });
  }

  pruned.raw_payload_stub = compactObject({
    approximate_bytes: estimateSerializedLength(record.rawEvent),
    has_nested_content: rawRecord === null ? false : rawKeys.some((key) => isNested(rawRecord[key])),
    key_count: rawKeys.length,
    kept_keys: rawKeys.slice(0, MAX_TOP_LEVEL_KEYS),
    omitted_key_count: Math.max(0, rawKeys.length - MAX_TOP_LEVEL_KEYS)
  });

  return pruned;
}

function compactObject(
  value: Record<string, JsonValue | undefined>
): Record<string, JsonValue> {
  const compacted: Record<string, JsonValue> = {};

  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) {
      continue;
    }

    compacted[key] = entry;
  }

  return compacted;
}

function truncateText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}

function estimateSerializedLength(value: JsonValue): number {
  return JSON.stringify(value).length;
}

function isNested(value: JsonValue | undefined): boolean {
  return Array.isArray(value) || asJsonRecord(value) !== null;
}

function asJsonRecord(value: JsonValue | undefined): Record<string, JsonValue> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, JsonValue>;
}
