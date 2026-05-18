import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

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
  extractTimestampHint,
  extractToolInputText,
  looksRedacted,
  pickFirstString,
  readValueAtPath,
  uniquePreservingOrder
} from "../_common/text-extract.js";
import type {
  ClaudeCodeTranscriptRecord,
  ParseClaudeCodeTranscriptOptions,
  ParseClaudeCodeTranscriptResult
} from "./intermediate.js";

/**
 * Parse a Claude Code transcript JSONL file into `TranscriptRecord` rows.
 * Streams the file line by line so multi-megabyte sessions stay within bounded
 * memory.
 *
 * The classifier maps Claude Code's `type` discriminator to the shared
 * `TranscriptRecordKind` enum:
 *
 * - `user` / `human` → `user_message`
 * - `assistant` → `assistant_message`
 * - `tool_use` / `function_call` → `tool_use_stub` (rare at top level; usually
 *   nested inside an assistant message's content array, which the generic
 *   `extractNormalizedText` flattens into `messageText`)
 * - `tool_result` / `result` → `tool_result_stub`
 * - Session-pointer records (`last-prompt`, `permission-mode`,
 *   `file-history-snapshot`, `ai-title`, `queue-operation`) → `event`
 * - `attachment` (the workspace anchor) → `event`
 * - `system`, `summary`, plus any unknown type → `event`
 */
export async function parseClaudeCodeTranscript(
  options: ParseClaudeCodeTranscriptOptions
): Promise<ParseClaudeCodeTranscriptResult> {
  const records: ClaudeCodeTranscriptRecord[] = [];
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

      const parsedLine = parseClaudeCodeTranscriptLine(line, options.sourcePath, lineNumber);
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

function parseClaudeCodeTranscriptLine(
  line: string,
  sourcePath: string,
  lineNumber: number
): JsonRecord {
  return parseJsonLine(line, sourcePath, lineNumber, "Claude Code transcript JSONL");
}

function normalizeTranscriptRecord(
  parsedLine: JsonRecord,
  context: RecordContext
): TranscriptRecord {
  const rawType = pickFirstString(parsedLine, [["type"], ["role"]]);
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
            callId: pickFirstString(parsedLine, [["id"], ["callId"], ["toolUseID"]]),
            inputText: toolInputText,
            name: pickFirstString(parsedLine, [["name"], ["toolName"]]),
            status: pickFirstString(parsedLine, [["status"], ["state"]])
          }
        : null
  };
}

function classifyRecordKind(rawType: string | null): TranscriptRecordKind {
  const normalized = rawType?.toLowerCase() ?? "";

  if (normalized === "user" || normalized === "human") {
    return "user_message";
  }

  if (normalized === "assistant") {
    return "assistant_message";
  }

  if (normalized.includes("tool_result") || normalized === "result") {
    return "tool_result_stub";
  }

  if (normalized.includes("tool_use") || normalized.includes("function_call")) {
    return "tool_use_stub";
  }

  return "event";
}

/**
 * Pull the prose body from a Claude Code record. For `user` messages the body
 * is typically `message.content` (a plain string). For `assistant` messages
 * the body is `message.content` (an array of typed blocks: `text`, `thinking`,
 * `tool_use`); the shared `extractNormalizedText` recursively unwraps the
 * array and pulls `text` fields, which is enough for the summarize phase.
 */
function extractMessageText(
  parsedLine: JsonRecord,
  kind: TranscriptRecordKind
): string | null {
  const candidates =
    kind === "user_message" || kind === "assistant_message"
      ? [
          ["message", "content"],
          ["message", "text"],
          ["content"],
          ["text"]
        ]
      : [
          ["summary"],
          ["message"],
          ["text"],
          ["content"]
        ];

  for (const path of candidates) {
    const candidate = readValueAtPath(parsedLine, path);
    const normalized = extractNormalizedText(candidate);

    if (normalized !== null && !looksRedacted(normalized)) {
      return normalized;
    }
  }

  return null;
}
