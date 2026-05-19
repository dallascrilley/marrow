import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

import type { JsonValue } from "../../models/canonical.js";
import { parseJsonLine, type JsonRecord } from "../_common/jsonl.js";
import type {
  TranscriptRecord,
  TranscriptRecordKind
} from "../_common/intermediate.js";
import {
  detectRedaction,
  extractCommandStrings,
  extractFilePaths,
  extractNormalizedText,
  extractToolInputText,
  looksRedacted,
  pickFirstString,
  readValueAtPath,
  uniquePreservingOrder
} from "../_common/text-extract.js";
import type {
  ParsePiTranscriptOptions,
  ParsePiTranscriptResult,
  PiSessionMeta,
  PiTranscriptRecord
} from "./intermediate.js";

/**
 * Parse a Pi (Zosma) session JSONL file into `TranscriptRecord` rows.
 * Streams the file line by line so multi-megabyte sessions stay within
 * bounded memory.
 *
 * Pi's classifier is **role-nested**: `message` records carry an inner
 * `message.role` ∈ {`user`, `assistant`, `toolResult`} that determines the
 * intermediate kind. Everything else (`session`, `model_change`,
 * `thinking_level_change`, `custom`, `custom_message`, unknown types)
 * becomes `event`. Tool calls live inside assistant `message.content[]` as
 * `toolCall` blocks and are NOT promoted to separate `tool_use_stub`
 * records in phase 1 (see docs/research/pi-source-strategy.md).
 */
export async function parsePiTranscript(
  options: ParsePiTranscriptOptions
): Promise<ParsePiTranscriptResult> {
  const records: PiTranscriptRecord[] = [];
  const stream = createReadStream(options.sourcePath, { encoding: "utf8" });
  const lines = createInterface({ crlfDelay: Infinity, input: stream });

  let lineNumber = 0;
  let sessionMeta: PiSessionMeta | null = null;

  try {
    for await (const line of lines) {
      lineNumber += 1;

      if (line.trim().length === 0) continue;

      const parsedLine = parsePiSessionLine(line, options.sourcePath, lineNumber);
      const normalizedRecord = normalizeTranscriptRecord(parsedLine, {
        lineNumber,
        sourceHash: options.sourceHash,
        sourcePath: options.sourcePath
      });

      records.push(normalizedRecord);

      if (sessionMeta === null && parsedLine.type === "session") {
        sessionMeta = extractSessionMeta(parsedLine);
      }
    }
  } finally {
    lines.close();
    stream.close();
  }

  return { records, sessionMeta };
}

type RecordContext = {
  lineNumber: number;
  sourceHash: string;
  sourcePath: string;
};

function parsePiSessionLine(line: string, sourcePath: string, lineNumber: number): JsonRecord {
  return parseJsonLine(line, sourcePath, lineNumber, "Pi session JSONL");
}

function normalizeTranscriptRecord(
  parsedLine: JsonRecord,
  context: RecordContext
): TranscriptRecord {
  const topType = pickFirstString(parsedLine, [["type"]]);
  const messageObject = readValueAtPath(parsedLine, ["message"]);
  const role =
    messageObject && typeof messageObject === "object" && !Array.isArray(messageObject)
      ? pickFirstString(messageObject as JsonRecord, [["role"]])
      : null;

  const rawType = composeRawType(topType, role);
  const kind = classifyRecordKind(topType, role);
  const contentRedacted = detectRedaction(parsedLine);
  const messageText = contentRedacted ? null : extractMessageText(parsedLine, kind, messageObject);
  const toolInputText =
    kind === "tool_use_stub" || kind === "tool_result_stub"
      ? extractPiToolInputText(messageObject)
      : null;
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
    timestampHint: pickFirstString(parsedLine, [["timestamp"]]),
    toolUse:
      kind === "tool_use_stub" || kind === "tool_result_stub"
        ? {
            callId:
              messageObject && typeof messageObject === "object" && !Array.isArray(messageObject)
                ? pickFirstString(messageObject as JsonRecord, [["toolCallId"], ["id"]])
                : null,
            inputText: toolInputText,
            name:
              messageObject && typeof messageObject === "object" && !Array.isArray(messageObject)
                ? pickFirstString(messageObject as JsonRecord, [["toolName"], ["name"]])
                : null,
            status:
              messageObject && typeof messageObject === "object" && !Array.isArray(messageObject)
                ? pickFirstString(messageObject as JsonRecord, [["status"], ["state"]])
                : null
          }
        : null
  };
}

/**
 * Compose `rawType` as `message/<role>` for message records; otherwise just
 * the top-level type. Keeps a single-string discriminator the reducer can
 * inspect without re-reading `rawEvent`.
 */
function composeRawType(topType: string | null, role: string | null): string | null {
  if (!topType) return null;
  if (topType === "message" && role) return `message/${role}`;
  return topType;
}

function classifyRecordKind(topType: string | null, role: string | null): TranscriptRecordKind {
  if (topType !== "message") return "event";

  if (role === "user") return "user_message";
  if (role === "assistant") return "assistant_message";
  if (role === "toolResult") return "tool_result_stub";

  return "event";
}

/**
 * Extract the prose body for a Pi record. For message records the body
 * lives at `message.content` as an array of typed blocks (`text`,
 * `toolCall`, `thinking`); the generic `extractNormalizedText` recursively
 * unwraps them and pulls `text` fields. For non-message records (session,
 * custom_message, etc.) prefer top-level text-shaped fields.
 */
function extractMessageText(
  parsedLine: JsonRecord,
  kind: TranscriptRecordKind,
  messageObject: JsonValue | undefined
): string | null {
  if (kind === "user_message" || kind === "assistant_message" || kind === "tool_result_stub") {
    if (!messageObject || typeof messageObject !== "object" || Array.isArray(messageObject)) {
      return null;
    }
    const messageRecord = messageObject as JsonRecord;

    for (const path of [["content"], ["text"]] satisfies ReadonlyArray<ReadonlyArray<string>>) {
      const candidate = readValueAtPath(messageRecord, path);
      const normalized = extractNormalizedText(candidate);
      if (normalized !== null && !looksRedacted(normalized)) {
        return normalized;
      }
    }
    return null;
  }

  for (const path of [["content"], ["text"], ["message"]] satisfies ReadonlyArray<ReadonlyArray<string>>) {
    const candidate = readValueAtPath(parsedLine, path);
    const normalized = extractNormalizedText(candidate);
    if (normalized !== null && !looksRedacted(normalized)) {
      return normalized;
    }
  }
  return null;
}

/**
 * Pi tool_result records carry the result text inside `message.content[]`
 * as `text` blocks. Reuse the generic `extractToolInputText` over the
 * message object first (covers `arguments.command` / `input` / etc.), then
 * fall back to the content-array text.
 */
function extractPiToolInputText(messageObject: JsonValue | undefined): string | null {
  if (!messageObject || typeof messageObject !== "object" || Array.isArray(messageObject)) {
    return null;
  }
  const messageRecord = messageObject as JsonRecord;
  const inputCandidate = extractToolInputText(messageRecord);
  if (inputCandidate !== null) return inputCandidate;

  const contentText = extractNormalizedText(readValueAtPath(messageRecord, ["content"]));
  return contentText?.trim() || null;
}

function extractSessionMeta(parsedLine: JsonRecord): PiSessionMeta | null {
  const versionValue = readValueAtPath(parsedLine, ["version"]);
  return {
    cwd: pickFirstString(parsedLine, [["cwd"]]),
    id: pickFirstString(parsedLine, [["id"]]),
    timestamp: pickFirstString(parsedLine, [["timestamp"]]),
    version: typeof versionValue === "number" ? versionValue : null
  };
}
