import type {
  ConfidenceLevel,
  Event,
  Learning,
  LearningKind,
  SourceRef,
  SourceSession,
  Turn
} from "../models/canonical.js";
import { learningSchema } from "../models/canonical.js";

export const defaultUserScopeKey = "operator";

export type ExtractLearningsInput = {
  events: readonly Event[];
  sourceSession: SourceSession;
  turns: readonly Turn[];
  userScopeKey?: string;
};

export type ExtractedLearnings = {
  project: Learning[];
  user: Learning[];
};

export function extractLearnings(input: ExtractLearningsInput): ExtractedLearnings {
  const project = dedupeLearnings(
    input.events.flatMap((event) => toProjectLearning(input.sourceSession, event) ?? [])
  );
  const user = dedupeLearnings(
    input.turns.flatMap((turn) =>
      extractUserPreferenceCandidates(turn.user_prompt).map((candidate, index) =>
        createLearning({
          confidence: candidate.confidence,
          evidence: [candidate.evidence],
          kind: candidate.kind,
          learningId: `${input.sourceSession.session_id}:user:${turn.index}:${index}`,
          promotionBasis: "Explicit user instruction captured in the source prompt.",
          scope: "user",
          scopeKey: input.userScopeKey ?? defaultUserScopeKey,
          sourceRef: createSourceRef(input.sourceSession, {
            turnId: turn.turn_id
          }),
          statement: candidate.statement,
          title: candidate.title
        })
      )
    )
  );

  return {
    project,
    user
  };
}

function toProjectLearning(sourceSession: SourceSession, event: Event): Learning | null {
  if (event.confidence === "low") {
    return null;
  }

  switch (event.type) {
    case "decision":
      return createLearning({
        confidence: event.confidence,
        evidence: [event.summary],
        kind: "decision",
        learningId: `${sourceSession.session_id}:project:decision:${event.event_id}`,
        promotionBasis: "Derived from an explicit implementation decision in the reduced event stream.",
        scope: "project",
        scopeKey: sourceSession.project_key,
        sourceRef: createSourceRef(sourceSession, {
          eventId: event.event_id,
          line: event.source_offsets.start_line,
          turnId: event.turn_id
        }),
        statement: event.summary,
        title: `Decision: ${truncateInline(event.summary, 72)}`
      });
    case "failure":
      return createLearning({
        confidence: event.confidence,
        evidence: [event.summary],
        kind: "failure_mode",
        learningId: `${sourceSession.session_id}:project:failure:${event.event_id}`,
        promotionBasis: "Derived from a concrete failure event in the reduced transcript.",
        scope: "project",
        scopeKey: sourceSession.project_key,
        sourceRef: createSourceRef(sourceSession, {
          eventId: event.event_id,
          line: event.source_offsets.start_line,
          turnId: event.turn_id
        }),
        statement: event.summary,
        title: `Failure mode: ${truncateInline(event.summary, 68)}`
      });
    case "verification": {
      const verificationCommand = readPayloadString(event, "verification_command");

      if (verificationCommand === null) {
        return null;
      }

      const statement = `Run ${verificationCommand} when verifying changes in ${sourceSession.project_key}.`;
      return createLearning({
        confidence: event.confidence,
        evidence: [event.summary],
        kind: "verification_rule",
        learningId: `${sourceSession.session_id}:project:verification:${event.event_id}`,
        promotionBasis: "Derived from an explicit verification command captured in the transcript.",
        scope: "project",
        scopeKey: sourceSession.project_key,
        sourceRef: createSourceRef(sourceSession, {
          eventId: event.event_id,
          line: event.source_offsets.start_line,
          turnId: event.turn_id
        }),
        statement,
        title: `Verification: ${verificationCommand}`
      });
    }
    default:
      return null;
  }
}

function extractUserPreferenceCandidates(prompt: string): Array<{
  confidence: ConfidenceLevel;
  evidence: string;
  kind: LearningKind;
  statement: string;
  title: string;
}> {
  const candidates: Array<{
    confidence: ConfidenceLevel;
    evidence: string;
    kind: LearningKind;
    statement: string;
    title: string;
  }> = [];

  for (const line of splitPromptLines(prompt)) {
    if (/final response format/i.test(line)) {
      candidates.push({
        confidence: "high",
        evidence: line,
        kind: "workflow",
        statement: "Honor explicit final response formatting instructions when they are provided.",
        title: "Explicit final response formatting"
      });
      continue;
    }

    if (/do not revert edits made by others/i.test(line)) {
      candidates.push({
        confidence: "high",
        evidence: line,
        kind: "workflow",
        statement: "Do not revert concurrent edits made by others; adapt to the current workspace state.",
        title: "Preserve concurrent edits"
      });
      continue;
    }

    if (/\bprefer\b/i.test(line) || /\balways\b/i.test(line) || /\bnever\b/i.test(line)) {
      candidates.push({
        confidence: "high",
        evidence: line,
        kind: "preference",
        statement: line,
        title: truncateInline(line, 72)
      });
      continue;
    }

    if (/keep .* focused/i.test(line)) {
      candidates.push({
        confidence: "medium",
        evidence: line,
        kind: "workflow",
        statement: line,
        title: truncateInline(line, 72)
      });
    }
  }

  return candidates;
}

function splitPromptLines(prompt: string): string[] {
  return prompt
    .split(/\r?\n+/)
    .map((line) => line.replace(/^[\s\-*]+/, "").trim())
    .filter((line) => line.length > 0);
}

function readPayloadString(event: Event, key: string): string | null {
  const value = event.payload_small[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function createLearning(input: {
  confidence: ConfidenceLevel;
  evidence: string[];
  kind: LearningKind;
  learningId: string;
  promotionBasis: string;
  scope: Learning["scope"];
  scopeKey: string;
  sourceRef: SourceRef;
  statement: string;
  title: string;
}): Learning {
  return learningSchema.parse({
    confidence: input.confidence,
    evidence: input.evidence,
    kind: input.kind,
    learning_id: input.learningId,
    promotion_basis: input.promotionBasis,
    scope: input.scope,
    scope_key: input.scopeKey,
    source_refs: [input.sourceRef],
    statement: input.statement,
    title: input.title
  } satisfies Learning);
}

function createSourceRef(
  sourceSession: SourceSession,
  options: {
    eventId?: string;
    line?: number | null;
    turnId?: string;
  }
): SourceRef {
  return {
    event_id: options.eventId ?? null,
    line: options.line ?? null,
    session_id: sourceSession.session_id,
    source_hash: sourceSession.source_hash,
    source_path: sourceSession.source_path,
    turn_id: options.turnId ?? null
  };
}

function dedupeLearnings(learnings: readonly Learning[]): Learning[] {
  const seen = new Set<string>();
  const uniqueLearnings: Learning[] = [];

  for (const learning of learnings) {
    const dedupeKey = `${learning.scope}:${learning.kind}:${learning.statement.toLowerCase()}`;
    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    uniqueLearnings.push(learning);
  }

  return uniqueLearnings;
}

function truncateInline(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}
