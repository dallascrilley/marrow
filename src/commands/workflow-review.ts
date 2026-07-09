import type { DatabaseSync } from "node:sqlite";

import type { CommandContext } from "../cli.js";
import { appendWorkflowDecision } from "../workflow/decisions.js";
import { mineWorkflowCandidates } from "../workflow/mine.js";
import type { WorkflowCandidate } from "../workflow/schema.js";

const DECISION_LOOKUP_LIMIT = Number.MAX_SAFE_INTEGER;
const MAX_DECISION_NOTE_CHARS = 500;

type CommonOptions = {
  days: number;
  json: boolean;
  source: string | null;
};

type DecisionOptions = CommonOptions & {
  candidateId: string;
  note?: string;
};

export async function executeWorkflowReview(
  context: CommandContext,
  database: DatabaseSync,
): Promise<number> {
  const options = parseCommonOptions(context.args);
  const result = await mineWorkflowCandidates({
    database,
    days: options.days,
    source: options.source,
  });
  if (options.json) {
    context.output.info(JSON.stringify(result, null, 2));
    return 0;
  }
  context.output.info(`Undecided workflow candidates: ${result.candidates.length}`);
  for (const candidate of result.candidates) {
    context.output.info(
      `${candidate.candidate_id}\t${candidate.rule_id}\t${candidate.confidence}\t${candidate.recommendation}\t${candidate.cluster}`,
    );
  }
  return 0;
}

export async function executeWorkflowShow(
  context: CommandContext,
  database: DatabaseSync,
): Promise<number> {
  const options = parseShowOptions(context.args);
  const result = await mineWorkflowCandidates({
    database,
    days: options.days,
    includeDecided: true,
    limit: DECISION_LOOKUP_LIMIT,
    source: options.source,
  });
  const candidate = result.candidates.find((item) => item.candidate_id === options.candidateId);
  if (!candidate) {
    throw new Error(`Workflow candidate not found: ${options.candidateId}`);
  }
  if (options.json) {
    context.output.info(JSON.stringify(candidate, null, 2));
    return 0;
  }
  context.output.info(formatCandidateDetail(candidate));
  return 0;
}

export async function executeWorkflowAdopt(
  context: CommandContext,
  database: DatabaseSync,
): Promise<number> {
  return executeWorkflowDecision(context, database, "adopt");
}

export async function executeWorkflowDismiss(
  context: CommandContext,
  database: DatabaseSync,
): Promise<number> {
  return executeWorkflowDecision(context, database, "dismiss");
}

export async function executeWorkflowDefer(
  context: CommandContext,
  database: DatabaseSync,
): Promise<number> {
  return executeWorkflowDecision(context, database, "defer");
}

async function executeWorkflowDecision(
  context: CommandContext,
  database: DatabaseSync,
  decision: "adopt" | "dismiss" | "defer",
): Promise<number> {
  const options = parseDecisionOptions(context.args);
  const result = await mineWorkflowCandidates({
    database,
    days: options.days,
    includeDecided: true,
    limit: DECISION_LOOKUP_LIMIT,
    source: options.source,
  });
  const candidate = result.candidates.find((item) => item.candidate_id === options.candidateId);
  if (!candidate) {
    throw new Error(`Workflow candidate not found: ${options.candidateId}`);
  }
  const entry = await appendWorkflowDecision({
    candidate_id: candidate.candidate_id,
    decision,
    ...(options.note ? { note: sanitizeDecisionNote(options.note) } : {}),
    rule_id: candidate.rule_id,
  });
  context.output.info(JSON.stringify(entry, null, 2));
  return 0;
}

function formatCandidateDetail(candidate: WorkflowCandidate): string {
  const evidence = candidate.evidence_sessions
    .map(
      (item) =>
        `- ${item.asd_session_id} ${item.evidence_kind} ${item.matched_rule_id}: ${item.excerpt}`,
    )
    .join("\n");
  return [
    `Candidate: ${candidate.candidate_id}`,
    `Rule: ${candidate.rule_id}`,
    `Cluster: ${candidate.cluster}`,
    `Confidence: ${candidate.confidence}`,
    `Recommendation: ${candidate.recommendation}`,
    `Artifact: ${candidate.artifact_kind}`,
    `Trigger: ${candidate.trigger}`,
    `Guidance: ${candidate.guidance}`,
    `Evidence: ${candidate.supporting_count} supporting, ${candidate.contradicting_count} contradicting, ${candidate.evidence_count} total`,
    evidence.length > 0 ? evidence : "Evidence: none",
    candidate.decision
      ? `Decision: ${candidate.decision.decision} at ${candidate.decision.decided_at}${candidate.decision.note ? `\nDecision note: ${candidate.decision.note}` : ""}`
      : "Decision: undecided",
  ].join("\n");
}

function sanitizeDecisionNote(note: string): string {
  const redacted = note
    .replace(/(?:[A-Za-z]:)?\/?(?:Users|home)\/[^\s]+/g, "[local-path]")
    .replace(/\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)\b\s*[=:]\s*\S+/gi, "[secret-ref]")
    .replace(/\s+/g, " ")
    .trim();
  return redacted.length <= MAX_DECISION_NOTE_CHARS
    ? redacted
    : `${redacted.slice(0, MAX_DECISION_NOTE_CHARS - 1).trimEnd()}…`;
}

function parseCommonOptions(args: string[]): CommonOptions {
  let days = 7;
  let json = false;
  let source: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--days" || arg?.startsWith("--days=")) {
      const value = arg === "--days" ? args[index + 1] : arg?.slice("--days=".length);
      if (!value || value.startsWith("--")) throw new Error("--days requires a value");
      days = Number.parseInt(value, 10);
      if (!Number.isFinite(days) || days < 1) throw new Error("--days must be a positive integer");
      if (arg === "--days") index += 1;
      continue;
    }
    if (arg === "--source" || arg?.startsWith("--source=")) {
      const value = arg === "--source" ? args[index + 1] : arg?.slice("--source=".length);
      if (!value || value.startsWith("--")) throw new Error("--source requires a value");
      source = value;
      if (arg === "--source") index += 1;
      continue;
    }
    throw new Error(`Unknown flag: ${arg}`);
  }
  return { days, json, source };
}

function parseShowOptions(args: string[]): DecisionOptions {
  const candidateId = args[0];
  if (!candidateId || candidateId.startsWith("--"))
    throw new Error("workflow show requires a candidate id");
  return { ...parseCommonOptions(args.slice(1)), candidateId };
}

function parseDecisionOptions(args: string[]): DecisionOptions {
  const candidateId = args[0];
  if (!candidateId || candidateId.startsWith("--"))
    throw new Error("workflow decision requires a candidate id");
  let note: string | undefined;
  const filtered: string[] = [];
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--note" || arg?.startsWith("--note=")) {
      const value = arg === "--note" ? args[index + 1] : arg?.slice("--note=".length);
      if (!value || value.startsWith("--")) throw new Error("--note requires a value");
      note = value;
      if (arg === "--note") index += 1;
      continue;
    }
    if (arg) filtered.push(arg);
  }
  return { ...parseCommonOptions(filtered), candidateId, ...(note ? { note } : {}) };
}
