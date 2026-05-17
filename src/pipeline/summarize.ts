import type { Event, Learning, SourceSession, Summary, Turn } from "../models/canonical.js";
import { summarySchema } from "../models/canonical.js";

export type SummarizeSessionInput = {
  deletionReadiness?: string;
  events: readonly Event[];
  projectLearnings?: readonly Learning[];
  sourceSession: SourceSession;
  turns: readonly Turn[];
  userLearnings?: readonly Learning[];
};

export function summarizeSession(input: SummarizeSessionInput): Summary {
  const decisions = uniquePreservingOrder(
    input.events
      .filter((event) => event.type === "decision")
      .map((event) => normalizeSummaryLine(event.summary))
  );
  const failures = uniquePreservingOrder(
    input.events
      .filter((event) => event.type === "failure")
      .map((event) => normalizeSummaryLine(event.summary))
  );
  const fixes = summarizeWorkedOutcomes(input.events);
  const nextStep = selectNextStep(input.events);
  const usefulCommands = uniquePreservingOrder(
    [
      ...input.turns.flatMap((turn) => turn.commands_seen),
      ...input.events.flatMap((event) => collectEventCommands(event))
    ]
      .filter((command) => isUsefulCommand(command))
      .map((command) => normalizeSummaryLine(command))
  ).slice(0, 6);
  const filesOfInterest = uniquePreservingOrder(
    [
      ...input.turns.flatMap((turn) => turn.files_touched),
      ...input.events.flatMap((event) => collectEventFiles(event))
    ]
      .filter((filePath) => filePath.trim().length > 0)
      .filter((filePath) => isUsefulFilePath(filePath))
  ).slice(0, 6);
  const summary = {
    deletion_readiness: input.deletionReadiness ?? "not_ready",
    files_of_interest: filesOfInterest,
    next_step: normalizeSummaryLine(nextStep),
    project_learnings: uniquePreservingOrder(
      (input.projectLearnings ?? []).map((learning) => learning.statement)
    ),
    session_id: input.sourceSession.session_id,
    topic: deriveTopic(input.sourceSession, input.turns),
    useful_commands: usefulCommands,
    user_learnings: uniquePreservingOrder((input.userLearnings ?? []).map((learning) => learning.statement)),
    what_failed: failures,
    what_was_decided: decisions,
    what_worked: fixes
  } satisfies Summary;

  return summarySchema.parse(summary);
}

function deriveTopic(sourceSession: SourceSession, turns: readonly Turn[]): string {
  const prompt = turns[0]?.user_prompt.trim() ?? "";

  if (prompt.length > 0) {
    const topicLine = selectTopicLine(prompt);
    return truncateInline(topicLine, 120);
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
      .map((event) => summarizeOutcome(event))
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
  return readPayloadStringArray(event, "command_strings").filter((value) => looksLikeSourcePath(value));
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

  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
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

function normalizeSummaryLine(value: string): string {
  return truncateInline(value.replace(/\s+/g, " ").trim(), 180);
}

function selectTopicLine(prompt: string): string {
  const lines = prompt
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (const line of lines) {
    if (isPromptNoiseLine(line)) {
      continue;
    }

    return line;
  }

  return prompt;
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

function isUsefulCommand(command: string): boolean {
  const normalized = command.trim().toLowerCase();

  if (normalized.length === 0) {
    return false;
  }

  return (
    /^(?:\.\/[\w./-]+|(?:npm|pnpm|yarn|bun|node|python3?|uv|git|just|make|cargo|go|docker|sqlite3)\b)/i.test(command.trim()) &&
    !["node", "python", "python3"].includes(normalized)
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
  return /\.(?:[cm]?[jt]sx?|py|go|rs|swift|kt|java|c|cc|cpp|h|hpp|json|ya?ml|toml|md|sql)$/i.test(value);
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
