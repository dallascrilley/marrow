import type { Event, EventType } from "../models/canonical.js";
import { hasExcessiveMarkdownStructure } from "../pipeline/extract/raw-dump-predicates.js";
import { pruneTranscriptPayload } from "./payload-pruning.js";
import type { GroupedTurn } from "./turn-grouping.js";

const decisionPatterns = [
  /\bdecided to\b/i,
  /\bchose to\b/i,
  /\bgoing with\b/i,
  /\bopted to\b/i,
  /\bkept\b.+\bfor now\b/i,
  /\brecommend(?:ed|ation)?\b/i,
  /\bbest (?:default|choice|option|approach)\b/i,
  /\btop (?:pick|choice|recommendation|candidate)\b/i,
  /\b(?:winner|preferred|favored)\b/i,
  /\b(?:chose|selected|picked)\b.+\bover\b/i,
  /\bgo with\b/i,
  /\b(?:should use|prefer)\b.+\bfor\b/i,
  /\barchitecture decision\b/i,
  /\bwe (?:will|should|could) use\b/i,
  /\bthe approach (?:is|will be)\b/i,
  /\b(?:v\d|version \d).+\b(?:epic|roadmap|milestone|plan)\b/i,
  /\b(?:create|write|draft|produce)\b.+\bspec(?:ification)?\b/i,
  /\b(?:design|approach).+\bfor\b.+\bis\b/i,
  /\bconclusion:?\b/i,
  /\b(?:verdict|outcome|result).+\b(?:is|was)\b/i,
  /\b(?:ranking|comparison|versus|vs\.?)\b/i,
] as const;

const failurePatterns = [
  /\bfailed\b/i,
  /\berror\b.+(?:\b(?:occurred|thrown|returned|found|detected|encountered|prevented|stopped|blocked|caused|in)\b|:\s*\w+)/i,
  /\b(?:fatal|critical|uncaught)\s+error\b/i,
  /\bexception\b/i,
  /\btimed out\b/i,
  /\bunable to\b/i,
  /\bno such\b/i,
  /\benoent\b/i,
  /\beacces\b/i,
] as const;

const fixPatterns = [
  /\bfixed\b/i,
  /\bresolved\b/i,
  /\bpatched\b/i,
  /\bcorrected\b/i,
  /\bupdated\b.+\bto (?:fix|handle|avoid)\b/i,
  /\bchanged\b.+\bto (?:fix|handle|avoid)\b/i,
  /\broot cause was\b/i,
] as const;

const nextStepPatterns = [
  /\bnext step\b/i,
  /\bnext i(?:'|’)ll\b/i,
  /\bstill need to\b/i,
  /\bremaining (?:work|task|issue|step|item)s?\b/i,
  /\bleft to do\b/i,
  /\bfollow-?up (?:needed|required|is|will|task|item|step)s?\b/i,
] as const;

const verificationCommandPattern =
  // The `just` alternative requires a verification-word PREFIX so unrelated
  // recipes containing the letters mid-word ("just decide", "just recipe") do
  // not tag as verification and suppress failure learnings.
  /^(?:\.\/[\w./-]+|npm(?: run)? build|npm test|pnpm(?: run)? build|pnpm test|yarn build|yarn test|bun test|cargo test|go test|python(?:3)? -m pytest|uv run pytest|just (?:test|check|build|lint|ci|qa|verify)[\w-]*|script\/(?:test|cibuild)\b|qa)\b/i;
const verificationTextPatterns = [
  /\bverified\b/i,
  /\bconfirmed\b/i,
  /\btests? pass(?:ed)?\b/i,
  /\bbuild succeeded\b/i,
  /\ball checks passed\b/i,
] as const;
const noisyWrapperPatterns = [
  /<attached_files>/i,
  /<code_selection\b/i,
  /<plugin_info\b/i,
  /<question-form\b/i,
  /<answer-form\b/i,
] as const;

export function tagTurnEvents(turns: GroupedTurn[]): Event[] {
  const events: Event[] = [];
  const seen = new Set<string>();

  for (const turn of turns) {
    for (const record of turn.records) {
      const text = extractRecordText(record);

      if (text !== null) {
        maybePushEvent(
          events,
          seen,
          createPatternEvent(turn, record, text, "failure", failurePatterns),
        );
        maybePushEvent(events, seen, createPatternEvent(turn, record, text, "fix", fixPatterns));
        maybePushEvent(
          events,
          seen,
          createPatternEvent(turn, record, text, "decision", decisionPatterns),
        );
        maybePushEvent(
          events,
          seen,
          createPatternEvent(turn, record, text, "next_step", nextStepPatterns),
        );
        maybePushEvent(
          events,
          seen,
          createPatternEvent(turn, record, text, "verification", verificationTextPatterns, {
            confidence: "medium",
            summaryPrefix: "Verification noted: ",
          }),
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
              verification_command: verificationCommand,
            },
          }),
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
  },
): Event | null {
  const matchedPattern = patterns.find((pattern) => pattern.test(text));

  if (matchedPattern === undefined) {
    return null;
  }

  if (noisyWrapperPatterns.some((pattern) => pattern.test(text))) {
    return null;
  }

  if (
    (type === "decision" || type === "fix" || type === "next_step" || type === "verification") &&
    record.kind !== "assistant_message"
  ) {
    return null;
  }

  if (type === "next_step" && looksLikeCompletedOutcome(text)) {
    return null;
  }

  if (
    type === "failure" &&
    record.kind !== "assistant_message" &&
    record.kind !== "tool_result_stub" &&
    record.kind !== "tool_use_stub"
  ) {
    return null;
  }

  // Fix events on markdown-heavy "Summary of changes" messages keep the head
  // excerpt: the learning compressor (compressMarkdownHeavySummary) parses the
  // top of the summary for file + action clauses, and centering on the marker
  // starves it. Everything else centers on the matched marker so the excerpt
  // always contains the signal it was tagged for.
  const excerpt =
    type === "fix" && hasExcessiveMarkdownStructure(text)
      ? headExcerpt(text, 240)
      : excerptAroundMatch(text, matchedPattern, 240);

  return createEvent({
    turn,
    record,
    summary: `${options?.summaryPrefix ?? ""}${excerpt}`,
    type,
    ...(options?.confidence === undefined ? {} : { confidence: options.confidence }),
    payloadPatch: {
      matched_rule: matchedPattern.source,
    },
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
      ...options.payloadPatch,
    },
    confidence: options.confidence ?? inferConfidence(options.type),
    source_offsets: {
      start_line: options.record.provenance.lineNumber,
      end_line: options.record.provenance.lineNumber,
    },
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

/**
 * Head truncation retained for markdown-heavy fix summaries: the value sits in
 * the leading file + action clauses, not around the matched marker.
 */
function headExcerpt(text: string, maxLength: number): string {
  const normalized = text
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}

/**
 * Builds an event excerpt centered on the matched marker instead of blindly
 * head-truncating the record. The window starts at the line containing the
 * marker (shifting right when the marker sits deep inside an overlong line) so
 * the marker is always visible in the excerpt; elided edges get "...".
 */
function excerptAroundMatch(text: string, pattern: RegExp, maxLength: number): string {
  const normalized = text
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  const matchIndex = pattern.exec(normalized)?.index ?? 0;
  const lineStart = normalized.lastIndexOf("\n", matchIndex) + 1;

  let start = lineStart;
  if (matchIndex - lineStart >= maxLength - 6) {
    start = matchIndex - Math.floor(maxLength / 3);
  }

  const needsPrefix = start > 0;
  const budget = maxLength - (needsPrefix ? 3 : 0);
  let end = Math.min(normalized.length, start + budget);
  const needsSuffix = end < normalized.length;
  if (needsSuffix) {
    end = Math.max(start, end - 3);
  }

  const body = normalized.slice(start, end).trim();
  return `${needsPrefix ? "..." : ""}${body}${needsSuffix ? "..." : ""}`;
}

function looksLikeCompletedOutcome(text: string): boolean {
  return (
    /\b(?:done|completed|implemented|fixed|resolved|merged|pushed)\b/i.test(text) &&
    /\b(?:verified|tests? pass(?:ed)?|all checks passed|0 failures)\b/i.test(text)
  );
}

function inferConfidence(type: Event["type"]): Event["confidence"] {
  if (type === "failure" || type === "verification") {
    return "high";
  }

  return "medium";
}
