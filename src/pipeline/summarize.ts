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
  const fixes = uniquePreservingOrder(
    input.events
      .filter((event) => event.type === "fix" || isPositiveVerification(event))
      .map((event) => normalizeSummaryLine(event.summary))
  );
  const nextStep =
    [...input.events]
      .reverse()
      .find((event) => event.type === "next_step")
      ?.summary ?? "No explicit next step recorded.";
  const usefulCommands = uniquePreservingOrder(
    input.turns
      .flatMap((turn) => turn.commands_seen)
      .filter((command) => isUsefulCommand(command))
      .map((command) => normalizeSummaryLine(command))
  ).slice(0, 6);
  const filesOfInterest = uniquePreservingOrder(
    input.turns
      .flatMap((turn) => turn.files_touched)
      .filter((filePath) => filePath.trim().length > 0)
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

  return !["node", "python", "python3"].includes(normalized);
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
