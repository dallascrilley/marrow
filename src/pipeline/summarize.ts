import type { Event, Learning, SourceSession, Summary, Turn } from "../models/canonical.js";
import { summarySchema } from "../models/canonical.js";
import { generateTopicWithOpenRouter } from "./llm-learning-review.js";
import {
  extractSubstantivePrompt,
  firstSubstantivePromptFromTurns,
  isHarnessOrBootLine,
  isNoSignalPrompt,
  isSkillWrapperOnlyPrompt,
  looksLikeSkillHarnessLeak,
  sanitizeHarnessLeakText,
  stripAssistantFraming,
} from "./prompt-sanitize.js";

type TopicSource = "deterministic" | "llm";

export type LlmTopicGenerator = (input: {
  deterministicTopic: string;
  sourceSession: SourceSession;
  turns: readonly Turn[];
}) => Promise<string>;

export type SummarizeSessionInput = {
  deletionReadiness?: string;
  events: readonly Event[];
  projectLearnings?: readonly Learning[];
  sourceSession: SourceSession;
  turns: readonly Turn[];
  userLearnings?: readonly Learning[];
};

export type OptionalLlmTopicOptions = {
  generateTopic?: LlmTopicGenerator | undefined;
  llmTopic?: boolean | undefined;
};

export function summarizeSession(input: SummarizeSessionInput): Summary {
  return summarizeSessionWithTopic(input, {
    topic: deriveTopic(input.sourceSession, input.turns),
    topicSource: "deterministic",
  });
}

export function shouldAttemptLlmTopic(
  sourceSession: SourceSession,
  turns: readonly Turn[],
  llmTopicEnabled: boolean,
): boolean {
  return llmTopicEnabled === true && isLowSignalTopic(deriveTopic(sourceSession, turns));
}

export async function summarizeSessionWithOptionalLlmTopic(
  input: SummarizeSessionInput,
  options: OptionalLlmTopicOptions = {},
): Promise<Summary> {
  const deterministicTopic = deriveTopic(input.sourceSession, input.turns);
  if (options.llmTopic !== true || !isLowSignalTopic(deterministicTopic)) {
    return summarizeSessionWithTopic(input, {
      topic: deterministicTopic,
      topicSource: "deterministic",
    });
  }

  const generateTopic = options.generateTopic ?? generateTopicWithOpenRouter;
  try {
    const llmTopic = normalizeGeneratedTopic(
      await generateTopic({
        deterministicTopic,
        sourceSession: input.sourceSession,
        turns: input.turns,
      }),
    );

    return summarizeSessionWithTopic(input, {
      topic: llmTopic,
      topicSource: "llm",
    });
  } catch (error) {
    // An optional title enhancer must never break core ingest: on any LLM failure
    // (network, rate limit, empty/invalid response), fall back to the deterministic topic.
    console.warn(`[asd] LLM topic generation failed; using deterministic topic (${String(error)})`);
    return summarizeSessionWithTopic(input, {
      topic: deterministicTopic,
      topicSource: "deterministic",
    });
  }
}

function summarizeSessionWithTopic(
  input: SummarizeSessionInput,
  topicInput: { topic: string; topicSource: TopicSource },
): Summary {
  const decisions = uniquePreservingOrder(
    input.events
      .filter((event) => event.type === "decision")
      .map((event) => normalizeSummaryLine(event.summary)),
  );
  const failures = uniquePreservingOrder(
    input.events
      .filter((event) => event.type === "failure")
      .map((event) => normalizeSummaryLine(event.summary)),
  );
  const fixes = summarizeWorkedOutcomes(input.events);
  const nextStep = selectNextStep(input.events);
  const usefulCommands = uniquePreservingOrder(
    [
      ...input.turns.flatMap((turn) => turn.commands_seen),
      ...input.events.flatMap((event) => collectEventCommands(event)),
    ]
      .filter((command) => isUsefulCommand(command))
      .map((command) => normalizeSummaryLine(command)),
  ).slice(0, 6);
  const filesOfInterest = uniquePreservingOrder(
    [
      ...input.turns.flatMap((turn) => turn.files_touched),
      ...input.events.flatMap((event) => collectEventFiles(event)),
    ]
      .filter((filePath) => filePath.trim().length > 0)
      .filter((filePath) => isUsefulFilePath(filePath)),
  ).slice(0, 6);
  const summary = {
    deletion_readiness: input.deletionReadiness ?? "not_ready",
    files_of_interest: filesOfInterest,
    next_step: normalizeSummaryLine(nextStep),
    project_learnings: uniquePreservingOrder(
      (input.projectLearnings ?? []).map((learning) => learning.statement),
    ),
    session_id: input.sourceSession.session_id,
    topic: topicInput.topic,
    topic_source: topicInput.topicSource,
    useful_commands: usefulCommands,
    user_learnings: uniquePreservingOrder(
      (input.userLearnings ?? []).map((learning) => learning.statement),
    ),
    what_failed: failures,
    what_was_decided: decisions,
    what_worked: fixes,
  } satisfies Summary;

  return summarySchema.parse(summary);
}

export function isLowSignalTopic(topic: string): boolean {
  const normalized = topic.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    return true;
  }

  if (isHarnessOrBootLine(normalized) || isHarnessTopicLine(normalized)) {
    return true;
  }

  if (/^Session summary for\b/i.test(normalized)) {
    return true;
  }

  if (/^Base directory for this skill\b/i.test(normalized)) {
    return true;
  }

  if (isGenericInitPrompt(normalized)) {
    return true;
  }

  if (looksLikePathOrPathInstruction(normalized)) {
    return true;
  }

  if (looksLikeBareCommand(normalized)) {
    return true;
  }

  if (isTooShortOrGeneric(normalized)) {
    return true;
  }

  if (looksLikeBareSkillSlugTopic(normalized)) {
    return true;
  }

  if (looksLikeSkillHarnessLeak(normalized)) {
    return true;
  }

  if (looksLikeMarkdownSkillHeaderTopic(normalized)) {
    return true;
  }

  if (looksLikeSlashCommandTopic(normalized)) {
    return true;
  }

  return false;
}

export function isWrapperLeakTopic(topic: string): boolean {
  const normalized = topic.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    return false;
  }

  return (
    looksLikeBareSkillSlugTopic(normalized) ||
    looksLikeSkillHarnessLeak(normalized) ||
    looksLikeMarkdownSkillHeaderTopic(normalized) ||
    looksLikeSlashCommandTopic(normalized) ||
    /^Session summary for\b/i.test(normalized) ||
    /^Base directory for this skill\b/i.test(normalized)
  );
}

function looksLikeMarkdownSkillHeaderTopic(topic: string): boolean {
  return /^#\s+[A-Za-z][^\n`]{0,120}$/.test(topic.trim());
}

function looksLikeSlashCommandTopic(topic: string): boolean {
  return /^\$[a-z][a-z0-9-]*(?:\s|$)/i.test(topic.trim());
}

function deriveTopic(sourceSession: SourceSession, turns: readonly Turn[]): string {
  const substantive = firstSubstantivePromptFromTurns(turns);

  if (substantive !== null && substantive.length > 0) {
    const topicLine = selectTopicLine(substantive);
    return truncateInline(topicLine, 120);
  }

  for (const turn of turns) {
    if (isSkillWrapperOnlyPrompt(turn.user_prompt)) {
      continue;
    }

    const fallback = extractSubstantivePrompt(turn.user_prompt);
    if (fallback !== null && fallback.length > 0 && !isNoSignalPrompt(fallback)) {
      return truncateInline(selectTopicLine(fallback), 120);
    }
  }

  return `Session summary for ${sourceSession.project_key}`;
}

function isPositiveVerification(event: Event): boolean {
  return (
    event.type === "verification" &&
    /verified|confirmed|tests? pass(?:ed)?|build succeeded|all checks passed/i.test(event.summary)
  );
}

function summarizeWorkedOutcomes(events: readonly Event[]): string[] {
  const fixes = events
    .filter((event) => event.type === "fix")
    .map((event) => summarizeOutcome(event));
  const completionOutcomes = events
    .filter((event) => event.type === "verification")
    .map((event) => summarizeCompletionOutcome(stripEventPrefix(event.summary)))
    .filter((outcome): outcome is string => outcome !== null)
    .map((outcome) => normalizeSummaryLine(outcome));

  if (completionOutcomes.length > 0) {
    return uniquePreservingOrder([...fixes, ...completionOutcomes]);
  }

  return uniquePreservingOrder(
    events
      .filter((event) => event.type === "fix" || isPositiveVerification(event))
      .map((event) => summarizeOutcome(event)),
  );
}

function summarizeOutcome(event: Event): string {
  const stripped = stripEventPrefix(event.summary);
  const completionOutcome = summarizeCompletionOutcome(stripped);

  if (completionOutcome !== null) {
    return normalizeSummaryLine(completionOutcome);
  }

  if (event.type === "verification") {
    return normalizeSummaryLine(`Verified: ${stripped}`);
  }

  return normalizeSummaryLine(stripped);
}

function summarizeCompletionOutcome(value: string): string | null {
  const doneMatch = value.match(/\*\*Done:\*\*\s*(.*?)(?:\s+\*\*Verified:\*\*\s*|$)(.*)$/i);

  if (doneMatch === null) {
    return null;
  }

  const doneText = doneMatch[1]?.trim();
  const verifiedText = doneMatch[2]?.trim() ?? "";

  if (doneText === undefined || doneText.length === 0) {
    return null;
  }

  const command = extractCommandFromText(verifiedText);
  const testEvidence = extractTestEvidence(verifiedText);
  const verifiedClause =
    command === null
      ? "verified"
      : `verified with ${formatCommand(command)}${testEvidence === null ? "" : ` (${testEvidence})`}`;

  return `Completed ${lowercaseFirst(stripTrailingPunctuation(doneText))}; ${verifiedClause}.`;
}

function selectNextStep(events: readonly Event[]): string {
  const latestActionableStep = [...events]
    .reverse()
    .filter((event) => event.type === "next_step")
    .map((event) => stripEventPrefix(event.summary))
    .find((summary) => !looksLikeCompletedOutcome(summary));

  if (latestActionableStep !== undefined) {
    return latestActionableStep;
  }

  if (events.some((event) => event.type === "fix" || isPositiveVerification(event))) {
    return "No open next step recorded.";
  }

  return "No explicit next step recorded.";
}

function collectEventCommands(event: Event): string[] {
  const commands: string[] = [];
  const verificationCommand = readPayloadString(event, "verification_command");

  if (verificationCommand !== null) {
    commands.push(verificationCommand);
  }

  commands.push(...readPayloadStringArray(event, "command_strings"));
  commands.push(...extractCommandsFromText(event.summary));

  return commands;
}

function collectEventFiles(event: Event): string[] {
  return readPayloadStringArray(event, "command_strings").filter((value) =>
    looksLikeSourcePath(value),
  );
}

function stripEventPrefix(value: string): string {
  return value.replace(/^Verification noted:\s*/i, "").trim();
}

function extractCommandsFromText(value: string): string[] {
  const commands: string[] = [];

  for (const match of value.matchAll(/`([^`\n]+)`/g)) {
    const candidate = match[1]?.trim();

    if (candidate !== undefined && isUsefulCommand(candidate)) {
      commands.push(candidate);
    }
  }

  return commands;
}

function extractCommandFromText(value: string): string | null {
  return extractCommandsFromText(value)[0] ?? null;
}

function formatCommand(command: string): string {
  return command.startsWith("`") && command.endsWith("`") ? command : `\`${command}\``;
}

function extractTestEvidence(value: string): string | null {
  const match = value.match(/\b(\d+\s+passed(?:,\s+\d+\s+skipped)?(?:,\s+\d+\s+failures?)?)/i);
  return match?.[1] ?? null;
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

function looksLikeCompletedOutcome(value: string): boolean {
  return (
    /\b(?:done|completed|implemented|fixed|resolved|merged|pushed)\b/i.test(value) &&
    /\b(?:verified|tests? pass(?:ed)?|all checks passed|0 failures)\b/i.test(value)
  );
}

function truncateInline(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

function normalizeGeneratedTopic(topic: string): string {
  const sanitized = sanitizeHarnessLeakText(topic);
  const normalized = (sanitized.length > 0 ? sanitized : topic)
    .replace(/^["']|["']$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length === 0) {
    throw new Error("LLM topic generation returned an empty topic");
  }

  return truncateInline(normalized, 120);
}

function normalizeSummaryLine(value: string): string {
  const sanitized = sanitizeHarnessLeakText(stripAssistantFraming(value));
  const normalized = (sanitized.length > 0 ? sanitized : value).replace(/\s+/g, " ").trim();
  return truncateInline(normalized, 180);
}

function selectTopicLine(prompt: string): string {
  const lines = prompt
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (const line of lines) {
    if (isPromptNoiseLine(line) || isHarnessTopicLine(line)) {
      continue;
    }

    return line;
  }

  return prompt;
}

function isHarnessTopicLine(line: string): boolean {
  return (
    /^#\s*(?:AGENTS|CLAUDE)\.md\b/i.test(line) ||
    /^(?:AGENTS|CLAUDE)\.md\s+instructions\s+for\b/i.test(line) ||
    /^(?:system[-_]reminder|environment_context|command-message|command-name|command-args|task-notification|local-command-(?:stdout|stderr)|user-prompt-submit-hook|bash-(?:input|stdout|stderr))\b/i.test(
      line,
    ) ||
    /^turn_aborted$/i.test(line) ||
    /^Caveat:/i.test(line) ||
    /^\[Request interrupted by user\b/i.test(line) ||
    /^\[Image:[^\]]+\]$/i.test(line) ||
    /^<\/?skill\b/i.test(line) ||
    /\/SKILL\.md\b/i.test(line)
  );
}

function isPromptNoiseLine(line: string): boolean {
  return (
    /^[✓✔]/.test(line) ||
    /^Test Files\b/i.test(line) ||
    /^Tests\b/i.test(line) ||
    /^Start at\b/i.test(line) ||
    /^Duration\b/i.test(line)
  );
}

function isGenericInitPrompt(topic: string): boolean {
  return (
    /^\/init\b/i.test(topic) ||
    /^init$/i.test(topic) ||
    (/^(?:please\s+)?(?:analyze|scan|inspect)\s+(?:this\s+)?(?:repo|repository|codebase)\b/i.test(
      topic,
    ) &&
      /\b(?:AGENTS|CLAUDE)\.md\b/i.test(topic))
  );
}

function looksLikePathOrPathInstruction(topic: string): boolean {
  if (/^(?:~\/|\/|\.{1,2}\/|[A-Za-z]:[\\/])\S+$/.test(topic)) {
    return true;
  }

  if (/^[\w.-]+(?:\/[\w .-]+)+\/?$/.test(topic)) {
    return true;
  }

  if (/^[\w./~-]+\.(?:md|json|jsonl|toml|yaml|yml|ts|tsx|js|mjs|py|sh|swift|txt)$/i.test(topic)) {
    return true;
  }

  return /^read\s+(?:\.agents-state\/handoff\.md|(?:~\/|\/|\.{1,2}\/|[\w.-]+\/)[^\s]+)\b/i.test(
    topic,
  );
}

function looksLikeBareCommand(topic: string): boolean {
  return /^(?:cd|ls|cat|sed|awk|rg|grep|git|gh|npm|pnpm|bun|node|python3?|uv|just|make|cargo|go|swift|xcodebuild|docker|curl)\b(?:\s|$)/i.test(
    topic,
  );
}

function looksLikeBareSkillSlugTopic(topic: string): boolean {
  const normalized = topic.trim();
  if (!/^[a-z][a-z0-9-]*$/i.test(normalized)) {
    return false;
  }

  if (
    /\b(?:fix|add|implement|export|session|index|test|build|merge|review|update|create|remove|delete|ingest|memory|vault|launch|proof|adapter|pipeline|command|cli)\b/i.test(
      normalized,
    )
  ) {
    return false;
  }

  return normalized.length <= 32;
}

function isTooShortOrGeneric(topic: string): boolean {
  const lower = topic.toLowerCase();
  const words = lower.match(/[a-z0-9]+/g) ?? [];
  if (words.length <= 1) {
    return true;
  }

  if (words.length <= 2) {
    const genericWords = new Set([
      "begin",
      "bug",
      "change",
      "changes",
      "continue",
      "debug",
      "fix",
      "help",
      "implement",
      "issue",
      "proceed",
      "question",
      "resume",
      "review",
      "start",
      "task",
      "test",
      "update",
      "work",
    ]);
    return words.every((word) => genericWords.has(word));
  }

  return /^(?:help with|work on|fix the|update the|continue the|review the|implement the|debug the|test the)\s+(?:task|code|project|repo|issue|bug|changes?)\.?$/i.test(
    lower,
  );
}

function isUsefulCommand(command: string): boolean {
  const normalized = command.trim().toLowerCase();

  if (normalized.length === 0) {
    return false;
  }

  return (
    /^(?:\.\/[\w./-]+|(?:npm|pnpm|yarn|bun|node|python3?|uv|git|just|make|cargo|go|docker|sqlite3)\b)/i.test(
      command.trim(),
    ) && !["node", "python", "python3"].includes(normalized)
  );
}

function isUsefulFilePath(filePath: string): boolean {
  const normalized = filePath.trim();

  if (/\/(?:\.codex\/worktrees|Code)\/[^/]+\/?$/.test(normalized)) {
    return false;
  }

  return looksLikeSourcePath(normalized);
}

function looksLikeSourcePath(value: string): boolean {
  return /\.(?:[cm]?[jt]sx?|py|go|rs|swift|kt|java|c|cc|cpp|h|hpp|json|ya?ml|toml|md|sql)$/i.test(
    value,
  );
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

function uniquePreservingOrder(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const uniqueValues: string[] = [];

  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }

    seen.add(value);
    uniqueValues.push(value);
  }

  return uniqueValues;
}
