import type {
  ConfidenceLevel,
  Event,
  EvidenceType,
  Learning,
  LearningKind,
  SourceRef,
  SourceSession,
  Turn,
} from "../models/canonical.js";
import { isAtomicStatement } from "./artifact-heuristics.js";
import {
  commandFromEvent,
  extractCommandFromText,
  readPayloadString,
  usefulCommandsForTurn,
  usefulFilesForTurn,
} from "./extract/command-helpers.js";
import { createLearning, createSourceRef, dedupeLearnings } from "./extract/learning-builders.js";
import {
  isProcessText,
  looksLikeCompletionNotFailure,
  looksLikeProcessNarration,
  looksLikeRawCompletionBlock,
} from "./extract/process-predicates.js";
import { uniqueStrings } from "./extract/strings.js";
import {
  formatCommand,
  lowercaseFirst,
  normalizeFixSummary,
  normalizeResolutionSummary,
  normalizeWorkflowStatement,
  startsWithPastTenseVerb,
  stripEventPrefix,
  stripTrailingPunctuation,
} from "./extract/text-normalizers.js";
import { normalizeFilePath } from "./file-paths.js";
import {
  capEvidenceText,
  extractSubstantivePrompt,
  isNoSignalPrompt,
  learningEvidenceFromPrompt,
  looksLikeEmbeddedAgentPrompt,
  looksLikeSkillHarnessLeak,
  sanitizeHarnessLeakText,
  sanitizeLearningStatement,
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
  // Optional precondition override. When set (e.g. an error-signature trigger
  // for failure learnings), it is used verbatim instead of the kind-derived
  // default from deriveProjectTrigger. May be explicitly undefined (no override).
  trigger?: string | undefined;
};

export function extractLearnings(input: ExtractLearningsInput): ExtractedLearnings {
  // Subject/capability axes are session-level: the stack and skills the whole
  // session touched apply to every project learning it produced.
  const technologies = extractTechnologies(input.turns);
  const skillRefs = deriveSkillRefs(input.turns);
  const project = dedupeLearnings(
    extractProjectLearningCandidates(input).map((candidate) =>
      createLearning({
        confidence: candidate.confidence,
        evidence: candidate.evidence,
        evidenceType: deriveProjectEvidenceType(candidate),
        kind: candidate.kind,
        learningId: candidate.learningId,
        promotionBasis: candidate.promotionBasis,
        scope: "project",
        scopeKey: input.sourceSession.project_key,
        skillRefs,
        sourceRefs: candidate.sourceRefs,
        statement: candidate.statement,
        technologies,
        title: candidate.title,
        trigger:
          candidate.trigger ??
          deriveProjectTrigger(candidate.kind, input.sourceSession.project_key),
      }),
    ),
  );
  const user = dedupeLearnings(
    input.turns.flatMap((turn) => {
      const substantivePrompt = extractSubstantivePrompt(turn.user_prompt) ?? "";
      // Foreign agent system prompts (e.g. embedded design/coding agents logged
      // into this transcript source) contain prefer/always/never directives that
      // are NOT the operator's preferences. Skip them so they never become user
      // learnings.
      if (looksLikeEmbeddedAgentPrompt(turn.user_prompt)) {
        return [];
      }
      return extractUserPreferenceCandidates(substantivePrompt).map((candidate, index) =>
        createLearning({
          confidence: candidate.confidence,
          evidence: [candidate.evidence],
          // Direct operator instructions captured from the user's own prompt.
          evidenceType: "user_stated",
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
          trigger: "When applying the operator's stated working preferences.",
        }),
      );
    }),
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
  const deadEndCandidates = extractDeadEndCandidates(
    input.sourceSession,
    input.events,
    eventsInVerifiedFixTurns,
  );
  // Derive a concrete-signal fallback when no workflow candidate emerged from
  // events or turns — even when unrelated (e.g. process) events are present. A
  // real command/file signal in the turn should not be lost just because the
  // turn also produced an unrelated event.
  const hasWorkflowCandidate = [...eventCandidates, ...turnCandidates, ...deadEndCandidates].some(
    (candidate) => candidate.kind === "workflow",
  );
  const fallbackCandidates = hasWorkflowCandidate
    ? []
    : extractConcreteTurnFallbackCandidates(input);
  return applyProjectLearningCap(
    dedupeProjectCandidates(
      [...eventCandidates, ...turnCandidates, ...deadEndCandidates, ...fallbackCandidates]
        .map(finalizeProjectLearningCandidate)
        .filter((candidate): candidate is ProjectLearningCandidate => candidate !== null),
    ),
  );
}
const defaultProjectLearningCap = 12;

export function getProjectLearningCap(): number {
  const raw = process.env.ASD_MAX_PROJECT_LEARNINGS;
  if (raw === undefined || raw.length === 0) return defaultProjectLearningCap;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) || parsed < 1 ? defaultProjectLearningCap : parsed;
}

function applyProjectLearningCap(
  candidates: readonly ProjectLearningCandidate[],
): ProjectLearningCandidate[] {
  const cap = getProjectLearningCap();
  if (candidates.length <= cap) return candidates.slice();
  console.warn(
    `[asd] project learning cap reached: ${candidates.length} candidates truncated to ${cap} (set ASD_MAX_PROJECT_LEARNINGS to override)`,
  );
  return candidates.slice(0, cap);
}

// Strong abandonment signals only — high precision. "reverted"/"rolled back"
// are deliberately excluded because they routinely precede a successful fix
// ("reverted X, then fixed it"); events in verified-fix turns are skipped too.
const deadEndSignalPattern =
  /\b(?:abandoned|gave up on|dead[- ]ends?|not viable|wasn['’]t viable|won['’]t work|did(?:n['’]t| not) pan out|turned out not to work|was a waste of time)\b/i;

const triedApproachPattern =
  /\b(?:tried|attempted|experimented with)\s+(?:to\s+)?(.+?)(?=\s+(?:but|because|then|so|,|;|—)|[.!?]|$)/i;

function extractDeadEndCandidates(
  sourceSession: SourceSession,
  events: readonly Event[],
  eventsInVerifiedFixTurns: ReadonlySet<string>,
): ProjectLearningCandidate[] {
  const candidates: ProjectLearningCandidate[] = [];
  for (const event of events) {
    if (event.confidence === "low" || eventsInVerifiedFixTurns.has(event.event_id)) {
      continue;
    }
    const summary = event.summary;
    if (!deadEndSignalPattern.test(summary)) {
      continue;
    }
    if (looksLikeProcessNarration(summary) || looksLikeSkillHarnessLeak(summary)) {
      continue;
    }

    const approach = summary
      .match(triedApproachPattern)?.[1]
      ?.trim()
      .replace(/[\s,;:]+$/, "");
    const statement =
      approach !== undefined && approach.length >= 4
        ? `Avoid ${lowercaseFirst(approach)} in ${sourceSession.project_key} (tried and abandoned).`
        : `In ${sourceSession.project_key}, avoid the approach that was abandoned: ${truncateInline(stripTrailingPunctuation(summary), 100)}.`;

    candidates.push({
      confidence: "medium",
      dedupeKey: `dead-end:${statement.toLowerCase()}`,
      evidence: [summary],
      kind: "dead_end",
      learningId: `${sourceSession.session_id}:project:dead-end:${event.event_id}`,
      promotionBasis: "Derived from an abandoned-approach signal in the reduced transcript.",
      sourceRefs: [
        createSourceRef(sourceSession, {
          eventId: event.event_id,
          line: event.source_offsets.start_line,
          turnId: event.turn_id,
        }),
      ],
      statement,
      title: `Dead end: ${truncateInline(statement, 60)}`,
    });
  }
  return candidates;
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
        trigger: errorSignatureTrigger(event.summary, sourceSession.project_key),
      };
    case "verification": {
      const payloadCommand = readPayloadString(event, "verification_command");
      const verificationCommand =
        payloadCommand ??
        (isUsefulVerificationText(event.summary) ? extractCommandFromText(event.summary) : null);

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
      const compressedFix = compressMarkdownHeavySummary(fix.summary);
      let statement: string;
      if (compressedFix !== null) {
        statement =
          command === undefined
            ? `In ${compressedFix.file}, ${compressedFix.action}; verified.`
            : `In ${compressedFix.file}, ${compressedFix.action}; verified with ${formatCommand(command)}.`;
      } else {
        const normalizedFix = normalizeWorkflowStatement(fix.summary);
        const fixPrefix = startsWithPastTenseVerb(normalizedFix) ? "" : "Fixed ";
        statement = `${fixPrefix}${lowercaseFirst(normalizedFix)}; verified${command === undefined ? "" : ` with ${formatCommand(command)}`}.`;
      }
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
      trigger: errorSignatureTrigger(failure.summary, input.sourceSession.project_key),
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
    if (fix && file) {
      const compressedFix = compressMarkdownHeavySummary(fix.summary);
      const fileForStatement = compressedFix?.file.trim() ? compressedFix.file : file.trim();

      if (fileForStatement.length > 0) {
        let statement: string | null;

        if (compressedFix !== null) {
          const normalizedFix = lowercaseFirst(normalizeFixSummary(fix.summary));
          if (!compressedFix.file.trim() && looksLikeProcessNarration(normalizedFix)) {
            statement = null;
          } else {
            statement = `In ${fileForStatement}, ${compressedFix.action}.`;
          }
        } else {
          const normalizedFix = lowercaseFirst(normalizeFixSummary(fix.summary));
          statement = looksLikeProcessNarration(normalizedFix)
            ? null
            : `In ${fileForStatement}, ${normalizedFix}.`;
        }

        if (statement !== null) {
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

function extractConcreteTurnFallbackCandidates(
  input: ExtractLearningsInput,
): ProjectLearningCandidate[] {
  const candidates: ProjectLearningCandidate[] = [];

  for (const [index, turn] of input.turns.entries()) {
    const promptForClassification = sanitizeUserPrompt(turn.user_prompt) || turn.user_prompt;

    if (
      looksLikeSkillHarnessLeak(promptForClassification) ||
      isNoSignalPrompt(promptForClassification) ||
      looksLikeProcessNarration(promptForClassification) ||
      looksLikePromptInstruction(promptForClassification)
    ) {
      continue;
    }

    const commands = usefulCommandsForTurn(turn, []);
    const files = usefulFilesForTurn(turn, []);

    if (commands.length === 0 && files.length === 0) {
      continue;
    }

    const file = files[0];
    const task = isConcreteProjectPrompt(promptForClassification)
      ? promptContextLine(turn.user_prompt)
      : classifyWorkflowTarget(promptForClassification);

    if (task === "this project") {
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

    let statement: string | null = null;
    let evidence: string[];

    if (command !== null) {
      statement = file
        ? `Use ${formatCommand(command)} when working on ${file} in ${input.sourceSession.project_key}.`
        : `Use ${formatCommand(command)} for ${task} in ${input.sourceSession.project_key}.`;
      evidence = learningEvidenceFromPrompt(turn.user_prompt, command);
    } else if (file !== undefined && isConcreteProjectPrompt(promptForClassification)) {
      statement = `When working on ${task}, inspect ${file} in ${input.sourceSession.project_key}.`;
      evidence = learningEvidenceFromPrompt(turn.user_prompt, file);
    } else {
      continue;
    }

    candidates.push({
      confidence: "medium",
      dedupeKey: `turn-fallback:${statement.toLowerCase()}`,
      evidence,
      kind: "workflow",
      learningId: `${input.sourceSession.session_id}:project:turn-fallback:${index}`,
      promotionBasis:
        "Derived from project-specific command or file usage when no structured events were extracted.",
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
function looksLikePromptInstruction(prompt: string): boolean {
  return (
    /\b(?:re-read|review|update|edit|change)\b.*\bONLY\b/i.test(prompt) ||
    /^\s*When working on\b/i.test(prompt)
  );
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
    if (looksLikePastedDocumentLine(line)) {
      continue;
    }

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

function looksLikePastedDocumentLine(line: string): boolean {
  return /^\d+\t/.test(line) || /^\d+\s*\|/.test(line) || /^\d+\s*#/.test(line);
}

function splitPromptLines(prompt: string): string[] {
  return prompt
    .split(/\r?\n+/)
    .map((line) => line.replace(/^[\s\-*]+/, "").trim())
    .filter((line) => line.length > 0);
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

function isWorkflowPrompt(prompt: string): boolean {
  return /\b(?:worktree|setup|prune|test|tests|performance|example|fixture|script|plan|strategy)\b/i.test(
    prompt,
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
  if (setupCommand !== undefined && isWorkflowPrompt(prompt)) {
    return setupCommand;
  }

  const commitCommand = commands.find((command) => /^git commit\b/i.test(command));
  if (commitCommand !== undefined && /\bcommit\b/i.test(prompt)) {
    return commitCommand;
  }

  return null;
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
    /^(got it|sure thing|sure[,!.]|absolutely[,!.]|of course[,!.]|great question|happy to help|no problem)\b/.test(
      normalized,
    ) ||
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

function cleanActionSegment(value: string): string {
  return value
    .replace(/^[\w.]+:\s*['"][^'"]+['"]\s*[-–—]\s*/, "")
    .replace(/^['"][^'"]+['"]\s*[-–—]\s*/, "")
    .trim();
}

function extractActionFromMarkdownSegment(segment: string): string {
  const separators = [
    ...segment.matchAll(/(?<=\S)\s+[-–—]\s+(?=\S)/g),
    ...segment.matchAll(/:\s+/g),
  ].sort((left, right) => (left.index ?? 0) - (right.index ?? 0));

  const changeVerbPattern =
    /\b(?:use|add|remove|replace|switch|configure|implement|migrate|upgrade|fix|set|change|move|prefer|avoid|keep|run|pre-?bundle|pre-?load|enable|disable)\b/i;

  for (const separator of separators) {
    const after = segment.slice((separator.index ?? 0) + separator[0].length).trim();
    if (changeVerbPattern.test(after)) {
      return cleanActionSegment(after);
    }
  }

  return cleanActionSegment(segment);
}

function compressMarkdownHeavySummary(value: string): { action: string; file: string } | null {
  const trimmed = value.trim();
  if (!hasExcessiveMarkdownStructure(trimmed)) {
    return null;
  }

  const normalized = trimmed
    .replace(/\[(.*?)\]\(.*?\)/g, "$1")
    .replace(/`/g, "")
    .replace(/\*\*/g, "")
    .replace(/#{1,6}\s+/g, "")
    .replace(
      /\b(?:Summary of changes|Summary of what changed|Implemented|Verification noted)\s*:?\s*/gi,
      "",
    )
    .trim();

  type FileMatch = { file: string; index: number };
  const fileMatches: FileMatch[] = [];
  const words = normalized.split(/\s+/);
  let charIndex = 0;
  for (const word of words) {
    const cleaned = word.replace(/^[("']+/, "").replace(/[.,;:!?()]+$/, "");
    const path = normalizeFilePath(cleaned);
    if (path !== null && /[\\/]/.test(path)) {
      fileMatches.push({ file: path, index: charIndex });
    }
    charIndex += word.length + 1;
  }

  if (fileMatches.length === 0) {
    return null;
  }

  const firstFile = fileMatches[0];
  if (firstFile === undefined || firstFile.file.trim().length === 0) {
    return null;
  }
  const regionEnd =
    fileMatches.length > 1 ? (fileMatches[1]?.index ?? normalized.length) : normalized.length;
  const region = normalized.slice(firstFile.index + firstFile.file.length, regionEnd).trim();

  const clauses = region
    .split(/\s+(?:[-•*]|–|—)\s+/)
    .map((clause) => clause.replace(/^\s*[:\-–—]\s*/, "").trim())
    .filter((clause) => clause.length > 0);

  const changeVerbPattern =
    /\b(?:use|add|remove|replace|switch|configure|implement|migrate|upgrade|fix|set|change|move|prefer|avoid|keep|run|pre-?bundle|pre-?load|enable|disable)\b/i;

  const actions: string[] = [];
  for (const clause of clauses) {
    const action = extractActionFromMarkdownSegment(clause);
    const cleanedAction = action
      .replace(
        new RegExp(`\\b${firstFile.file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"),
        "",
      )
      .trim();
    if (cleanedAction.length >= 5 && changeVerbPattern.test(cleanedAction)) {
      actions.push(cleanedAction);
    }
  }

  if (actions.length === 0) {
    return null;
  }

  const action = actions.join("; ").replace(/\s+/g, " ").trim();
  if (action.length < 10 || action.length > 160) {
    return null;
  }

  return { action: lowercaseFirst(action), file: firstFile.file };
}
function looksLikeRawKnowledgeDump(value: string): boolean {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return false;
  }

  if (
    (trimmed.startsWith("{") || trimmed.startsWith("[")) &&
    /"(?:findings|severity|verdict|file|line)"/.test(trimmed)
  ) {
    return true;
  }

  if (
    trimmed.includes("Traceback (most recent call last)") ||
    trimmed.includes("\n    at ") ||
    (/Error: /.test(trimmed) && trimmed.includes("\n")) ||
    trimmed.includes("npm ERR!") ||
    trimmed.includes("pnpm ERR!") ||
    ((trimmed.includes("ECONNRESET") || trimmed.includes("ENOENT") || trimmed.includes("EACCES")) &&
      trimmed.includes("\n"))
  ) {
    return true;
  }

  if (
    trimmed.includes("Base directory for this skill") ||
    trimmed.includes("/SKILL.md") ||
    trimmed.includes("<skill") ||
    trimmed.includes("Use when:") ||
    trimmed.includes("Triggers:") ||
    trimmed.includes("Description:")
  ) {
    return true;
  }

  if (hasExcessiveMarkdownStructure(trimmed)) {
    return true;
  }

  const normalized = trimmed.replace(/\s+/g, " ").trim();
  if (normalized.length > 420) {
    const leadingWindow = normalized.slice(0, 180);
    const hasProjectLocalPath =
      /\b(?:src|lib|app|server|scripts|tools|docs|tests?|api|core|shared|desktop|mobile)\/[^\s]+/i.test(
        leadingWindow,
      );
    const hasImperativePhrase = /\b(?:use|keep|avoid|run|configure|prefer|move|add|remove)\b/i.test(
      leadingWindow,
    );
    return !(hasProjectLocalPath && hasImperativePhrase);
  }

  return false;
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

// Dedupe-key prefixes whose candidates are backed by observed fix/verification
// evidence rather than a heuristic inference (see ProjectLearningCandidate).
const verifiedDedupePrefixes = [
  "verified-fix:",
  "completion:",
  "verification:",
  "error-resolution:",
];

function deriveProjectEvidenceType(candidate: ProjectLearningCandidate): EvidenceType {
  return verifiedDedupePrefixes.some((prefix) => candidate.dedupeKey.startsWith(prefix))
    ? "verified"
    : "inferred";
}

// Known Node/libuv/POSIX errno codes. An allowlist (not a denylist) so that
// ordinary all-caps E-words in failure text — EXPECTED, EXAMPLE, EXTERNAL,
// ENABLED, EXPORTS — are never mistaken for an errno signature.
const KNOWN_ERRNO_CODES: ReadonlySet<string> = new Set([
  "EACCES",
  "EADDRINUSE",
  "EADDRNOTAVAIL",
  "EAGAIN",
  "EBADF",
  "EBUSY",
  "ECANCELED",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EEXIST",
  "EFAULT",
  "EFBIG",
  "EHOSTUNREACH",
  "EINTR",
  "EINVAL",
  "EIO",
  "EISDIR",
  "ELOOP",
  "EMFILE",
  "EMLINK",
  "ENAMETOOLONG",
  "ENETDOWN",
  "ENETUNREACH",
  "ENFILE",
  "ENOBUFS",
  "ENODEV",
  "ENOENT",
  "ENOMEM",
  "ENOSPC",
  "ENOSYS",
  "ENOTCONN",
  "ENOTDIR",
  "ENOTEMPTY",
  "ENOTFOUND",
  "ENOTSOCK",
  "ENOTSUP",
  "ENXIO",
  "EOPNOTSUPP",
  "EOVERFLOW",
  "EPERM",
  "EPIPE",
  "EPROTO",
  "EPROTONOSUPPORT",
  "EPROTOTYPE",
  "ERANGE",
  "EROFS",
  "ESHUTDOWN",
  "ESPIPE",
  "ESRCH",
  "ETIMEDOUT",
  "EXDEV",
]);

// Tier-1 MVP precondition: deterministic, kind-derived. No LLM. The future
// LLM-recall pass (per the classification contract) refines these in place.
// Tier-3b: normalize a failure summary to a canonical symptom signature so the
// same error keys to the same trigger — and thus the same durable Instinct id —
// across sessions. Returns null when no recognizable signature is present.
function normalizeErrorSignature(text: string): string | null {
  for (const match of text.matchAll(/\b(E[A-Z]{2,})\b/g)) {
    const code = match[1];
    if (code !== undefined && KNOWN_ERRNO_CODES.has(code)) {
      return code;
    }
  }
  const exception = text.match(/\b([A-Z][A-Za-z0-9]*(?:Error|Exception))\b/)?.[1];
  if (exception !== undefined) {
    return exception;
  }
  const exitCode = text.match(/\bexit(?:ed with)?(?:\s+status)?\s+code\s+(\d+)\b/i)?.[1];
  if (exitCode !== undefined) {
    return `exit code ${exitCode}`;
  }
  return null;
}

function errorSignatureTrigger(summary: string, scopeKey: string): string | undefined {
  const signature = normalizeErrorSignature(summary);
  return signature === null ? undefined : `When ${signature} recurs in ${scopeKey}.`;
}

function deriveProjectTrigger(kind: LearningKind, scopeKey: string): string {
  switch (kind) {
    case "verification_rule":
      return `When verifying changes in ${scopeKey}.`;
    case "failure_mode":
      return `When the same failure recurs in ${scopeKey}.`;
    case "decision":
      return `When revisiting related design decisions in ${scopeKey}.`;
    case "pattern":
      return `When editing the affected files in ${scopeKey}.`;
    case "dead_end":
      return `When tempted to try the same approach in ${scopeKey}.`;
    default:
      return `When running the same workflow in ${scopeKey}.`;
  }
}

// First whitespace-delimited token of a command, lowercased ("git push" -> "git").
function commandHead(command: string): string {
  return command.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
}

// Tier-2 subject detection: deterministic command-tool and file-extension maps.
const commandToolTechnology: Record<string, string> = {
  git: "git",
  gh: "git",
  npm: "npm",
  pnpm: "pnpm",
  yarn: "yarn",
  bun: "bun",
  node: "node",
  uv: "uv",
  python: "python",
  python3: "python",
  cargo: "rust",
  go: "go",
  docker: "docker",
  sqlite3: "sqlite",
  just: "just",
  make: "make",
  tsc: "typescript",
  biome: "biome",
  vitest: "vitest",
  pytest: "pytest",
};

const fileExtensionTechnology: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  go: "go",
  rs: "rust",
  swift: "swift",
  kt: "kotlin",
  java: "java",
  c: "c",
  cc: "cpp",
  cpp: "cpp",
  h: "c",
  hpp: "cpp",
  sql: "sql",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  md: "markdown",
};

function extractTechnologies(turns: readonly Turn[]): string[] {
  const technologies = new Set<string>();
  for (const turn of turns) {
    for (const command of turn.commands_seen) {
      const tech = commandToolTechnology[commandHead(command)];
      if (tech !== undefined) {
        technologies.add(tech);
      }
    }
    for (const file of turn.files_touched) {
      const ext = file.split(".").pop()?.toLowerCase() ?? "";
      const tech = fileExtensionTechnology[ext];
      if (tech !== undefined) {
        technologies.add(tech);
      }
    }
  }
  return [...technologies].sort();
}

// Capability detection: deterministic command -> harness-skill lookup. First
// matching rule wins per command; results are unioned across the session.
const skillRefRules: Array<{ pattern: RegExp; skill: string }> = [
  { pattern: /\bgit\s+worktree\b/, skill: "using-git-worktrees" },
  { pattern: /^wt\b/, skill: "using-git-worktrees" },
  { pattern: /^td\b/, skill: "td-task-management" },
  { pattern: /^gh\b[\s\S]*\bpr\b/, skill: "git" },
  { pattern: /^git\s+(?:commit|push|merge|rebase)\b/, skill: "git" },
  { pattern: /\b(?:bun test|vitest|pytest|npm test|uv run pytest)\b/, skill: "tdd-guide" },
];

function deriveSkillRefs(turns: readonly Turn[]): string[] {
  const skills = new Set<string>();
  for (const turn of turns) {
    for (const command of turn.commands_seen) {
      const normalized = command.trim().toLowerCase();
      const match = skillRefRules.find((rule) => rule.pattern.test(normalized));
      if (match !== undefined) {
        skills.add(match.skill);
      }
    }
  }
  return [...skills].sort();
}

function finalizeProjectLearningCandidate(
  candidate: ProjectLearningCandidate,
): ProjectLearningCandidate | null {
  const rawStatement = sanitizeHarnessLeakText(candidate.statement);
  const cleanedForDumpCheck = sanitizeLearningStatement(rawStatement, { preserveNewlines: true });
  if (
    cleanedForDumpCheck.length === 0 ||
    looksLikeSkillHarnessLeak(cleanedForDumpCheck) ||
    looksLikeRawKnowledgeDump(cleanedForDumpCheck)
  ) {
    return null;
  }

  const statement = cleanedForDumpCheck.replace(/\s+/g, " ").trim();

  if (/^In\s*,/i.test(statement)) {
    return null;
  }

  // Reject multi-sentence assistant narratives unless they are verified-fix
  // workflow patterns, which legitimately join action and verification clauses.
  const isVerifiedFixWorkflow =
    candidate.kind === "workflow" && candidate.dedupeKey.startsWith("verified-fix:");
  if (!isVerifiedFixWorkflow && !isAtomicStatement(statement)) {
    return null;
  }

  // Apply a hard statement-length ceiling.
  const maxStatementLength = 240;
  const finalStatement =
    statement.length > maxStatementLength
      ? `${statement.slice(0, maxStatementLength - 3).trimEnd()}...`
      : statement;

  const evidence = uniqueStrings(
    candidate.evidence
      .map((item) => capEvidenceText(sanitizeHarnessLeakText(item)))
      .filter((item) => item.length > 0 && !looksLikeSkillHarnessLeak(item)),
  );

  const titleBodyMax =
    candidate.kind === "decision" || candidate.title.startsWith("Decision:") ? 72 : 60;
  const title = sanitizeLearningTitle(candidate.title, finalStatement, titleBodyMax);
  if (title.length === 0 || looksLikeSkillHarnessLeak(title)) {
    return null;
  }

  return {
    ...candidate,
    evidence: evidence.length > 0 ? evidence : [capEvidenceText(finalStatement)],
    statement: finalStatement,
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
    case "dead_end":
      return 22;
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

  if (looksLikeProcessNarration(statement) || looksLikeRawKnowledgeDump(statement)) {
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
