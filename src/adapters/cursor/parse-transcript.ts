import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { type JsonRecord, parseJsonLine } from "../_common/jsonl.js";
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
  uniquePreservingOrder,
} from "../_common/text-extract.js";
import type {
  CursorTranscriptRecord,
  CursorTranscriptRecordKind,
  ParseCursorTranscriptOptions,
  ParseCursorTranscriptResult,
} from "./intermediate.js";

const attachedFilesPattern = /<attached_files>[\s\S]*?<\/attached_files>/gi;
const codeSelectionPattern = /<code_selection\b[^>]*>[\s\S]*?<\/code_selection>/gi;
const pluginInfoPattern = /<plugin_info\b[^>]*>[\s\S]*?<\/plugin_info>/gi;
const xmlTagPattern = /<\/?[a-z_:-]+(?:\s+[^>]*)?>/gi;

export async function parseCursorTranscript(
  options: ParseCursorTranscriptOptions,
): Promise<ParseCursorTranscriptResult> {
  const records: CursorTranscriptRecord[] = [];
  const stream = createReadStream(options.sourcePath, { encoding: "utf8" });
  const lines = createInterface({
    crlfDelay: Infinity,
    input: stream,
  });

  let lineNumber = 0;

  try {
    for await (const line of lines) {
      lineNumber += 1;

      if (line.trim().length === 0) {
        continue;
      }

      const parsedLine = parseCursorTranscriptLine(line, options.sourcePath, lineNumber);
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

function parseCursorTranscriptLine(
  line: string,
  sourcePath: string,
  lineNumber: number,
): JsonRecord {
  return parseJsonLine(line, sourcePath, lineNumber, "Cursor transcript JSONL");
}

function normalizeTranscriptRecord(
  parsedLine: JsonRecord,
  context: RecordContext,
): CursorTranscriptRecord {
  const rawType = pickFirstString(parsedLine, [
    ["type"],
    ["role"],
    ["kind"],
    ["eventType"],
    ["event", "type"],
  ]);
  const kind = classifyRecordKind(rawType);
  const contentRedacted = detectRedaction(parsedLine);
  const messageText = contentRedacted ? null : extractMessageText(parsedLine, kind);
  const toolInputText =
    kind === "tool_use_stub" || kind === "tool_result_stub"
      ? extractToolInputText(parsedLine)
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
            callId: pickFirstString(parsedLine, [["id"], ["callId"], ["toolCallId"]]),
            inputText: toolInputText,
            name: pickFirstString(parsedLine, [["name"], ["toolName"], ["tool", "name"]]),
            status: pickFirstString(parsedLine, [["status"], ["state"], ["tool", "status"]]),
          }
        : null,
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
  kind: CursorTranscriptRecordKind,
): string | null {
  const candidates =
    kind === "user_message" || kind === "assistant_message"
      ? [["text"], ["message", "content"], ["message", "text"], ["content"], ["body"], ["prompt"]]
      : [["summary"], ["message"], ["text"], ["content"]];

  for (const path of candidates) {
    const candidate = readValueAtPath(parsedLine, path);
    const normalized = sanitizeExtractedText(extractNormalizedText(candidate), kind);

    if (normalized !== null && !looksRedacted(normalized)) {
      return normalized;
    }
  }

  return null;
}

function sanitizeExtractedText(
  value: string | null,
  kind: CursorTranscriptRecordKind,
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
