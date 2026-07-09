import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { DatabaseSync } from "node:sqlite";

import { type Summary, summarySchema, type Turn, turnSchema } from "../models/canonical.js";
import { getReducedArtifactPath } from "../pipeline/reduce.js";
import { loadSessionIndexRecords, type SessionIndexRecord } from "../read/session-index.js";
import type {
  WorkflowArtifactKind,
  WorkflowCandidate,
  WorkflowCluster,
  WorkflowConfidence,
  WorkflowEvidence,
  WorkflowEvidenceKind,
  WorkflowMineResult,
  WorkflowRecommendation,
} from "./schema.js";

export type MineWorkflowOptions = {
  database?: DatabaseSync;
  days?: number;
  limit?: number;
  source?: string | null;
};

type CandidateSeed = {
  artifactKind: WorkflowArtifactKind;
  cluster: WorkflowCluster;
  evidence: WorkflowEvidence;
  guidance: string;
  kind: WorkflowEvidenceKind;
  trigger: string;
};

const DEFAULT_DAYS = 7;
const DEFAULT_LIMIT = 20;

const markerRules: Array<{
  artifactKind: WorkflowArtifactKind;
  cluster: WorkflowCluster;
  evidenceKind: WorkflowEvidenceKind;
  guidance: string;
  pattern: RegExp;
  trigger: string;
}> = [
  {
    artifactKind: "rule",
    cluster: "validation",
    evidenceKind: "explicit_preference",
    guidance: "Run the relevant verification before claiming behavior works or work is complete.",
    pattern: /\b(always|must|never)\b[^.?!]*(verify|test|cibuild|ci|proof|passes|green)/i,
    trigger: "Before claiming completion, merge readiness, or CI status.",
  },
  {
    artifactKind: "rule",
    cluster: "validation",
    evidenceKind: "contradiction",
    guidance: "Run the relevant verification before claiming behavior works or work is complete.",
    pattern: /\b(skip|without|no need)\b[^.?!]*(verify|verification|test|cibuild|ci|proof)/i,
    trigger: "Before claiming completion, merge readiness, or CI status.",
  },
  {
    artifactKind: "rule",
    cluster: "validation",
    evidenceKind: "correction",
    guidance:
      "Treat user corrections like “not what I asked” as scope failures and realign before continuing.",
    pattern: /\b(not what i asked|didn'?t ask|wrong task|stop doing|stop)\b/i,
    trigger:
      "When user feedback indicates the agent solved a different problem or kept going in the wrong direction.",
  },
  {
    artifactKind: "skill",
    cluster: "review",
    evidenceKind: "accepted_pattern",
    guidance:
      "Use an independent review or explicit self-review path before closing review-gated work.",
    pattern: /\b(review|reviewer|approve|reject|self-review|qa)\b/i,
    trigger: "When work enters a review-gated task, PR, or td issue closeout.",
  },
  {
    artifactKind: "workflow_doc",
    cluster: "shipping",
    evidenceKind: "accepted_pattern",
    guidance:
      "Keep shipping evidence tied to concrete commands, commits, PRs, and CI state rather than local claims.",
    pattern: /\b(pr|pull request|push|commit|ci|branch|merge|ship|shipping)\b/i,
    trigger: "When preparing a change for review, push, PR, or merge.",
  },
  {
    artifactKind: "skill",
    cluster: "debugging",
    evidenceKind: "accepted_pattern",
    guidance:
      "Debug from root cause and preserve the failing evidence before changing implementation.",
    pattern: /\b(debug|root cause|failure|failing|regression|logs?|trace)\b/i,
    trigger: "When tests, builds, runtime commands, or user reports expose a failure.",
  },
  {
    artifactKind: "rule",
    cluster: "capture",
    evidenceKind: "accepted_pattern",
    guidance:
      "Capture durable workflow corrections as skills, rules, docs, or reviewable candidates instead of leaving them only in chat.",
    pattern:
      /\b(create|write|update|encode|capture|mine|extract|generate)\b[^.?!]*(skill|rule|workflow|preference|memory)|\b(skill|rule|workflow)\b[^.?!]*(guidance|preference|artifact|doc)/i,
    trigger: "When a session contains reusable agent-behavior guidance.",
  },
  {
    artifactKind: "workflow_doc",
    cluster: "delegation",
    evidenceKind: "accepted_pattern",
    guidance:
      "Delegate only when it improves speed, quality, or independent verification; keep deterministic small edits inline.",
    pattern: /\b(subagent|delegate|parallel|reviewer|agent)\b/i,
    trigger:
      "When a task can be split across independent research, review, or implementation lanes.",
  },
  {
    artifactKind: "rule",
    cluster: "communication",
    evidenceKind: "explicit_preference",
    guidance:
      "Keep user-facing updates concise, evidence-first, and focused on decisions, checks, and residual risk.",
    pattern: /\b(concise|terse|brief|evidence|summary|final)\b/i,
    trigger: "When reporting progress, review findings, plans, or final status.",
  },
  {
    artifactKind: "rule",
    cluster: "simplification",
    evidenceKind: "accepted_pattern",
    guidance:
      "Prefer the smallest maintainable change and avoid adding abstractions before the existing pattern requires them.",
    pattern: /\b(simple|simplify|smallest|refactor|abstraction|over-?engineer)\b/i,
    trigger: "When choosing between a direct fix and a broader abstraction.",
  },
];

export async function mineWorkflowCandidates(
  options: MineWorkflowOptions = {},
): Promise<WorkflowMineResult> {
  const days = options.days ?? DEFAULT_DAYS;
  const limit = options.limit ?? DEFAULT_LIMIT;
  const source = options.source ?? null;
  const loadOptions = options.database
    ? { database: options.database, fallbackToBuild: true }
    : { fallbackToBuild: true };
  const records = await loadSessionIndexRecords(loadOptions);
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const filteredRecords = records.filter((record) => {
    const updatedAt = Date.parse(record.updated_at);
    return (
      (!source || record.source_tool === source) && !Number.isNaN(updatedAt) && updatedAt >= cutoff
    );
  });
  const seeds: CandidateSeed[] = [];

  for (const record of filteredRecords) {
    const summary = await loadSummary(record);
    const turns = await loadTurns(record.asd_session_id);
    seeds.push(...extractSeeds(record, summary, turns));
  }

  const candidates = clusterSeeds(seeds).slice(0, limit);

  return {
    candidates,
    days,
    sessions_scanned: filteredRecords.length,
    source,
  };
}

async function loadSummary(record: SessionIndexRecord): Promise<Summary | null> {
  try {
    return summarySchema.parse(JSON.parse(await readFile(record.summary_json_path, "utf8")));
  } catch {
    return null;
  }
}

async function loadTurns(asdSessionId: string): Promise<Turn[]> {
  try {
    const parsed = JSON.parse(await readFile(getReducedArtifactPath(asdSessionId), "utf8")) as {
      turns?: unknown[];
    };
    return (parsed.turns ?? []).map((turn) => turnSchema.parse(turn));
  } catch {
    return [];
  }
}

function extractSeeds(
  record: SessionIndexRecord,
  summary: Summary | null,
  turns: Turn[],
): CandidateSeed[] {
  const evidenceBase = {
    asd_session_id: record.asd_session_id,
    source_tool: record.source_tool,
    topic: sanitizeEvidenceText(record.topic),
    updated_at: record.updated_at,
  };
  const text = sanitizeEvidenceText(
    [
      record.topic,
      record.next_step,
      ...(summary?.what_worked ?? []),
      ...(summary?.what_failed ?? []),
      ...(summary?.what_was_decided ?? []),
      ...(summary?.project_learnings ?? []),
      ...(summary?.user_learnings ?? []),
      ...turns.flatMap((turn) => [turn.user_prompt, turn.assistant_summary]),
    ].join("\n"),
  );

  return markerRules
    .filter((rule) => rule.pattern.test(text))
    .map((rule) => ({
      artifactKind: rule.artifactKind,
      cluster: rule.cluster,
      evidence: { ...evidenceBase, evidence_kind: rule.evidenceKind },
      guidance: rule.guidance,
      kind: rule.evidenceKind,
      trigger: rule.trigger,
    }));
}

function clusterSeeds(seeds: CandidateSeed[]): WorkflowCandidate[] {
  const byGuidance = new Map<string, CandidateSeed[]>();

  for (const seed of seeds) {
    const key = `${seed.cluster}\0${seed.guidance}`;
    byGuidance.set(key, [...(byGuidance.get(key) ?? []), seed]);
  }

  return Array.from(byGuidance.values())
    .map(buildCandidate)
    .sort((left, right) => {
      return (
        confidenceRank(right.confidence) - confidenceRank(left.confidence) ||
        right.evidence_sessions.length - left.evidence_sessions.length ||
        left.guidance.localeCompare(right.guidance)
      );
    });
}

function buildCandidate(seeds: CandidateSeed[]): WorkflowCandidate {
  const first = seeds[0];
  if (!first) {
    throw new Error("Cannot build workflow candidate without evidence");
  }

  const evidenceSessions = dedupeEvidence(seeds.map((seed) => seed.evidence));
  const confidence = classifyConfidence(seeds, evidenceSessions);
  const recommendation = recommendationFor(confidence);

  return {
    artifact_kind: recommendation === "dismiss" ? "none" : first.artifactKind,
    candidate_id: buildCandidateId(first.cluster, first.guidance),
    cluster: first.cluster,
    confidence,
    evidence_sessions: evidenceSessions,
    guidance: first.guidance,
    recommendation,
    risk: confidence === "contradicted" ? "high" : confidence === "weak" ? "medium" : "low",
    trigger: first.trigger,
  };
}

function classifyConfidence(
  seeds: CandidateSeed[],
  evidenceSessions: WorkflowEvidence[],
): WorkflowConfidence {
  const hasContradiction = seeds.some((seed) => seed.kind === "contradiction");
  const hasCorrection = seeds.some((seed) => seed.kind === "correction");
  const hasExplicitPreference = seeds.some((seed) => seed.kind === "explicit_preference");
  const sessionCount = evidenceSessions.length;

  if (hasContradiction) {
    return "contradicted";
  }

  if (hasCorrection || hasExplicitPreference || sessionCount >= 3) {
    return "strong";
  }

  if (sessionCount >= 2) {
    return "medium";
  }

  return "weak";
}

function recommendationFor(confidence: WorkflowConfidence): WorkflowRecommendation {
  if (confidence === "strong") return "adopt";
  if (confidence === "medium") return "consider";
  if (confidence === "contradicted") return "ask";
  return "dismiss";
}

function confidenceRank(confidence: WorkflowConfidence): number {
  switch (confidence) {
    case "strong":
      return 4;
    case "medium":
      return 3;
    case "weak":
      return 2;
    case "contradicted":
      return 1;
  }
}

function dedupeEvidence(evidence: WorkflowEvidence[]): WorkflowEvidence[] {
  const bySession = new Map<string, WorkflowEvidence>();

  for (const item of evidence) {
    if (!bySession.has(item.asd_session_id)) {
      bySession.set(item.asd_session_id, item);
    }
  }

  return Array.from(bySession.values()).sort((left, right) =>
    left.asd_session_id.localeCompare(right.asd_session_id),
  );
}

function buildCandidateId(cluster: WorkflowCluster, guidance: string): string {
  const digest = createHash("sha256").update(`${cluster}\0${guidance}`).digest("hex").slice(0, 10);
  return `wf_${digest}`;
}

function sanitizeEvidenceText(text: string): string {
  return text
    .replace(/\b(?:[A-Za-z]:)?\/?(?:Users|home)\/[^\s]+/g, "[local-path]")
    .replace(/\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)\b\s*[=:]\s*\S+/gi, "[secret-ref]");
}
