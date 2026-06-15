import type {
  ConfidenceLevel,
  Event,
  Learning,
  LearningKind,
  SourceRef,
  SourceSession,
  Turn,
} from "../models/canonical.js";
import { learningSchema } from "../models/canonical.js";
import {
  capEvidenceText,
  extractSubstantivePrompt,
  isNoSignalPrompt,
  learningEvidenceFromPrompt,
  looksLikeSkillHarnessLeak,
  sanitizeHarnessLeakText,
  sanitizeLearningTitle,
  sanitizeUserPrompt,
} from "./prompt-sanitize.js";

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
        title: candidate.title,
      }),
    ),
  );
  const user = dedupeLearnings(
    input.turns.flatMap((turn) =>
      extractUserPreferenceCandidates(extractSubstantivePrompt(turn.user_prompt) ?? "").map(
        (candidate, index) =>
          createLearning({
            confidence: candidate.confidence,
            evidence: [candidate.evidence],
            kind: candidate.kind,
            learningId: `${input.sourceSession.session_id}:user:${turn.index}:${index}`,
            promotionBasis: "Explicit user instruction captured in the source prompt.",
            scope: "user",
            scopeKey: input.userScopeKey ?? defaultUserScopeKey,
            sourceRefs: [
              createSourceRef(input.sourceSession, {
                turnId: turn.turn_id,
              }),
            ],
            statement: candidate.statement,
            title: candidate.title,
          }),
      ),
    ),
  );

  return {
    project,
    user,
  };
}

function extractProjectLearningCandidates(
  input: ExtractLearningsInput,
): ProjectLearningCandidate[] {
  const eventsInVerifiedFixTurns = new Set(
    input.turns
      .filter((turn) => hasSameTurnVerifiedFix(input.events, turn.turn_id))
      .flatMap((turn) =>
        input.events
          .filter((event) => event.turn_id === turn.turn_id)
          .map((event) => event.event_id),
      ),
  );
  const eventCandidates = input.events.flatMap((event) =>
    eventsInVerifiedFixTurns.has(event.event_id)
      ? []
      : (toProjectEventCandidate(input.sourceSession, event) ?? []),
  );
  const turnCandidates = input.turns.flatMap((turn, index) =>
    toProjectTurnCandidates({
      events: input.events,
      index,
      sourceSession: input.sourceSession,
      turn,
    }),
  );
  const fallbackCandidates =
    input.events.length === 0 ? extractNoEventTurnFallbackCandidates(input) : [];
  return dedupeProjectCandidates(
    [...eventCandidates, ...turnCandidates, ...fallbackCandidates]
      .map(finalizeProjectLearningCandidate)
      .filter((candidate): candidate is ProjectLearningCandidate => candidate !== null),
  );
}

function hasSameTurnVerifiedFix(events: readonly Event[], turnId: string): boolean {
  const turnEvents = events.filter(
    (event) => event.turn_id === turnId && event.confidence !== "low",
  );
  return (
    turnEvents.some((event) => event.type === "fix" && !looksLikeProcessNarration(event.summary)) &&
    turnEvents.some(
      (event) => event.type === "verification" && isUsefulVerificationText(event.summary),
    )
  );
}
function toProjectEventCandidate(
  sourceSession: SourceSession,
  event: Event,
): ProjectLearningCandidate | null {
  if (event.confidence === "low") {
    return null;
  }

  if (isProcessText(event.summary) || looksLikeProcessNarration(event.summary)) {
    return null;
  }

  if (looksLikeSkillHarnessLeak(event.summary)) {
    return null;
  }

  if (event.type === "failure" && !isConcreteFailure(event.summary)) {
    return null;
  }

  if (event.type === "failure" && looksLikeCompletionNotFailure(event.summary)) {
    return null;
  }

  if (
    event.type === "decision" &&
    !hasDurableDecisionSignal(event.summary) &&
    (looksLikeExplanationNotDecision(event.summary) || looksLikeNonDurableSummary(event.summary))
  ) {
    return null;
  }

  if (event.type === "failure" && looksLikeNonDurableSummary(event.summary)) {
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
      sourceRefs: [
        createSourceRef(sourceSession, {
          eventId: event.event_id,
          line: event.source_offsets.start_line,
          turnId: event.turn_id,
        }),
      ],
      statement: completionStatement,
      title: `Verified completion: ${truncateInline(completionStatement, 60)}`,
    };
  }

  switch (event.type) {
    case "decision": {
      const statement = sanitizeHarnessLeakText(event.summary);
      if (statement.length === 0) {
        return null;
      }

      return {
        confidence: event.confidence,
        dedupeKey: `decision:${statement.toLowerCase()}`,
        evidence: [statement],
        kind: "decision",
        learningId: `${sourceSession.session_id}:project:decision:${event.event_id}`,
        promotionBasis:
          "Derived from an explicit implementation decision in the reduced event stream.",
        sourceRefs: [
          createSourceRef(sourceSession, {
            eventId: event.event_id,
            line: event.source_offsets.start_line,
            turnId: event.turn_id,
          }),
        ],
        statement,
        title: `Decision: ${truncateInline(statement, 72)}`,
      };
    }
    case "failure":
      return {
        confidence: event.confidence,
        dedupeKey: `failure:${event.summary.toLowerCase()}`,
        evidence: [event.summary],
        kind: "failure_mode",
        learningId: `${sourceSession.session_id}:project:failure:${event.event_id}`,
        promotionBasis: "Derived from a concrete failure event in the reduced transcript.",
        sourceRefs: [
          createSourceRef(sourceSession, {
            eventId: event.event_id,
            line: event.source_offsets.start_line,
            turnId: event.turn_id,
          }),
        ],
        statement: event.summary,
        title: `Failure mode: ${truncateInline(event.summary, 68)}`,
      };
    case "verification": {
      const verificationCommand =
        readPayloadString(event, "verification_command") ?? extractCommandFromText(event.summary);

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
        sourceRefs: [
          createSourceRef(sourceSession, {
            eventId: event.event_id,
            line: event.source_offsets.start_line,
            turnId: event.turn_id,
          }),
        ],
        statement,
        title: `Verification: ${verificationCommand}`,
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
  const turnEvents = input.events.filter(
    (event) => event.turn_id === input.turn.turn_id && event.confidence !== "low",
  );
  const hasVerifiedFix = hasSameTurnVerifiedFix(input.events, input.turn.turn_id);
  const fixEvents = turnEvents.filter(
    (event) => event.type === "fix" && !looksLikeProcessNarration(event.summary),
  );
  const verificationEvents = turnEvents.filter(
    (event) => event.type === "verification" && isUsefulVerificationText(event.summary),
  );
  const failureEvents = turnEvents.filter((event) =>
    hasVerifiedFix
      ? false
      : event.type === "failure" &&
        isConcreteFailure(event.summary) &&
        !looksLikeProcessNarration(event.summary),
  );
  const commands = usefulCommandsForTurn(input.turn, turnEvents);
  const files = usefulFilesForTurn(input.turn, turnEvents);
  const candidates: ProjectLearningCandidate[] = [];

  if (fixEvents.length > 0 && verificationEvents.length > 0) {
    const fix = fixEvents.at(0);
    const verification = verificationEvents.at(0);
    if (fix && verification) {
      const command = commands[0] ?? commandFromEvent(verification);
      const normalizedFix = normalizeWorkflowStatement(fix.summary);
      const fixPrefix = startsWithPastTenseVerb(normalizedFix) ? "" : "Fixed ";
      const statement = `${fixPrefix}${lowercaseFirst(normalizedFix)}; verified${command === undefined ? "" : ` with ${formatCommand(command)}`}.`;
      candidates.push({
        confidence: command === undefined ? "medium" : "high",
        dedupeKey: `verified-fix:${statement.toLowerCase()}`,
        evidence: uniqueStrings([fix.summary, verification.summary]),
        kind: "workflow",
        learningId: `${input.sourceSession.session_id}:project:verified-fix:${input.index}`,
        promotionBasis: "Derived from same-turn fix and verification evidence.",
        sourceRefs: sourceRefsForEvents(input.sourceSession, [fix, verification]),
        statement,
        title: `Verified fix: ${truncateInline(statement, 60)}`,
      });
    }
  }

  for (const failure of failureEvents) {
    const resolution = fixEvents[0] ?? verificationEvents[0];

    if (resolution === undefined) {
      continue;
    }

    const command = commands[0] ?? commandFromEvent(resolution);
    const failureSummary = normalizeResolutionSummary(failure.summary);
    const resolutionSummary = normalizeResolutionSummary(resolution.summary);
    const statement = `Resolved ${failureSummary} by ${lowercaseFirst(resolutionSummary)}.`;
    candidates.push({
      confidence: command === undefined ? "medium" : "high",
      dedupeKey: `error-resolution:${statement.toLowerCase()}`,
      evidence: uniqueStrings([failure.summary, resolution.summary]),
      kind: "failure_mode",
      learningId: `${input.sourceSession.session_id}:project:error-resolution:${input.index}`,
      promotionBasis: "Derived from concrete failure evidence followed by a fix or verification.",
      sourceRefs: sourceRefsForEvents(input.sourceSession, [failure, resolution]),
      statement,
      title: `Error resolution: ${truncateInline(statement, 60)}`,
    });
  }

  const promptForClassification =
    sanitizeUserPrompt(input.turn.user_prompt) || input.turn.user_prompt;
  const workflowCommand = hasVerifiedFix
    ? null
    : selectWorkflowCommand(commands, promptForClassification);
  if (workflowCommand !== null) {
    const workflowTarget = classifyWorkflowTarget(promptForClassification);
    const statement = `Use ${formatCommand(workflowCommand)} for ${workflowTarget} in ${input.sourceSession.project_key}.`;
    candidates.push({
      confidence: "medium",
      dedupeKey: `workflow:${statement.toLowerCase()}`,
      evidence: learningEvidenceFromPrompt(input.turn.user_prompt, workflowCommand),
      kind: "workflow",
      learningId: `${input.sourceSession.session_id}:project:workflow:${input.index}`,
      promotionBasis: "Derived from project-specific command usage in the reduced turn.",
      sourceRefs: [
        createSourceRef(input.sourceSession, {
          turnId: input.turn.turn_id,
        }),
      ],
      statement,
      title: `Workflow: ${truncateInline(statement, 60)}`,
    });
  }

  if (
    !hasVerifiedFix &&
    fixEvents.length > 0 &&
    files.length > 0 &&
    !looksLikeRawCompletionBlock(fixEvents.at(0)?.summary ?? "")
  ) {
    const fix = fixEvents.at(0);
    const file = files.at(0);
    if (!fix || !file) {
      // guarded by length checks above
    } else {
      const fixSummary = normalizeFixSummary(fix.summary);
      const statement = `In ${file}, ${lowercaseFirst(fixSummary)}.`;
      candidates.push({
        confidence: "medium",
        dedupeKey: `file-scoped:${statement.toLowerCase()}`,
        evidence: [fix.summary, file],
        kind: "pattern",
        learningId: `${input.sourceSession.session_id}:project:file-scoped:${input.index}`,
        promotionBasis: "Derived from a concrete file path and fix outcome in the same turn.",
        sourceRefs: sourceRefsForEvents(input.sourceSession, [fix]),
        statement,
        title: `File update: ${truncateInline(statement, 60)}`,
      });
    }
  }

  const prReviewCommand = selectPrReviewCommand(commands, promptForClassification);
  if (prReviewCommand !== null) {
    const statement = `Use ${formatCommand(prReviewCommand)} for PR review in ${input.sourceSession.project_key}.`;
    candidates.push({
      confidence: "medium",
      dedupeKey: `pr-review:${statement.toLowerCase()}`,
      evidence: learningEvidenceFromPrompt(input.turn.user_prompt, prReviewCommand),
      kind: "workflow",
      learningId: `${input.sourceSession.session_id}:project:pr-review:${input.index}`,
      promotionBasis: "Derived from PR review command usage in the reduced turn.",
      sourceRefs: [
        createSourceRef(input.sourceSession, {
          turnId: input.turn.turn_id,
        }),
      ],
      statement,
      title: `PR review: ${truncateInline(statement, 60)}`,
    });
  }

  const forkSyncCommand = selectForkSyncCommand(commands, promptForClassification);
  if (forkSyncCommand !== null) {
    const statement = `Use ${formatCommand(forkSyncCommand)} to maintain private fork with upstream in ${input.sourceSession.project_key}.`;
    candidates.push({
      confidence: "medium",
      dedupeKey: `fork-sync:${statement.toLowerCase()}`,
      evidence: learningEvidenceFromPrompt(input.turn.user_prompt, forkSyncCommand),
      kind: "workflow",
      learningId: `${input.sourceSession.session_id}:project:fork-sync:${input.index}`,
      promotionBasis: "Derived from fork maintenance command usage in the reduced turn.",
      sourceRefs: [
        createSourceRef(input.sourceSession, {
          turnId: input.turn.turn_id,
        }),
      ],
      statement,
      title: `Fork sync: ${truncateInline(statement, 60)}`,
    });
  }

  const crashDiagnostic = extractCrashDiagnostic(input.turn, commands, files);
  if (crashDiagnostic !== null) {
    candidates.push({
      confidence: "medium",
      dedupeKey: `crash:${crashDiagnostic.statement.toLowerCase()}`,
      evidence: crashDiagnostic.evidence,
      kind: "failure_mode",
      learningId: `${input.sourceSession.session_id}:project:crash:${input.index}`,
      promotionBasis: "Derived from crash diagnostic evidence in the reduced turn.",
      sourceRefs: [
        createSourceRef(input.sourceSession, {
          turnId: input.turn.turn_id,
        }),
      ],
      statement: crashDiagnostic.statement,
      title: `Crash: ${truncateInline(crashDiagnostic.statement, 60)}`,
    });
  }

  const specDecision = extractSpecDecision(input.turn, files);
  if (specDecision !== null) {
    candidates.push({
      confidence: "medium",
      dedupeKey: `spec:${specDecision.statement.toLowerCase()}`,
      evidence: specDecision.evidence,
      kind: "decision",
      learningId: `${input.sourceSession.session_id}:project:spec:${input.index}`,
      promotionBasis: "Derived from spec or architecture discussion in the reduced turn.",
      sourceRefs: [
        createSourceRef(input.sourceSession, {
          turnId: input.turn.turn_id,
        }),
      ],
      statement: specDecision.statement,
      title: `Decision: ${truncateInline(specDecision.statement, 60)}`,
    });
  }

  return candidates;
}

function extractNoEventTurnFallbackCandidates(
  input: ExtractLearningsInput,
): ProjectLearningCandidate[] {
  if (input.events.length > 0) {
    return [];
  }

  const candidates: ProjectLearningCandidate[] = [];

  for (const [index, turn] of input.turns.entries()) {
    const promptForClassification = sanitizeUserPrompt(turn.user_prompt) || turn.user_prompt;

    if (
      looksLikeSkillHarnessLeak(promptForClassification) ||
      isNoSignalPrompt(promptForClassification) ||
      looksLikeProcessNarration(promptForClassification)
    ) {
      continue;
    }

    const commands = usefulCommandsForTurn(turn, []);
    const files = usefulFilesForTurn(turn, []);

    if (commands.length === 0 && files.length === 0) {
      continue;
    }

    const projectSpecificCommand = commands.find(
      (command) =>
        /^\.\//.test(command) ||
        /\b(?:tools|scripts|src|lib|app|server|desktop|mobile|api|core|shared)\/[^\s]+/i.test(
          command,
        ),
    );
    const command =
      projectSpecificCommand ?? selectWorkflowCommand(commands, promptForClassification);

    if (command === null) {
      continue;
    }

    const file = files[0];
    const task = isConcreteProjectPrompt(promptForClassification)
      ? promptContextLine(turn.user_prompt)
      : classifyWorkflowTarget(promptForClassification);

    if (task === "this project") {
      continue;
    }

    const statement = file
      ? `Use ${formatCommand(command)} when working on ${file} in ${input.sourceSession.project_key}.`
      : `Use ${formatCommand(command)} for ${task} in ${input.sourceSession.project_key}.`;

    candidates.push({
      confidence: "medium",
      dedupeKey: `turn-fallback:${statement.toLowerCase()}`,
      evidence: learningEvidenceFromPrompt(turn.user_prompt, command),
      kind: "workflow",
      learningId: `${input.sourceSession.session_id}:project:turn-fallback:${index}`,
      promotionBasis:
        "Derived from project-specific command usage when no structured events were extracted.",
      sourceRefs: [
        createSourceRef(input.sourceSession, {
          turnId: turn.turn_id,
        }),
      ],
      statement,
      title: `Workflow: ${truncateInline(statement, 60)}`,
    });
  }

  return candidates;
}

function isConcreteProjectPrompt(prompt: string): boolean {
  return /\b(?:fix|fixed|bug|debug|implement|implemented|resolve|resolved|refactor|refactored|migrate|migrated|upgrade|upgraded|update|updated|change|changed|add|added|remove|removed|review|audit|test|tests|optimize|performance|configure|config|install|build|deploy)\b/i.test(
    prompt,
  );
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

  const command =
    extractCommandFromText(verifiedText) ?? readPayloadString(event, "verification_command");
  const verifiedClause = command === null ? "verified" : `verified with ${formatCommand(command)}`;

  return `${startsWithPastTenseVerb(doneText) ? "" : "Completed "}${lowercaseFirst(stripTrailingPunctuation(doneText))}; ${verifiedClause}.`;
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
        title: "Explicit final response formatting",
      });
      continue;
    }

    if (/do not revert edits made by others/i.test(line)) {
      candidates.push({
        confidence: "high",
        evidence: line,
        kind: "workflow",
        statement:
          "Do not revert concurrent edits made by others; adapt to the current workspace state.",
        title: "Preserve concurrent edits",
      });
      continue;
    }

    if (/\bprefer\b/i.test(line) || /\balways\b/i.test(line) || /\bnever\b/i.test(line)) {
      candidates.push({
        confidence: "high",
        evidence: line,
        kind: "preference",
        statement: line,
        title: truncateInline(line, 72),
      });
      continue;
    }

    if (/keep .* focused/i.test(line)) {
      candidates.push({
        confidence: "medium",
        evidence: line,
        kind: "workflow",
        statement: line,
        title: truncateInline(line, 72),
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

  return value.filter(
    (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
  );
}

function stripEventPrefix(value: string): string {
  return value.replace(/^Verification noted:\s*/i, "").trim();
}

function normalizeFixSummary(value: string): string {
  return stripLeadingCompletionVerb(
    stripTrailingPunctuation(stripWhatChangedClause(stripEventPrefix(stripCompletionBlock(value))))
      .replace(
        /^(?:fixed|resolved|updated|changed|patched|corrected)\s+(?:fixed|resolved|updated|changed|patched|corrected)\b\s*/i,
        (match) => {
          const firstWord = match.trim().split(/\s+/)[0] ?? "";
          return firstWord.length > 0 ? `${firstWord} ` : "";
        },
      )
      .trim(),
  );
}

function normalizeWorkflowStatement(value: string): string {
  return stripLeadingWorkflowPrefix(normalizeFixSummary(value));
}

function startsWithPastTenseVerb(value: string): boolean {
  return /^(?:fixed|resolved|updated|changed|patched|corrected|added|implemented|replaced|removed|wired|pre-?production\b[\s\S]{0,120}\bare implemented\b|all\b[\s\S]{0,80}\boptimizations\b)/i.test(
    value,
  );
}

function stripWhatChangedClause(value: string): string {
  return value
    .replace(
      /\s+\*\*(?:What changed|Changed|Changes|Implemented|Delivered|Updates|Change|Summary|Summary of changes):\*\*[\s\S]*$/i,
      "",
    )
    .replace(/\s+Summary of what changed:[\s\S]*$/i, "")
    .trim();
}

function normalizeResolutionSummary(value: string): string {
  return stripTrailingPunctuation(
    stripWhatChangedClause(stripEventPrefix(stripCompletionBlock(value))),
  );
}

function stripLeadingCompletionVerb(value: string): string {
  return value
    .replace(
      /^(?:completed|done)\s+(?=(?:implemented|added|fixed|resolved|updated|changed|patched|corrected|replaced|removed)\b)/i,
      "",
    )
    .trim();
}

function stripLeadingWorkflowPrefix(value: string): string {
  return value
    .replace(/^(?:completed|done)\s+/i, "")
    .replace(/^implemented\s+(?=implemented\b)/i, "")
    .trim();
}

function extractCommandFromText(value: string): string | null {
  for (const match of value.matchAll(/`([^`\n]+)`/g)) {
    const candidate = match[1]?.trim();

    if (
      candidate !== undefined &&
      /^(?:\.\/[\w./-]+|(?:npm|pnpm|yarn|bun|node|python3?|uv|git|just|make|cargo|go|docker|sqlite3)\b)/i.test(
        candidate,
      )
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
    ...events.flatMap((event) => usefulCommandsForEvent(event)),
  ]);
}

function usefulCommandsForEvent(event: Event): string[] {
  return uniqueStrings([
    ...readPayloadStringArray(event, "command_strings"),
    ...extractCommandsFromText(event.summary),
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
    ...events.flatMap((event) => readPayloadStringArray(event, "command_strings")),
  ])
    .map((value) => normalizeFilePath(value))
    .filter((value): value is string => value !== null);
}

function normalizeFilePath(value: string): string | null {
  const trimmed = value.trim().replace(/^`+|`+$/g, "");

  if (
    !/\.(?:[cm]?[jt]sx?|py|go|rs|swift|kt|java|c|cc|cpp|h|hpp|json|ya?ml|toml|md|sql)$/i.test(
      trimmed,
    )
  ) {
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

  return /^(?:\.\/[\w./-]+|(?:npm|pnpm|yarn|bun|node|python3?|uv|git|just|make|cargo|go|docker|sqlite3)\b)/i.test(
    command.trim(),
  );
}

function isUsefulVerificationText(value: string): boolean {
  if (/\b(?:can|will|could|should)\s+verify\b/i.test(value) || /\blet me verify\b/i.test(value)) {
    return false;
  }

  return (
    /\b(?:verified|all checks passed|0 failures|done|completed|implemented|replaced)\b/i.test(
      value,
    ) ||
    /\btests?\s+pass(?:ed|es)?\b/i.test(value) ||
    /`[^`]+`\s+passes\b/i.test(value)
  );
}

function isConcreteFailure(value: string): boolean {
  return /\b(?:failed|error|exception|enoent|eacces|no such|cannot|could not|missing|unknown import|traceback)\b/i.test(
    value,
  );
}

function selectWorkflowCommand(commands: readonly string[], prompt: string): string | null {
  const projectSpecific = commands.find(
    (command) => command.startsWith("./") || command.includes("worktree"),
  );

  if (projectSpecific !== undefined && isWorkflowPrompt(prompt)) {
    return projectSpecific;
  }

  const setupCommand = commands.find((command) =>
    /(?:uv sync|pnpm install|npm install|git worktree)/i.test(command),
  );
  return setupCommand !== undefined && isWorkflowPrompt(prompt) ? setupCommand : null;
}

function isWorkflowPrompt(prompt: string): boolean {
  return /\b(?:worktree|setup|prune|test|tests|performance|example|fixture|script|plan|strategy)\b/i.test(
    prompt,
  );
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

function selectPrReviewCommand(commands: readonly string[], prompt: string): string | null {
  if (!/\b(?:review|checkout)\b.*\bpr\b|\bpr\b.*\b(?:review|checkout)\b/i.test(prompt)) {
    return null;
  }

  const worktreeCommand = commands.find((command) => /git worktree (?:add|remove)/i.test(command));
  if (worktreeCommand !== undefined) {
    return worktreeCommand;
  }

  const ghCommand = commands.find((command) => /^gh\b/i.test(command));
  return ghCommand ?? null;
}

function selectForkSyncCommand(commands: readonly string[], prompt: string): string | null {
  if (!/\b(?:private clone|upstream|fork|sync with upstream)\b/i.test(prompt)) {
    return null;
  }

  const upstreamCommand = commands.find((command) => /git remote add upstream/i.test(command));
  if (upstreamCommand !== undefined) {
    return upstreamCommand;
  }

  const syncCommand = commands.find((command) => /git fetch upstream/i.test(command));
  return syncCommand ?? null;
}

function extractCrashDiagnostic(
  turn: Turn,
  commands: readonly string[],
  files: readonly string[],
): { statement: string; evidence: string[] } | null {
  const promptForClassification = sanitizeUserPrompt(turn.user_prompt) || turn.user_prompt;
  if (!/\b(?:fix|crash|error):|\b(?:debug|diagnose)\b/i.test(promptForClassification)) {
    return null;
  }

  const diagnosticCommands = commands.filter((command) =>
    /\b(?:bun -e|node -e|python3? -c|python3? -m pytest|npm test|bun test)\b/i.test(command),
  );
  const errorFiles = files.filter(
    (file) => /\.(?:log|crash|err)$/i.test(file) || /(?:crash|error|debug|trace)/i.test(file),
  );

  if (diagnosticCommands.length === 0 && errorFiles.length === 0) {
    return null;
  }

  const command = diagnosticCommands[0];
  const file = errorFiles[0];
  const promptSnippet = promptContextLine(turn.user_prompt);
  const evidence = uniqueStrings([
    ...(command ? [command] : []),
    ...(file ? [file] : []),
    ...learningEvidenceFromPrompt(turn.user_prompt),
  ]);

  if (command !== undefined && file !== undefined) {
    return {
      statement: `Diagnose crashes with ${formatCommand(command)}; check ${file} for error details.`,
      evidence,
    };
  }

  if (command !== undefined) {
    return {
      statement: `Diagnose crashes with ${formatCommand(command)} in ${promptSnippet}.`,
      evidence,
    };
  }

  if (file !== undefined) {
    return {
      statement: `Check ${file} for crash diagnostics in ${promptSnippet}.`,
      evidence,
    };
  }

  return null;
}

function extractSpecDecision(
  turn: Turn,
  files: readonly string[],
): { statement: string; evidence: string[] } | null {
  const promptForClassification = sanitizeUserPrompt(turn.user_prompt) || turn.user_prompt;
  if (
    !/\b(?:speckit|spec|architecture|roadmap|design doc|create a .+ wrapper|create a .+ spec)\b/i.test(
      promptForClassification,
    )
  ) {
    return null;
  }

  const specFiles = files.filter(
    (file) => /\/(?:specs?|docs?|design)\//i.test(file) || /\.(?:md|mdx)$/i.test(file),
  );

  if (specFiles.length === 0) {
    return null;
  }

  const file = specFiles.at(0);
  if (!file) {
    return null;
  }
  const topic = sanitizeHarnessLeakText(
    promptForClassification
      .replace(/\/(?:speckit|speckit-specify)\b/gi, "")
      .replace(/['"]/g, "")
      .trim()
      .split(/\r?\n/)[0] ?? "",
  );

  if (topic.length === 0 || looksLikeSkillHarnessLeak(topic)) {
    return null;
  }

  const statement = `Refer to ${file} for ${truncateInline(topic, 60)} architecture decisions.`;
  if (looksLikeSkillHarnessLeak(statement)) {
    return null;
  }

  return {
    statement,
    evidence: learningEvidenceFromPrompt(turn.user_prompt, file),
  };
}

function promptContextLine(rawPrompt: string): string {
  const substantive = extractSubstantivePrompt(rawPrompt);
  if (substantive === null) {
    return "this project";
  }

  return substantive.split(/\r?\n/)[0]?.trim() || "this project";
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

  return `${value[0]?.toLowerCase()}${value.slice(1)}`;
}

function stripCompletionBlock(value: string): string {
  const stripped = stripEventPrefix(value)
    .replace(/^\*\*Done:\*\*\s*/i, "")
    .replace(/\s+\*\*Verified:\*\*[\s\S]*$/i, "")
    .replace(/\s+\*\*Changed:\*\*[\s\S]*$/i, "")
    .replace(/\s+\*\*Changes:\*\*[\s\S]*$/i, "")
    .trim();

  return stripped.length > 0 ? stripped : value;
}

function looksLikeRawCompletionBlock(value: string): boolean {
  return (
    /\*\*(?:Done|Verified|Changed|Changes|Implemented|Summary of changes):\*\*/i.test(value) ||
    /summary of what was done/i.test(value)
  );
}

function looksLikeProcessNarration(value: string): boolean {
  const normalized = value.trim().toLowerCase();

  return (
    /\b(?:let me|i(?:'|’)m checking|i(?:'|’)ll check|i need to check|checking whether|now let me|clarifying)\b/i.test(
      value,
    ) ||
    /\b(?:would be like|what(?:'|’)s next\?|continue workflow|recommended\)|generation runs, but)\b/i.test(
      normalized,
    ) ||
    /\bi can detect\b/i.test(value) ||
    normalized.startsWith("summary of what was done")
  );
}

function isProcessText(summary: string): boolean {
  const normalized = summary.trim().toLowerCase();

  const processPrefixes = [
    "let me ",
    "i'll ",
    "i will ",
    "i'm ",
    "i'll ",
    "i'm ",
    "exploring ",
    "checking ",
    "reading ",
    "loading ",
    "creating a ",
    "implementing ",
    "adding ",
    "updating ",
    "now i have enough context",
    "now i understand",
    "now i see",
    "first, the ",
    "first, i'll ",
    "first, i'm ",
    "first, let me ",
    "i see - there's",
    "i see - the",
    "i need to add",
    "i need to update",
    "i need to fix",
    "rust compiles and",
    "the toast infrastructure",
    "the command infrastructure",
    "--- ## ",
  ];

  for (const prefix of processPrefixes) {
    if (normalized.startsWith(prefix)) {
      return true;
    }
  }

  return false;
}

function looksLikeCompletionNotFailure(summary: string): boolean {
  const normalized = summary.trim().toLowerCase();

  if (normalized.startsWith("**done:**")) {
    return true;
  }

  if (
    normalized.startsWith("## ") &&
    !normalized.includes("error") &&
    !normalized.includes("fail")
  ) {
    return true;
  }

  if (
    /\bverified\b.+(?:against|with|using)\b/i.test(normalized) &&
    !/\b(?:error|fail|exception)\b/i.test(normalized)
  ) {
    return true;
  }

  if (
    normalized.startsWith("summary of what's done:") ||
    normalized.startsWith("summary of what\u2019s done:")
  ) {
    return true;
  }

  if (normalized.startsWith("--- ## ") && /\bbatch \d+ complete\b/i.test(normalized)) {
    return true;
  }

  return false;
}

function looksLikeExplanationNotDecision(summary: string): boolean {
  const normalized = summary.trim().toLowerCase();

  if (
    normalized.startsWith("here's how ") ||
    normalized.startsWith("here is how ") ||
    normalized.startsWith("here\u2019s how ")
  ) {
    return true;
  }

  if (
    normalized.startsWith("here's what ") ||
    normalized.startsWith("here is what ") ||
    normalized.startsWith("here\u2019s what ")
  ) {
    return true;
  }

  if (
    (normalized.startsWith("here is a ") ||
      normalized.startsWith("here's a ") ||
      normalized.startsWith("here\u2019s a ")) &&
    /\b(?:plan|summary|overview|guide|tutorial)\b/i.test(normalized)
  ) {
    return true;
  }

  if (normalized.startsWith("## diff review") || normalized.startsWith("### diff review")) {
    return true;
  }

  if (normalized.startsWith("--- ## ")) {
    return true;
  }

  return false;
}

function looksLikeNonDurableSummary(summary: string): boolean {
  return (
    (looksLikeChatSummary(summary) ||
      looksLikeMarkdownReviewSummary(summary) ||
      hasExcessiveMarkdownStructure(summary)) &&
    !hasDurableDecisionSignal(summary)
  );
}

function looksLikeChatSummary(value: string): boolean {
  const normalized = value.trim().toLowerCase();

  return (
    normalized.startsWith("now i have the full picture") ||
    normalized.startsWith("clean.") ||
    normalized.startsWith("created to-dos") ||
    normalized.startsWith("created todos") ||
    normalized.startsWith("here's a summary") ||
    normalized.startsWith("here’s a summary") ||
    normalized.startsWith("here is a summary") ||
    normalized.startsWith("summary:") ||
    normalized.startsWith("summary of what") ||
    normalized.startsWith("summary of every") ||
    normalized.startsWith("it depends on the source") ||
    /\bgaps\s+vs\b/i.test(value) ||
    /\bsummary of every fix\b/i.test(value)
  );
}

function looksLikeMarkdownReviewSummary(value: string): boolean {
  const normalized = value.trim().toLowerCase();

  return (
    normalized.startsWith("## pragmatic code review") ||
    normalized.startsWith("pragmatic code review") ||
    /^(?:#{2,3}\s+)?pragmatic code review\b/i.test(value.trim()) ||
    /\b(?:must-fix|nice-to-have)\b/i.test(value)
  );
}

function hasExcessiveMarkdownStructure(value: string): boolean {
  const markerMatches = value.match(/(?:^|\s)(?:#{1,6}\s+|[-*]\s+|\d+\.\s+|\*\*[^*]+:\*\*)/g);

  return (markerMatches?.length ?? 0) >= 3;
}

function looksLikeRawWorkflowSummary(value: string): boolean {
  const normalized = value.trim().toLowerCase();

  return (
    normalized === "fixed completed; verified." ||
    normalized.startsWith("fixed completed; verified") ||
    /\*\*(?:delivered|implemented|summary|summary of changes|changes|verified):\*\*/i.test(value) ||
    /\|\s*-{2,}\s*\|/.test(value) ||
    hasExcessiveMarkdownStructure(value)
  );
}

function hasDurableDecisionSignal(value: string): boolean {
  return (
    /\b(?:decided|chose) to\b/i.test(value) ||
    /\b(?:keep|use|prefer)\b[\s\S]{0,120}\bbecause\b/i.test(value) ||
    /\bshould use\b[\s\S]{0,120}\bfor\b/i.test(value) ||
    /\bthe rule protects\b/i.test(value) ||
    /\bgeneration should\b/i.test(value) ||
    /\bsingle (?:result )?error channel\b/i.test(value) ||
    /\bcanonical\b/i.test(value) ||
    /\bsource of truth\b/i.test(value)
  );
}

function sourceRefsForEvents(sourceSession: SourceSession, events: readonly Event[]): SourceRef[] {
  return events.map((event) =>
    createSourceRef(sourceSession, {
      eventId: event.event_id,
      line: event.source_offsets.start_line,
      turnId: event.turn_id,
    }),
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
    title: input.title,
  } satisfies Learning);
}

function createSourceRef(
  sourceSession: SourceSession,
  options: {
    eventId?: string;
    line?: number | null;
    turnId?: string;
  },
): SourceRef {
  return {
    event_id: options.eventId ?? null,
    line: options.line ?? null,
    session_id: sourceSession.session_id,
    source_hash: sourceSession.source_hash,
    source_path: sourceSession.source_path,
    turn_id: options.turnId ?? null,
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

function finalizeProjectLearningCandidate(
  candidate: ProjectLearningCandidate,
): ProjectLearningCandidate | null {
  const statement = sanitizeHarnessLeakText(candidate.statement);
  if (statement.length === 0 || looksLikeSkillHarnessLeak(statement)) {
    return null;
  }

  const evidence = uniqueStrings(
    candidate.evidence
      .map((item) => capEvidenceText(sanitizeHarnessLeakText(item)))
      .filter((item) => item.length > 0 && !looksLikeSkillHarnessLeak(item)),
  );

  const titleBodyMax =
    candidate.kind === "decision" || candidate.title.startsWith("Decision:") ? 72 : 60;
  const title = sanitizeLearningTitle(candidate.title, statement, titleBodyMax);
  if (title.length === 0 || looksLikeSkillHarnessLeak(title)) {
    return null;
  }

  return {
    ...candidate,
    evidence: evidence.length > 0 ? evidence : [capEvidenceText(statement)],
    statement,
    title,
  };
}

function dedupeProjectCandidates(
  candidates: readonly ProjectLearningCandidate[],
): ProjectLearningCandidate[] {
  const durableCandidates = candidates.filter(isDurableCandidate);
  const orderedCandidates = [...durableCandidates].sort(
    (left, right) => candidatePriority(right) - candidatePriority(left),
  );
  const seen = new Set<string>();
  const uniqueCandidates: ProjectLearningCandidate[] = [];

  for (const candidate of orderedCandidates) {
    if (seen.has(candidate.dedupeKey)) {
      continue;
    }

    if (
      uniqueCandidates.some((existingCandidate) =>
        isRedundantProjectCandidate(candidate, existingCandidate),
      )
    ) {
      continue;
    }

    seen.add(candidate.dedupeKey);
    uniqueCandidates.push(candidate);
  }

  return uniqueCandidates.sort((left, right) => compareCandidateOrder(left, right));
}

function candidatePriority(candidate: ProjectLearningCandidate): number {
  switch (candidate.kind) {
    case "workflow":
      return candidate.dedupeKey.startsWith("verified-fix:") ||
        candidate.dedupeKey.startsWith("completion:")
        ? 40
        : 30;
    case "decision":
      return 25;
    case "pattern":
      return 20;
    case "failure_mode":
      return 10;
    case "verification_rule":
      return 5;
  }

  return 0;
}

function compareCandidateOrder(
  left: ProjectLearningCandidate,
  right: ProjectLearningCandidate,
): number {
  const leftLine = left.sourceRefs[0]?.line ?? Number.MAX_SAFE_INTEGER;
  const rightLine = right.sourceRefs[0]?.line ?? Number.MAX_SAFE_INTEGER;

  if (leftLine !== rightLine) {
    return leftLine - rightLine;
  }

  const priorityDifference = candidatePriority(right) - candidatePriority(left);
  if (priorityDifference !== 0) {
    return priorityDifference;
  }

  return left.learningId.localeCompare(right.learningId);
}

function isRedundantProjectCandidate(
  candidate: ProjectLearningCandidate,
  existingCandidate: ProjectLearningCandidate,
): boolean {
  if (candidate.kind === existingCandidate.kind) {
    return false;
  }

  const candidateKey = semanticCandidateKey(candidate.statement);
  const existingKey = semanticCandidateKey(existingCandidate.statement);

  if (candidateKey.length < 32 || existingKey.length < 32) {
    return false;
  }

  return candidateKey.includes(existingKey) || existingKey.includes(candidateKey);
}

export function semanticLearningStatementKey(value: string): string {
  return semanticCandidateKey(value);
}

function semanticCandidateKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^(?:resolved|fixed|completed|implemented|added|updated|changed)\s+/i, "")
    .replace(/^error\s+(?:after|with|in|while)\s+/i, "")
    .replace(/^in\s+[^,]+,\s+/i, "")
    .replace(/\s+by\s+[\s\S]*$/i, "")
    .replace(/;\s*verified[\s\S]*$/i, "")
    .replace(/\b(?:the|a|an|to|each|in|by|with|and|or|for|of|on|at|is|are|was|were)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function isDurableCandidate(candidate: ProjectLearningCandidate): boolean {
  const statement = candidate.statement;

  if (looksLikeProcessNarration(statement)) {
    return false;
  }

  if (candidate.kind !== "workflow" && looksLikeRawCompletionBlock(statement)) {
    return false;
  }

  if (candidate.kind === "verification_rule" && /^Run `?\.\/scripts\/qa`?/i.test(statement)) {
    return false;
  }

  if (
    candidate.kind === "pattern" &&
    (/\*\*(?:Done|Verified|Changed|Changes|Implemented|Summary of changes|Cause):\*\*/i.test(
      statement,
    ) ||
      /\b(?:Summary of what changed|Summary of changes|The four meaningful changes are|perfect alignment)\b/i.test(
        statement,
      ))
  ) {
    return false;
  }

  if (
    candidate.kind === "failure_mode" &&
    /^(?:The log ends right after|The CSS is fine|Now let me check)/i.test(statement)
  ) {
    return false;
  }

  if (
    (candidate.kind === "decision" || candidate.kind === "failure_mode") &&
    looksLikeNonDurableSummary(statement)
  ) {
    return false;
  }

  if (/^Use `\.\/scripts\/qa` for /i.test(statement)) {
    return false;
  }

  if (
    candidate.kind === "pattern" &&
    (looksLikeNonDurableSummary(statement) ||
      /\bhere(?:'|’)s what(?:'|’)s going on\b/i.test(statement))
  ) {
    return false;
  }

  if (
    candidate.kind === "workflow" &&
    /^(?:Completed|Fixed)\s+(?:summary of what|summary of changes|summary of what was fixed|desktop checks are green|cargo failed with)/i.test(
      statement,
    )
  ) {
    return false;
  }

  if (candidate.kind === "workflow" && looksLikeRawWorkflowSummary(statement)) {
    return false;
  }

  return true;
}

function truncateInline(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}
