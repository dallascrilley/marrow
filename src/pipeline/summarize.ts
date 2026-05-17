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
    input.events.filter((event) => event.type === "decision").map((event) => event.summary)
  );
  const failures = uniquePreservingOrder(
    input.events.filter((event) => event.type === "failure").map((event) => event.summary)
  );
  const fixes = uniquePreservingOrder(
    input.events
      .filter((event) => event.type === "fix" || isPositiveVerification(event))
      .map((event) => event.summary)
  );
  const nextStep =
    input.events.find((event) => event.type === "next_step")?.summary ?? "No explicit next step recorded.";
  const usefulCommands = uniquePreservingOrder(
    input.turns.flatMap((turn) => turn.commands_seen).filter((command) => command.trim().length > 0)
  );
  const filesOfInterest = uniquePreservingOrder(
    input.turns.flatMap((turn) => turn.files_touched).filter((filePath) => filePath.trim().length > 0)
  );
  const summary = {
    deletion_readiness: input.deletionReadiness ?? "not_ready",
    files_of_interest: filesOfInterest,
    next_step: nextStep,
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
    return truncateInline(prompt, 120);
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
