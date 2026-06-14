import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

import type { JsonValue } from "../../models/canonical.js";
import type { TranscriptRecord, TranscriptRecordKind } from "../_common/intermediate.js";
import { type JsonRecord, parseJsonLine } from "../_common/jsonl.js";
import {
  detectRedaction,
  extractCommandStrings,
  extractFilePaths,
  extractNormalizedText,
  extractToolInputText,
  looksRedacted,
  pickFirstString,
  readValueAtPath,
  uniquePreservingOrder,
} from "../_common/text-extract.js";
import type {
  KimiTranscriptRecord,
  ParseKimiTranscriptOptions,
  ParseKimiTranscriptResult,
} from "./intermediate.js";

/**
 * Parse a Kimi (Kimi Code CLI) wire.jsonl file into `TranscriptRecord` rows.
 * Streams the file line by line so multi-megabyte sessions stay within
 * bounded memory.
 *
 * Kimi's wire format is a JSONL where each line has:
 *   {"timestamp": <unix-epoch-float>, "message": {"type": <msg-type>, "payload": {...}}}
 *
 * The first line is metadata ("metadata" type) and is treated as an event.
 * Message types are mapped to intermediate kinds as follows:
 *   - TurnBegin      → user_message
 *   - ContentPart    → assistant_message
 *   - ToolCall       → tool_use_stub
 *   - ToolResult     → tool_result_stub
 *   - everything else → event
 */
export async function parseKimiTranscript(
  options: ParseKimiTranscriptOptions,
): Promise<ParseKimiTranscriptResult> {
  const records: KimiTranscriptRecord[] = [];
  const stream = createReadStream(options.sourcePath, { encoding: "utf8" });
  const lines = createInterface({ crlfDelay: Infinity, input: stream });

  let lineNumber = 0;

  try {
    for await (const line of lines) {
      lineNumber += 1;

      if (line.trim().length === 0) continue;

      const parsedLine = parseKimiWireLine(line, options.sourcePath, lineNumber);
      const normalizedRecord = normalizeTranscriptRecord(parsedLine, {
        lineNumber,
        sourceHash: options.sourceHash,
        sourcePath: options.sourcePath,
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

function parseKimiWireLine(line: string, sourcePath: string, lineNumber: number): JsonRecord {
  return parseJsonLine(line, sourcePath, lineNumber, "Kimi wire JSONL");
}

function normalizeTranscriptRecord(
  parsedLine: JsonRecord,
  context: RecordContext,
): TranscriptRecord {
  const messageObject = readValueAtPath(parsedLine, ["message"]);
  const msgType =
    messageObject && typeof messageObject === "object" && !Array.isArray(messageObject)
      ? pickFirstString(messageObject as JsonRecord, [["type"]])
      : null;

  const rawType = msgType;
  const kind = classifyRecordKind(msgType);
  const contentRedacted = detectRedaction(parsedLine);
  const messageText = contentRedacted ? null : extractMessageText(parsedLine, kind, messageObject);
  const toolInputText =
    kind === "tool_use_stub" || kind === "tool_result_stub"
      ? extractKimiToolInputText(messageObject)
      : null;
  const filePaths = uniquePreservingOrder(extractFilePaths(parsedLine, messageText, toolInputText));
  const commandStrings = uniquePreservingOrder(
    extractCommandStrings(parsedLine, messageText, toolInputText),
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
      sourcePath: context.sourcePath,
    },
    rawEvent: parsedLine,
    rawType,
    timestampHint: extractTimestampHint(parsedLine),
    toolUse:
      kind === "tool_use_stub" || kind === "tool_result_stub"
        ? {
            callId:
              messageObject && typeof messageObject === "object" && !Array.isArray(messageObject)
                ? pickFirstString(messageObject as JsonRecord, [
                    ["payload", "tool_call_id"],
                    ["payload", "id"],
                  ])
                : null,
            inputText: toolInputText,
            name:
              messageObject && typeof messageObject === "object" && !Array.isArray(messageObject)
                ? pickFirstString(messageObject as JsonRecord, [
                    ["payload", "function", "name"],
                    ["payload", "name"],
                  ])
                : null,
            status: null,
          }
        : null,
  };
}

function classifyRecordKind(msgType: string | null): TranscriptRecordKind {
  switch (msgType) {
    case "TurnBegin":
      return "user_message";
    case "ContentPart":
      return "assistant_message";
    case "ToolCall":
      return "tool_use_stub";
    case "ToolResult":
      return "tool_result_stub";
    default:
      return "event";
  }
}

function extractMessageText(
  parsedLine: JsonRecord,
  kind: TranscriptRecordKind,
  messageObject: JsonValue | undefined,
): string | null {
  if (kind === "user_message") {
    const payload = readValueAtPath(parsedLine, ["message", "payload"]);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return null;
    }
    const userInput = readValueAtPath(payload as JsonRecord, ["user_input"]);

    // user_input can be a plain string or an array of content parts
    if (typeof userInput === "string") {
      const normalized = extractNormalizedText(userInput);
      if (normalized !== null && !looksRedacted(normalized)) {
        return normalized;
      }
      return null;
    }

    if (Array.isArray(userInput)) {
      // Array of {type: "text", text: "..."} parts
      const texts: string[] = [];
      for (const part of userInput) {
        if (part && typeof part === "object" && !Array.isArray(part)) {
          const text = readValueAtPath(part as JsonRecord, ["text"]);
          if (typeof text === "string") {
            const normalized = extractNormalizedText(text);
            if (normalized !== null && !looksRedacted(normalized)) {
              texts.push(normalized);
            }
          }
        }
      }
      return texts.length > 0 ? texts.join("\n") : null;
    }

    return null;
  }

  if (kind === "assistant_message") {
    if (!messageObject || typeof messageObject !== "object" || Array.isArray(messageObject)) {
      return null;
    }
    const payload = readValueAtPath(messageObject as JsonRecord, ["payload"]);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return null;
    }

    // ContentPart payload: {type: "think" | "text", think?: string, text?: string}
    const contentType = pickFirstString(payload as JsonRecord, [["type"]]);
    if (contentType === "think") {
      const think = readValueAtPath(payload as JsonRecord, ["think"]);
      if (typeof think === "string") {
        const normalized = extractNormalizedText(think);
        if (normalized !== null && !looksRedacted(normalized)) {
          return normalized;
        }
      }
    }
    if (contentType === "text") {
      const text = readValueAtPath(payload as JsonRecord, ["text"]);
      if (typeof text === "string") {
        const normalized = extractNormalizedText(text);
        if (normalized !== null && !looksRedacted(normalized)) {
          return normalized;
        }
      }
    }
    // Fallback: any string field in the payload
    const normalized = extractNormalizedText(payload);
    if (normalized !== null && !looksRedacted(normalized)) {
      return normalized;
    }
    return null;
  }

  if (kind === "tool_result_stub") {
    if (!messageObject || typeof messageObject !== "object" || Array.isArray(messageObject)) {
      return null;
    }
    const payload = readValueAtPath(messageObject as JsonRecord, ["payload"]);
    const returnValue = readValueAtPath(payload as JsonRecord, ["return_value"]);
    if (returnValue && typeof returnValue === "object" && !Array.isArray(returnValue)) {
      const returnRecord = returnValue as JsonRecord;
      // Prefer command output over generic message
      const output = readValueAtPath(returnRecord, ["output"]);
      if (typeof output === "string" && output.trim().length > 0) {
        const normalized = extractNormalizedText(output);
        if (normalized !== null && !looksRedacted(normalized)) {
          return normalized;
        }
      }
      const message = readValueAtPath(returnRecord, ["message"]);
      if (typeof message === "string" && message.trim().length > 0) {
        const normalized = extractNormalizedText(message);
        if (normalized !== null && !looksRedacted(normalized)) {
          return normalized;
        }
      }
    }
    const normalized = extractNormalizedText(returnValue);
    if (normalized !== null && !looksRedacted(normalized)) {
      return normalized;
    }
    return null;
  }

  // For events, try generic text extraction
  const normalized = extractNormalizedText(readValueAtPath(parsedLine, ["message", "payload"]));
  if (normalized !== null && !looksRedacted(normalized)) {
    return normalized;
  }
  return null;
}

function extractKimiToolInputText(messageObject: JsonValue | undefined): string | null {
  if (!messageObject || typeof messageObject !== "object" || Array.isArray(messageObject)) {
    return null;
  }
  const messageRecord = messageObject as JsonRecord;

  // Kimi tool calls nest arguments inside payload.function.arguments as a JSON string
  const payload = readValueAtPath(messageRecord, ["payload"]);
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const functionObj = readValueAtPath(payload as JsonRecord, ["function"]);
    if (functionObj && typeof functionObj === "object" && !Array.isArray(functionObj)) {
      const argsString = readValueAtPath(functionObj as JsonRecord, ["arguments"]);
      if (typeof argsString === "string" && argsString.trim().length > 0) {
        try {
          const parsed = JSON.parse(argsString) as JsonRecord;
          const command = readValueAtPath(parsed, ["command"]);
          if (typeof command === "string" && command.trim().length > 0) {
            return command.trim();
          }
          const input = readValueAtPath(parsed, ["input"]);
          if (typeof input === "string" && input.trim().length > 0) {
            return input.trim();
          }
          const path = readValueAtPath(parsed, ["path"]);
          if (typeof path === "string" && path.trim().length > 0) {
            return path.trim();
          }
          // Fallback: use the whole parsed args as text
          const normalized = extractNormalizedText(parsed);
          if (normalized !== null && normalized.trim().length > 0) {
            return normalized.trim();
          }
        } catch {
          // Not valid JSON — treat the raw string as input text
          return argsString.trim();
        }
      }
    }
  }

  const inputCandidate = extractToolInputText(messageRecord);
  if (inputCandidate !== null) return inputCandidate;

  const normalized = extractNormalizedText(payload);
  return normalized?.trim() || null;
}

function extractTimestampHint(parsedLine: JsonRecord): string | null {
  const timestamp = readValueAtPath(parsedLine, ["timestamp"]);
  if (typeof timestamp === "number") {
    return new Date(timestamp * 1000).toISOString();
  }
  return pickFirstString(parsedLine, [["timestamp"]]);
}
