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
  CodexCliSessionMeta,
  CodexCliTranscriptRecord,
  ParseCodexCliTranscriptOptions,
  ParseCodexCliTranscriptResult,
} from "./intermediate.js";

/**
 * Parse a Codex CLI rollout JSONL file into `TranscriptRecord` rows. Streams
 * the file line by line so multi-megabyte rollouts stay within bounded
 * memory.
 *
 * The classifier joins the top-level `type` and inner `payload.type` keys
 * to build the composite classifier table documented in
 * docs/research/codex-cli-source-strategy.md. The `session_meta` line is
 * also lifted into a `sessionMeta` sidecar on the result so the workspace
 * mapper does not need to re-read the file.
 */
export async function parseCodexCliTranscript(
  options: ParseCodexCliTranscriptOptions,
): Promise<ParseCodexCliTranscriptResult> {
  const records: CodexCliTranscriptRecord[] = [];
  const stream = createReadStream(options.sourcePath, { encoding: "utf8" });
  const lines = createInterface({ crlfDelay: Infinity, input: stream });

  let lineNumber = 0;
  let sessionMeta: CodexCliSessionMeta | null = null;

  try {
    for await (const line of lines) {
      lineNumber += 1;

      if (line.trim().length === 0) continue;

      const parsedLine = parseCodexCliRolloutLine(line, options.sourcePath, lineNumber);
      const normalizedRecord = normalizeTranscriptRecord(parsedLine, {
        lineNumber,
        sourceHash: options.sourceHash,
        sourcePath: options.sourcePath,
      });

      records.push(normalizedRecord);

      if (sessionMeta === null && parsedLine.type === "session_meta") {
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

function parseCodexCliRolloutLine(
  line: string,
  sourcePath: string,
  lineNumber: number,
): JsonRecord {
  return parseJsonLine(line, sourcePath, lineNumber, "Codex CLI rollout JSONL");
}

function normalizeTranscriptRecord(
  parsedLine: JsonRecord,
  context: RecordContext,
): TranscriptRecord {
  const topType = pickFirstString(parsedLine, [["type"]]);
  const payload = readValueAtPath(parsedLine, ["payload"]);
  const payloadType =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? pickFirstString(payload as JsonRecord, [["type"]])
      : null;
  const role =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? pickFirstString(payload as JsonRecord, [["role"]])
      : null;

  const rawType = composeRawType(topType, payloadType);
  const kind = classifyRecordKind(topType, payloadType, role);
  const contentRedacted = detectRedaction(parsedLine);
  const messageText = contentRedacted ? null : extractMessageText(parsedLine, kind, payload);
  const toolInputText =
    kind === "tool_use_stub" || kind === "tool_result_stub"
      ? extractCodexToolInputText(parsedLine, payload)
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
    timestampHint: pickFirstString(parsedLine, [["timestamp"]]),
    toolUse:
      kind === "tool_use_stub" || kind === "tool_result_stub"
        ? {
            callId:
              payload && typeof payload === "object" && !Array.isArray(payload)
                ? pickFirstString(payload as JsonRecord, [["call_id"], ["id"]])
                : null,
            inputText: toolInputText,
            name:
              payload && typeof payload === "object" && !Array.isArray(payload)
                ? pickFirstString(payload as JsonRecord, [["name"]])
                : null,
            status:
              payload && typeof payload === "object" && !Array.isArray(payload)
                ? pickFirstString(payload as JsonRecord, [["status"], ["state"]])
                : null,
          }
        : null,
  };
}

/**
 * Compose `rawType` as `<top>/<payload>` when both are present, otherwise
 * just the top-level type. Keeps the same diagnostic value the other
 * adapters' single `type` field carries.
 */
function composeRawType(topType: string | null, payloadType: string | null): string | null {
  if (!topType) return null;
  return payloadType ? `${topType}/${payloadType}` : topType;
}

function classifyRecordKind(
  topType: string | null,
  payloadType: string | null,
  role: string | null,
): TranscriptRecordKind {
  if (topType === "response_item" && payloadType === "message") {
    if (role === "user") return "user_message";
    if (role === "assistant") return "assistant_message";
    return "event";
  }

  if (topType === "response_item" && payloadType === "function_call") {
    return "tool_use_stub";
  }

  if (topType === "response_item" && payloadType === "function_call_output") {
    return "tool_result_stub";
  }

  return "event";
}

/**
 * Extract the prose body for a Codex record. For `response_item/message`
 * records the body lives at `payload.content` as an array of typed blocks
 * (`input_text`, `output_text`, ...); the generic `extractNormalizedText`
 * recursively unwraps them. For everything else, prefer payload-level text
 * fields where they exist (e.g. `event_msg/agent_message` carries
 * `payload.message`).
 */
function extractMessageText(
  parsedLine: JsonRecord,
  kind: TranscriptRecordKind,
  payload: JsonValue | undefined,
): string | null {
  const isPayloadRecord = payload && typeof payload === "object" && !Array.isArray(payload);
  if (!isPayloadRecord) {
    return null;
  }
  const payloadRecord = payload as JsonRecord;

  const candidates =
    kind === "user_message" || kind === "assistant_message"
      ? [["content"], ["message"], ["text"]]
      : [["message"], ["text"], ["content"], ["summary"]];

  for (const path of candidates) {
    const candidate = readValueAtPath(payloadRecord, path);
    const normalized = extractNormalizedText(candidate);

    if (normalized !== null && !looksRedacted(normalized)) {
      return normalized;
    }
  }

  return null;
}

/**
 * Codex function calls store the call's arguments at `payload.arguments`
 * (often a JSON-stringified shell command or file path) and tool outputs at
 * `payload.output`. Reuse the generic `extractToolInputText` over the
 * payload object, then fall back to `payload.output` for result records.
 */
function extractCodexToolInputText(
  parsedLine: JsonRecord,
  payload: JsonValue | undefined,
): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const payloadRecord = payload as JsonRecord;
  const inputCandidate = extractToolInputText(payloadRecord);
  if (inputCandidate !== null) {
    return inputCandidate;
  }
  const output = pickFirstString(payloadRecord, [["output"]]);
  return output?.trim() || null;
}

function extractSessionMeta(parsedLine: JsonRecord): CodexCliSessionMeta | null {
  const payload = readValueAtPath(parsedLine, ["payload"]);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const payloadRecord = payload as JsonRecord;
  const subagent = readValueAtPath(payloadRecord, ["source", "subagent"]);
  const subagentRecord =
    subagent && typeof subagent === "object" && !Array.isArray(subagent)
      ? (subagent as JsonRecord)
      : null;
  const depth = subagentRecord?.depth;

  return {
    cliVersion: pickFirstString(payloadRecord, [["cli_version"]]),
    cwd: pickFirstString(payloadRecord, [["cwd"]]),
    id: pickFirstString(payloadRecord, [["id"]]),
    originator: pickFirstString(payloadRecord, [["originator"]]),
    parentThreadId: subagentRecord ? pickFirstString(subagentRecord, [["parent_thread_id"]]) : null,
    agentNickname: subagentRecord ? pickFirstString(subagentRecord, [["agent_nickname"]]) : null,
    agentRole: subagentRecord ? pickFirstString(subagentRecord, [["agent_role"]]) : null,
    subagentDepth: typeof depth === "number" ? depth : null,
    timestamp: pickFirstString(payloadRecord, [["timestamp"]]),
  };
}
