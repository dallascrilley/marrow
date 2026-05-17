import type { Event, EventType } from "../models/canonical.js";
import type { GroupedTurn } from "./turn-grouping.js";
import { pruneTranscriptPayload } from "./payload-pruning.js";

const decisionPatterns = [
  /\bdecided to\b/i,
  /\bchose to\b/i,
  /\bgoing with\b/i,
  /\bopted to\b/i,
  /\bkept\b.+\bfor now\b/i
] as const;

const failurePatterns = [
  /\bfailed\b/i,
  /\berror\b/i,
  /\bexception\b/i,
  /\btimed out\b/i,
  /\bunable to\b/i,
  /\bno such\b/i,
  /\benoent\b/i,
  /\beacces\b/i
] as const;

const fixPatterns = [
  /\bfixed\b/i,
  /\bresolved\b/i,
  /\bpatched\b/i,
  /\bcorrected\b/i,
  /\bupdated\b.+\bto (?:fix|handle|avoid)\b/i,
  /\bchanged\b.+\bto (?:fix|handle|avoid)\b/i,
  /\broot cause was\b/i
] as const;

const nextStepPatterns = [
  /\bnext step\b/i,
  /\bnext i(?:'|’)ll\b/i,
  /\bstill need to\b/i,
  /\bremaining\b/i,
  /\bleft to do\b/i,
  /\bfollow-?up\b/i
] as const;

const verificationCommandPattern =
  /^(?:npm(?: run)? build|npm test|pnpm(?: run)? build|pnpm test|yarn build|yarn test|bun test|cargo test|go test|python(?:3)? -m pytest|uv run pytest)\b/i;
const verificationTextPatterns = [
  /\bverified\b/i,
  /\bconfirmed\b/i,
  /\btests? pass(?:ed)?\b/i,
  /\bbuild succeeded\b/i,
  /\ball checks passed\b/i
] as const;

export function tagTurnEvents(turns: GroupedTurn[]): Event[] {
  const events: Event[] = [];
  const seen = new Set<string>();

  for (const turn of turns) {
    for (const record of turn.records) {
      const text = extractRecordText(record);

      if (text !== null) {
        maybePushEvent(events, seen, createPatternEvent(turn, record, text, "failure", failurePatterns));
        maybePushEvent(events, seen, createPatternEvent(turn, record, text, "fix", fixPatterns));
        maybePushEvent(events, seen, createPatternEvent(turn, record, text, "decision", decisionPatterns));
        maybePushEvent(events, seen, createPatternEvent(turn, record, text, "next_step", nextStepPatterns));
        maybePushEvent(
          events,
          seen,
          createPatternEvent(turn, record, text, "verification", verificationTextPatterns, {
            confidence: "medium",
            summaryPrefix: "Verification noted: "
          })
        );
      }

      const verificationCommand = extractVerificationCommand(record);
      if (verificationCommand !== null) {
        maybePushEvent(
          events,
          seen,
          createEvent({
            turn,
            record,
            summary: `Ran verification command: ${verificationCommand}`,
            type: "verification",
            payloadPatch: {
              matched_rule: "verification_command",
              verification_command: verificationCommand
            }
          })
        );
      }
    }
  }

  return events;
}

function maybePushEvent(events: Event[], seen: Set<string>, event: Event | null): void {
  if (event === null) {
    return;
  }

  const dedupeKey = `${event.turn_id}:${event.type}:${event.summary.toLowerCase()}`;

  if (seen.has(dedupeKey)) {
    return;
  }

  seen.add(dedupeKey);
  events.push(event);
}

function createPatternEvent(
  turn: GroupedTurn,
  record: GroupedTurn["records"][number],
  text: string,
  type: Extract<EventType, "decision" | "failure" | "fix" | "next_step" | "verification">,
  patterns: ReadonlyArray<RegExp>,
  options?: {
    confidence?: Event["confidence"];
    summaryPrefix?: string;
  }
): Event | null {
  const matchedPattern = patterns.find((pattern) => pattern.test(text));

  if (matchedPattern === undefined) {
    return null;
  }

  if (type === "decision" && record.kind !== "assistant_message") {
    return null;
  }

  if (type === "verification" && record.kind !== "assistant_message") {
    return null;
  }

  return createEvent({
    turn,
    record,
    summary: `${options?.summaryPrefix ?? ""}${summarizeText(text)}`,
    type,
    ...(options?.confidence === undefined ? {} : { confidence: options.confidence }),
    payloadPatch: {
      matched_rule: matchedPattern.source
    }
  });
}

function createEvent(options: {
  turn: GroupedTurn;
  record: GroupedTurn["records"][number];
  summary: string;
  type: Extract<EventType, "decision" | "failure" | "fix" | "next_step" | "verification">;
  payloadPatch: Record<string, string>;
  confidence?: Event["confidence"];
}): Event {
  const basePayload = pruneTranscriptPayload(options.record);

  return {
    event_id: `${options.turn.turnId}:${options.type}:${String(options.record.provenance.lineNumber).padStart(6, "0")}`,
    turn_id: options.turn.turnId,
    type: options.type,
    summary: options.summary,
    payload_small: {
      ...basePayload,
      ...options.payloadPatch
    },
    confidence: options.confidence ?? inferConfidence(options.type),
    source_offsets: {
      start_line: options.record.provenance.lineNumber,
      end_line: options.record.provenance.lineNumber
    }
  };
}

function extractRecordText(record: GroupedTurn["records"][number]): string | null {
  if (record.messageText !== null && record.messageText.trim().length > 0) {
    return record.messageText.trim();
  }

  return null;
}

function extractVerificationCommand(record: GroupedTurn["records"][number]): string | null {
  if (record.kind !== "tool_use_stub") {
    return null;
  }

  const candidate = record.toolUse?.inputText ?? record.commandStrings[0] ?? null;

  if (candidate === null) {
    return null;
  }

  const normalized = candidate.replace(/\s+/g, " ").trim();

  if (!verificationCommandPattern.test(normalized)) {
    return null;
  }

  return normalized;
}

function summarizeText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();

  if (normalized.length <= 160) {
    return normalized;
  }

  return `${normalized.slice(0, 157)}...`;
}

function inferConfidence(type: Event["type"]): Event["confidence"] {
  if (type === "failure" || type === "verification") {
    return "high";
  }

  return "medium";
}
