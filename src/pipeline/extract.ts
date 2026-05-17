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

type ProjectLearningCandidate = {
  confidence: ConfidenceLevel;
  dedupeKey: string;
  evidence: string[];
  kind: LearningKind;
  learningId: string;
  promotionBasis: string;
  sourceRefs: SourceRef[];
  statement: string;
  title: string;
};

export function extractLearnings(input: ExtractLearningsInput): ExtractedLearnings {
  const project = dedupeLearnings(
    extractProjectLearningCandidates(input).map((candidate) =>
      createLearning({
        confidence: candidate.confidence,
        evidence: candidate.evidence,
        kind: candidate.kind,
        learningId: candidate.learningId,
        promotionBasis: candidate.promotionBasis,
        scope: "project",
        scopeKey: input.sourceSession.project_key,
        sourceRefs: candidate.sourceRefs,
        statement: candidate.statement,
        title: candidate.title
      })
    )
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
          sourceRefs: [createSourceRef(input.sourceSession, {
            turnId: turn.turn_id
          })],
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

function extractProjectLearningCandidates(input: ExtractLearningsInput): ProjectLearningCandidate[] {
  const eventCandidates = input.events.flatMap((event) => toProjectEventCandidate(input.sourceSession, event) ?? []);
  const turnCandidates = input.turns.flatMap((turn, index) =>
    toProjectTurnCandidates({
      events: input.events,
      index,
      sourceSession: input.sourceSession,
      turn
    })
  );
  return dedupeProjectCandidates([...eventCandidates, ...turnCandidates]);
}

function toProjectEventCandidate(sourceSession: SourceSession, event: Event): ProjectLearningCandidate | null {
  if (event.confidence === "low") {
    return null;
  }

  const completionStatement = toVerifiedCompletionStatement(event);
  if (completionStatement !== null) {
    return {
      confidence: event.confidence,
      evidence: [event.summary],
      kind: "workflow",
      dedupeKey: `completion:${completionStatement.toLowerCase()}`,
      learningId: `${sourceSession.session_id}:project:completion:${event.event_id}`,
      promotionBasis: "Derived from a verified completion outcome in the reduced transcript.",
      sourceRefs: [createSourceRef(sourceSession, {
        eventId: event.event_id,
        line: event.source_offsets.start_line,
        turnId: event.turn_id
      })],
      statement: completionStatement,
      title: `Verified completion: ${truncateInline(completionStatement, 60)}`
    };
  }

  switch (event.type) {
    case "decision":
      return {
        confidence: event.confidence,
        dedupeKey: `decision:${event.summary.toLowerCase()}`,
        evidence: [event.summary],
        kind: "decision",
        learningId: `${sourceSession.session_id}:project:decision:${event.event_id}`,
        promotionBasis: "Derived from an explicit implementation decision in the reduced event stream.",
        sourceRefs: [createSourceRef(sourceSession, {
          eventId: event.event_id,
          line: event.source_offsets.start_line,
          turnId: event.turn_id
        })],
        statement: event.summary,
        title: `Decision: ${truncateInline(event.summary, 72)}`
      };
    case "failure":
      return {
        confidence: event.confidence,
        dedupeKey: `failure:${event.summary.toLowerCase()}`,
        evidence: [event.summary],
        kind: "failure_mode",
        learningId: `${sourceSession.session_id}:project:failure:${event.event_id}`,
        promotionBasis: "Derived from a concrete failure event in the reduced transcript.",
        sourceRefs: [createSourceRef(sourceSession, {
          eventId: event.event_id,
          line: event.source_offsets.start_line,
          turnId: event.turn_id
        })],
        statement: event.summary,
        title: `Failure mode: ${truncateInline(event.summary, 68)}`
      };
    case "verification": {
      const verificationCommand = readPayloadString(event, "verification_command");

      if (verificationCommand === null) {
        return null;
      }

      const statement = `Run ${verificationCommand} when verifying changes in ${sourceSession.project_key}.`;
      return {
        confidence: event.confidence,
        dedupeKey: `verification:${statement.toLowerCase()}`,
        evidence: [event.summary],
        kind: "verification_rule",
        learningId: `${sourceSession.session_id}:project:verification:${event.event_id}`,
        promotionBasis: "Derived from an explicit verification command captured in the transcript.",
        sourceRefs: [createSourceRef(sourceSession, {
          eventId: event.event_id,
          line: event.source_offsets.start_line,
          turnId: event.turn_id
        })],
        statement,
        title: `Verification: ${verificationCommand}`
      };
    }
    default:
      return null;
  }
}

function toProjectTurnCandidates(input: {
  events: readonly Event[];
  index: number;
  sourceSession: SourceSession;
  turn: Turn;
}): ProjectLearningCandidate[] {
  const turnEvents = input.events.filter((event) => event.turn_id === input.turn.turn_id && event.confidence !== "low");
  const fixEvents = turnEvents.filter((event) => event.type === "fix");
  const verificationEvents = turnEvents.filter((event) => event.type === "verification" && isUsefulVerificationText(event.summary));
  const failureEvents = turnEvents.filter((event) => event.type === "failure" && isConcreteFailure(event.summary));
  const commands = usefulCommandsForTurn(input.turn, turnEvents);
  const files = usefulFilesForTurn(input.turn, turnEvents);
  const candidates: ProjectLearningCandidate[] = [];

  if (fixEvents.length > 0 && verificationEvents.length > 0) {
    const fix = fixEvents[0]!;
    const verification = verificationEvents[0]!;
    const command = commands[0] ?? commandFromEvent(verification);
    const statement = `Fixed ${lowercaseFirst(stripTrailingPunctuation(stripEventPrefix(fix.summary)))}; verified${command === undefined ? "" : ` with ${formatCommand(command)}`}.`;
    candidates.push({
      confidence: command === undefined ? "medium" : "high",
      dedupeKey: `verified-fix:${statement.toLowerCase()}`,
      evidence: uniqueStrings([fix.summary, verification.summary]),
      kind: "workflow",
      learningId: `${input.sourceSession.session_id}:project:verified-fix:${input.index}`,
      promotionBasis: "Derived from same-turn fix and verification evidence.",
      sourceRefs: sourceRefsForEvents(input.sourceSession, [fix, verification]),
      statement,
      title: `Verified fix: ${truncateInline(statement, 60)}`
    });
  }

  for (const failure of failureEvents) {
    const resolution = fixEvents[0] ?? verificationEvents[0];

    if (resolution === undefined) {
      continue;
    }

    const command = commands[0] ?? commandFromEvent(resolution);
    const statement = `Resolved ${stripTrailingPunctuation(stripEventPrefix(failure.summary))} by ${lowercaseFirst(stripTrailingPunctuation(stripEventPrefix(resolution.summary)))}.`;
    candidates.push({
      confidence: command === undefined ? "medium" : "high",
      dedupeKey: `error-resolution:${statement.toLowerCase()}`,
      evidence: uniqueStrings([failure.summary, resolution.summary]),
      kind: "failure_mode",
      learningId: `${input.sourceSession.session_id}:project:error-resolution:${input.index}`,
      promotionBasis: "Derived from concrete failure evidence followed by a fix or verification.",
      sourceRefs: sourceRefsForEvents(input.sourceSession, [failure, resolution]),
      statement,
      title: `Error resolution: ${truncateInline(statement, 60)}`
    });
  }

  const workflowCommand = selectWorkflowCommand(commands, input.turn.user_prompt);
  if (workflowCommand !== null) {
    const workflowTarget = classifyWorkflowTarget(input.turn.user_prompt);
    const statement = `Use ${formatCommand(workflowCommand)} for ${workflowTarget} in ${input.sourceSession.project_key}.`;
    candidates.push({
      confidence: "medium",
      dedupeKey: `workflow:${statement.toLowerCase()}`,
      evidence: [input.turn.user_prompt, workflowCommand],
      kind: "workflow",
      learningId: `${input.sourceSession.session_id}:project:workflow:${input.index}`,
      promotionBasis: "Derived from project-specific command usage in the reduced turn.",
      sourceRefs: [createSourceRef(input.sourceSession, {
        turnId: input.turn.turn_id
      })],
      statement,
      title: `Workflow: ${truncateInline(statement, 60)}`
    });
  }

  if (fixEvents.length > 0 && files.length > 0) {
    const fix = fixEvents[0]!;
    const file = files[0]!;
    const topic = selectTopic(input.turn.user_prompt);
    const fixSummary = stripTrailingPunctuation(stripEventPrefix(fix.summary));
    const statement = `Updated ${file} for ${topic}: ${lowercaseFirst(fixSummary)}.`;
    candidates.push({
      confidence: "medium",
      dedupeKey: `file-scoped:${statement.toLowerCase()}`,
      evidence: [fix.summary, file],
      kind: "pattern",
      learningId: `${input.sourceSession.session_id}:project:file-scoped:${input.index}`,
      promotionBasis: "Derived from a concrete file path and fix outcome in the same turn.",
      sourceRefs: sourceRefsForEvents(input.sourceSession, [fix]),
      statement,
      title: `File update: ${truncateInline(statement, 60)}`
    });
  }

  return candidates;
}

function toVerifiedCompletionStatement(event: Event): string | null {
  if (event.type !== "verification") {
    return null;
  }

  const stripped = stripEventPrefix(event.summary);
  const doneMatch = stripped.match(/\*\*Done:\*\*\s*(.*?)(?:\s+\*\*Verified:\*\*\s*|$)(.*)$/i);

  if (doneMatch === null) {
    return null;
  }

  const doneText = doneMatch[1]?.trim();
  const verifiedText = doneMatch[2]?.trim() ?? "";

  if (doneText === undefined || doneText.length === 0) {
    return null;
  }

  const command = extractCommandFromText(verifiedText) ?? readPayloadString(event, "verification_command");
  const verifiedClause = command === null ? "verified" : `verified with ${formatCommand(command)}`;

  return `Completed ${lowercaseFirst(stripTrailingPunctuation(doneText))}; ${verifiedClause}.`;
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

function readPayloadStringArray(event: Event, key: string): string[] {
  const value = event.payload_small[key];

  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function stripEventPrefix(value: string): string {
  return value.replace(/^Verification noted:\s*/i, "").trim();
}

function extractCommandFromText(value: string): string | null {
  for (const match of value.matchAll(/`([^`\n]+)`/g)) {
    const candidate = match[1]?.trim();

    if (
      candidate !== undefined &&
      /^(?:\.\/[\w./-]+|(?:npm|pnpm|yarn|bun|node|python3?|uv|git|just|make|cargo|go|docker|sqlite3)\b)/i.test(candidate)
    ) {
      return candidate;
    }
  }

  return null;
}

function commandFromEvent(event: Event): string | undefined {
  return readPayloadString(event, "verification_command") ?? usefulCommandsForEvent(event)[0];
}

function usefulCommandsForTurn(turn: Turn, events: readonly Event[]): string[] {
  return uniqueStrings([
    ...turn.commands_seen,
    ...events.flatMap((event) => usefulCommandsForEvent(event))
  ]);
}

function usefulCommandsForEvent(event: Event): string[] {
  return uniqueStrings([
    ...readPayloadStringArray(event, "command_strings"),
    ...extractCommandsFromText(event.summary)
  ]).filter(isUsefulCommand);
}

function extractCommandsFromText(value: string): string[] {
  const commands: string[] = [];

  for (const match of value.matchAll(/`([^`\n]+)`/g)) {
    const candidate = match[1]?.trim();

    if (candidate !== undefined) {
      commands.push(candidate);
    }
  }

  return commands;
}

function usefulFilesForTurn(turn: Turn, events: readonly Event[]): string[] {
  return uniqueStrings([
    ...turn.files_touched,
    ...events.flatMap((event) => readPayloadStringArray(event, "command_strings"))
  ])
    .map((value) => normalizeFilePath(value))
    .filter((value): value is string => value !== null);
}

function normalizeFilePath(value: string): string | null {
  const trimmed = value.trim().replace(/^`+|`+$/g, "");

  if (!/\.(?:[cm]?[jt]sx?|py|go|rs|swift|kt|java|c|cc|cpp|h|hpp|json|ya?ml|toml|md|sql)$/i.test(trimmed)) {
    return null;
  }

  if (/\/(?:\.codex\/worktrees|Code)\/[^/]+\/?$/.test(trimmed)) {
    return null;
  }

  const codeIndex = trimmed.indexOf("/Code/");
  if (codeIndex >= 0) {
    const afterCode = trimmed.slice(codeIndex + "/Code/".length);
    const [, ...rest] = afterCode.split("/");

    if (rest.length > 0) {
      return rest.join("/");
    }
  }

  return trimmed;
}

function isUsefulCommand(command: string): boolean {
  const normalized = command.trim().toLowerCase();

  if (["node", "python", "python3"].includes(normalized)) {
    return false;
  }

  return /^(?:\.\/[\w./-]+|(?:npm|pnpm|yarn|bun|node|python3?|uv|git|just|make|cargo|go|docker|sqlite3)\b)/i.test(command.trim());
}

function isUsefulVerificationText(value: string): boolean {
  if (/\b(?:can|will|could|should)\s+verify\b/i.test(value) || /\blet me verify\b/i.test(value)) {
    return false;
  }

  return /\b(?:verified|tests? pass(?:ed)?|all checks passed|0 failures|done|completed|implemented|replaced)\b/i.test(value);
}

function isConcreteFailure(value: string): boolean {
  return /\b(?:failed|error|exception|enoent|eacces|no such|cannot|could not|missing|unknown import|traceback)\b/i.test(value);
}

function selectWorkflowCommand(commands: readonly string[], prompt: string): string | null {
  const projectSpecific = commands.find((command) => command.startsWith("./") || command.includes("worktree"));

  if (projectSpecific !== undefined && isWorkflowPrompt(prompt)) {
    return projectSpecific;
  }

  const setupCommand = commands.find((command) => /(?:uv sync|pnpm install|npm install|git worktree)/i.test(command));
  return setupCommand !== undefined && isWorkflowPrompt(prompt) ? setupCommand : null;
}

function isWorkflowPrompt(prompt: string): boolean {
  return /\b(?:worktree|setup|prune|test|tests|performance|example|fixture|script|plan|strategy)\b/i.test(prompt);
}

function classifyWorkflowTarget(prompt: string): string {
  if (/\bworktree\b/i.test(prompt) && /\bsetup\b/i.test(prompt)) {
    return "worktree setup";
  }

  if (/\bworktree\b/i.test(prompt) && /\bprune|stale|old\b/i.test(prompt)) {
    return "worktree pruning";
  }

  if (/\btests?|performance|faster\b/i.test(prompt)) {
    return "test performance work";
  }

  if (/\bexample|fixture\b/i.test(prompt)) {
    return "fixture/example maintenance";
  }

  return "repo workflow";
}

function selectTopic(prompt: string): string {
  const line = prompt
    .split(/\r?\n+/)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);

  return truncateInline(line ?? "the requested change", 80);
}

function formatCommand(command: string): string {
  return command.startsWith("`") && command.endsWith("`") ? command : `\`${command}\``;
}

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[.!?]+$/g, "").trim();
}

function lowercaseFirst(value: string): string {
  if (value.length === 0) {
    return value;
  }

  return `${value[0]!.toLowerCase()}${value.slice(1)}`;
}

function sourceRefsForEvents(sourceSession: SourceSession, events: readonly Event[]): SourceRef[] {
  return events.map((event) =>
    createSourceRef(sourceSession, {
      eventId: event.event_id,
      line: event.source_offsets.start_line,
      turnId: event.turn_id
    })
  );
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const uniqueValues: string[] = [];

  for (const value of values) {
    const normalized = value.trim();

    if (normalized.length === 0 || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    uniqueValues.push(normalized);
  }

  return uniqueValues;
}

function createLearning(input: {
  confidence: ConfidenceLevel;
  evidence: string[];
  kind: LearningKind;
  learningId: string;
  promotionBasis: string;
  scope: Learning["scope"];
  scopeKey: string;
  sourceRefs: SourceRef[];
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
    source_refs: input.sourceRefs,
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

function dedupeProjectCandidates(candidates: readonly ProjectLearningCandidate[]): ProjectLearningCandidate[] {
  const seen = new Set<string>();
  const uniqueCandidates: ProjectLearningCandidate[] = [];

  for (const candidate of candidates) {
    if (seen.has(candidate.dedupeKey)) {
      continue;
    }

    seen.add(candidate.dedupeKey);
    uniqueCandidates.push(candidate);
  }

  return uniqueCandidates;
}

function truncateInline(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}
