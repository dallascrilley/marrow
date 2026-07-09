import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { DatabaseSync } from "node:sqlite";

import { type Summary, summarySchema, type Turn, turnSchema } from "../models/canonical.js";
import { sanitizeLearningStatement } from "../pipeline/prompt-sanitize.js";
import { getReducedArtifactPath } from "../pipeline/reduce.js";
import { loadSessionIndexRecords, type SessionIndexRecord } from "../read/session-index.js";
import { loadGlobalInstinct, loadGlobalInstinctIds } from "../v2/instinct/global-store.js";
import { canonicalKey } from "../v2/instinct/id.js";
import type { Instinct } from "../v2/instinct/schema.js";
import { latestWorkflowDecisionMap, type WorkflowDecision } from "./decisions.js";
import type {
  WorkflowArtifactKind,
  WorkflowCandidate,
  WorkflowCluster,
  WorkflowConfidence,
  WorkflowEvidence,
  WorkflowEvidenceKind,
  WorkflowMineResult,
  WorkflowRecommendation,
  WorkflowSourceTier,
} from "./schema.js";

export type MineWorkflowOptions = {
  database?: DatabaseSync;
  cluster?: WorkflowCluster | null;
  days?: number;
  recommendation?: WorkflowRecommendation | null;
  includeDecided?: boolean;
  limit?: number;
  source?: string | null;
};

type CandidateSeed = {
  artifactKind: WorkflowArtifactKind;
  cluster: WorkflowCluster;
  evidence: WorkflowEvidence;
  guidance: string;
  ruleId: string;
  kind: WorkflowEvidenceKind;
  trigger: string;
  sourceTier: WorkflowSourceTier;
  confidence?: WorkflowConfidence;
};

const DEFAULT_DAYS = 7;
const MAX_EVIDENCE_SESSIONS = 10;
const MAX_EVIDENCE_EXCERPT_CHARS = 200;
const ENCODED_OVERLAP_THRESHOLD = 0.6;
const DEFAULT_LIMIT = 20;
const MIN_EVIDENCE_EXCERPT_CHARS = 20;
const GENERIC_EVIDENCE_PATTERNS = [
  /at every handoff and turn end/i,
  /branch\/worktree no agent-owned dirt before handoff/i,
  /do not call a persistent REPL in parallel/i,
  /prefer skills and repo evidence over broad prose recall/i,
  /stop when request fulfilled/i,
  /when `?qa`? CLI on PATH/i,
];

const markerRules: Array<{
  artifactKind: WorkflowArtifactKind;
  cluster: WorkflowCluster;
  evidenceKind: WorkflowEvidenceKind;
  guidance: string;
  ruleId: string;
  pattern: RegExp;
  trigger: string;
}> = [
  {
    artifactKind: "rule",
    cluster: "validation",
    evidenceKind: "explicit_preference",
    ruleId: "validation-explicit-verify",
    guidance: "Run the relevant verification before claiming behavior works or work is complete.",
    pattern:
      /\b(?:always|must)\b[^.?!]*(verify|verification|test|cibuild|ci|proof|passes|green)|\bnever\b[^.?!]*(skip|ship|claim|finish|merge|complete)[^.?!]*(without\s+)?(verify|verification|test|cibuild|ci|proof)/i,
    trigger: "Before claiming completion, merge readiness, or CI status.",
  },
  {
    artifactKind: "rule",
    cluster: "validation",
    evidenceKind: "contradiction",
    ruleId: "validation-explicit-verify",
    guidance: "Run the relevant verification before claiming behavior works or work is complete.",
    pattern:
      /\b(?:without|no need|never need|never have to|do not need|don't need)\b[^.?!]*(verify|verification|test|cibuild|ci|proof)|\bskip\b[^.?!]*(verify|verification|test|cibuild|ci|proof)/i,
    trigger: "Before claiming completion, merge readiness, or CI status.",
  },
  {
    artifactKind: "rule",
    cluster: "validation",
    evidenceKind: "correction",
    ruleId: "validation-scope-correction",
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
    ruleId: "review-independent-closeout",
    guidance:
      "Use an independent review or explicit self-review path before closing review-gated work.",
    pattern: /\b(review|reviewer|approve|reject|self-review|qa)\b/i,
    trigger: "When work enters a review-gated task, PR, or td issue closeout.",
  },
  {
    artifactKind: "workflow_doc",
    cluster: "shipping",
    evidenceKind: "accepted_pattern",
    ruleId: "shipping-concrete-evidence",
    guidance:
      "Keep shipping evidence tied to concrete commands, commits, PRs, and CI state rather than local claims.",
    pattern: /\b(pr|pull request|push|commit|ci|branch|merge|ship|shipping)\b/i,
    trigger: "When preparing a change for review, push, PR, or merge.",
  },
  {
    artifactKind: "skill",
    cluster: "debugging",
    evidenceKind: "accepted_pattern",
    ruleId: "debugging-root-cause-evidence",
    guidance:
      "Debug from root cause and preserve the failing evidence before changing implementation.",
    pattern: /\b(debug|root cause|failure|failing|regression|logs?|trace)\b/i,
    trigger: "When tests, builds, runtime commands, or user reports expose a failure.",
  },
  {
    artifactKind: "rule",
    cluster: "capture",
    evidenceKind: "accepted_pattern",
    ruleId: "capture-durable-guidance",
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
    ruleId: "delegation-quality-speed-check",
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
    ruleId: "communication-evidence-first",
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
    ruleId: "simplification-smallest-maintainable",
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
  const cluster = options.cluster ?? null;
  const recommendation = options.recommendation ?? null;
  const includeDecided = options.includeDecided ?? false;
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

  seeds.push(...(await extractInstinctSeeds()));

  const decisionMap = await latestWorkflowDecisionMap();
  const candidates = suppressAlreadyEncodedCandidates(
    clusterSeeds(seeds),
    await loadEncodedInstincts(),
  )
    .map((candidate) => annotateDecision(candidate, decisionMap.get(candidate.candidate_id)))
    .filter((candidate) => includeDecided || candidate.decision === undefined)
    .filter((candidate) => !cluster || candidate.cluster === cluster)
    .filter((candidate) => !recommendation || candidate.recommendation === recommendation)
    .slice(0, limit);

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
  const evidenceTextParts = [
    ...(summary?.what_worked ?? []),
    ...(summary?.what_failed ?? []),
    ...(summary?.what_was_decided ?? []),
    ...(summary?.project_learnings ?? []),
    ...(summary?.user_learnings ?? []),
    ...turns.flatMap((turn) => [turn.user_prompt, turn.assistant_summary]),
  ];
  const textParts = [record.topic, record.next_step, ...evidenceTextParts];
  const text = sanitizeEvidenceText(textParts.join("\n"));

  return markerRules
    .filter((rule) => rule.pattern.test(text))
    .map((rule) => ({
      artifactKind: rule.artifactKind,
      cluster: rule.cluster,
      evidence: {
        ...evidenceBase,
        evidence_kind: rule.evidenceKind,
        excerpt: extractEvidenceExcerpt(evidenceTextParts, rule.pattern),
        matched_rule_id: rule.ruleId,
      },
      guidance: rule.guidance,
      ruleId: rule.ruleId,
      kind: rule.evidenceKind,
      trigger: rule.trigger,
      sourceTier: "keyword",
    }));
}

async function extractInstinctSeeds(): Promise<CandidateSeed[]> {
  const seeds: CandidateSeed[] = [];
  for (const id of await loadGlobalInstinctIds()) {
    const instinct = await loadGlobalInstinct(id);
    if (!isMineableWorkflowInstinct(instinct)) {
      continue;
    }
    const confidence: WorkflowConfidence = instinct.maturity === "proven" ? "strong" : "medium";
    const ruleId = `instinct-${canonicalKey(instinct.trigger, instinct.finding)}`;
    const evidence = instinct.source.observations.map(
      (observation) =>
        ({
          asd_session_id: observation.session,
          evidence_kind: observation.reinforcing ? "accepted_pattern" : "contradiction",
          excerpt: sanitizeLearningStatement(
            sanitizeEvidenceText(observation.correction ?? instinct.finding),
          ),
          matched_rule_id: ruleId,
          source_tool: "instinct",
          topic: sanitizeEvidenceText(instinct.trigger),
          updated_at: observation.at,
        }) satisfies WorkflowEvidence,
    );
    for (const item of evidence) {
      seeds.push({
        artifactKind: "skill",
        cluster: "capture",
        evidence: item,
        guidance: instinct.finding,
        ruleId,
        kind: item.evidence_kind,
        trigger: instinct.trigger,
        sourceTier: "instinct",
        confidence,
      });
    }
  }
  return seeds;
}

function isMineableWorkflowInstinct(instinct: Instinct | null): instinct is Instinct {
  return (
    instinct !== null &&
    instinct.scope === "global" &&
    instinct.domain === "workflow" &&
    (instinct.maturity === "established" || instinct.maturity === "proven")
  );
}

type EncodedInstinct = {
  id: string;
  tokens: Set<string>;
};

async function loadEncodedInstincts(): Promise<EncodedInstinct[]> {
  const instincts = [];
  for (const id of await loadGlobalInstinctIds()) {
    const instinct = await loadGlobalInstinct(id);
    if (!instinct || instinct.maturity === "deprecated") {
      continue;
    }
    const tokens = canonicalKey(instinct.trigger, instinct.finding).split("-").filter(Boolean);
    if (tokens.length > 0) {
      instincts.push({ id: instinct.id, tokens: new Set(tokens) });
    }
  }
  return instincts;
}

function suppressAlreadyEncodedCandidates(
  candidates: WorkflowCandidate[],
  encodedInstincts: EncodedInstinct[],
): WorkflowCandidate[] {
  if (encodedInstincts.length === 0) {
    return candidates;
  }

  return candidates.map((candidate) => {
    // Instinct-tier candidates are sourced from the global store, so suppressing
    // them against that same store would hide the reviewable instinct candidates.
    if (candidate.source_tier === "instinct") {
      return candidate;
    }
    const guidanceTokens = canonicalKey(candidate.trigger, candidate.guidance)
      .split("-")
      .filter(Boolean);
    if (guidanceTokens.length === 0) {
      return candidate;
    }

    const encoded = encodedInstincts.find((instinct) => {
      const overlap = guidanceTokens.filter((token) => instinct.tokens.has(token)).length;
      return overlap / guidanceTokens.length >= ENCODED_OVERLAP_THRESHOLD;
    });
    if (!encoded) {
      return candidate;
    }

    return {
      ...candidate,
      artifact_kind: "none",
      encoded_in: encoded.id,
      recommendation: "dismiss",
      status: "already_encoded",
    };
  });
}

function annotateDecision(
  candidate: WorkflowCandidate,
  decision: WorkflowDecision | undefined,
): WorkflowCandidate {
  if (!decision) {
    return candidate;
  }

  return {
    ...candidate,
    decision: {
      decided_at: decision.decided_at,
      decision: decision.decision,
      ...(decision.note ? { note: decision.note } : {}),
    },
  };
}

function clusterSeeds(seeds: CandidateSeed[]): WorkflowCandidate[] {
  const byRule = new Map<string, CandidateSeed[]>();

  for (const seed of seeds) {
    const key = `${seed.cluster}\0${seed.ruleId}`;
    byRule.set(key, [...(byRule.get(key) ?? []), seed]);
  }

  return Array.from(byRule.values())
    .map(buildCandidate)
    .sort((left, right) => {
      return (
        confidenceRank(right.confidence) - confidenceRank(left.confidence) ||
        sourceTierRank(right.source_tier) - sourceTierRank(left.source_tier) ||
        right.evidence_count - left.evidence_count ||
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
  const counts = countEvidenceKinds(seeds);
  const confidence = classifyConfidence(seeds, evidenceSessions, counts);
  const recommendation = recommendationFor(confidence);

  return {
    artifact_kind: recommendation === "dismiss" ? "none" : first.artifactKind,
    candidate_id: buildCandidateId(first.cluster, first.ruleId, first.sourceTier),
    cluster: first.cluster,
    contradicting_count: counts.contradicting,
    confidence,
    evidence_count: evidenceSessions.length,
    evidence_sessions: evidenceSessions.slice(0, MAX_EVIDENCE_SESSIONS),
    guidance: first.guidance,
    recommendation,
    risk: confidence === "contradicted" ? "high" : confidence === "weak" ? "medium" : "low",
    rule_id: first.ruleId,
    supporting_count: counts.supporting,
    trigger: first.trigger,
    source_tier: first.sourceTier,
  };
}

function classifyConfidence(
  seeds: CandidateSeed[],
  evidenceSessions: WorkflowEvidence[],
  counts: { contradicting: number; supporting: number },
): WorkflowConfidence {
  // Only instinct-tier seeds set explicit confidence; keyword seeds never do, so
  // this short-circuit cannot fire for mixed keyword/instinct clusters.
  const explicitConfidence = seeds.find((seed) => seed.confidence)?.confidence;
  if (explicitConfidence) {
    return explicitConfidence;
  }
  const hasCorrection = seeds.some((seed) => seed.kind === "correction");
  const hasExplicitPreference = seeds.some((seed) => seed.kind === "explicit_preference");
  const sessionCount = evidenceSessions.length;

  if (counts.contradicting / Math.max(1, counts.supporting + counts.contradicting) > 0.2) {
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

function sourceTierRank(sourceTier: WorkflowSourceTier): number {
  return sourceTier === "instinct" ? 2 : 1;
}

function countEvidenceKinds(seeds: CandidateSeed[]): { contradicting: number; supporting: number } {
  const contradictingSessions = new Set<string>();
  const supportingSessions = new Set<string>();

  for (const seed of seeds) {
    if (seed.kind === "contradiction") {
      contradictingSessions.add(seed.evidence.asd_session_id);
      continue;
    }
    supportingSessions.add(seed.evidence.asd_session_id);
  }

  for (const sessionId of contradictingSessions) {
    supportingSessions.delete(sessionId);
  }

  return { contradicting: contradictingSessions.size, supporting: supportingSessions.size };
}

function dedupeEvidence(evidence: WorkflowEvidence[]): WorkflowEvidence[] {
  const bySession = new Map<string, WorkflowEvidence>();

  for (const item of evidence) {
    const existing = bySession.get(item.asd_session_id);
    if (!existing || (!existing.excerpt && item.excerpt)) {
      bySession.set(item.asd_session_id, item);
    }
  }

  return Array.from(bySession.values()).sort((left, right) => {
    const usefulnessOrder = Number(Boolean(right.excerpt)) - Number(Boolean(left.excerpt));
    const updatedAtOrder = Date.parse(right.updated_at) - Date.parse(left.updated_at);
    return (
      usefulnessOrder || updatedAtOrder || left.asd_session_id.localeCompare(right.asd_session_id)
    );
  });
}

function buildCandidateId(
  cluster: WorkflowCluster,
  ruleId: string,
  sourceTier: WorkflowSourceTier,
): string {
  const idInput =
    sourceTier === "instinct"
      ? `instinct\0${ruleId.replace(/^instinct-/u, "")}`
      : `${cluster}\0${ruleId}`;
  const digest = createHash("sha256").update(idInput).digest("hex").slice(0, 10);
  return `wf_${digest}`;
}

function extractEvidenceExcerpt(textParts: readonly string[], pattern: RegExp): string {
  const fallbackParts = textParts.length > 0 ? textParts : [""];
  for (const text of [...fallbackParts, fallbackParts.join(" ")]) {
    const sanitizedText = sanitizeEvidenceText(text);
    const match = pattern.exec(sanitizedText);
    if (!match) {
      continue;
    }

    const sentence = sentenceContainingMatch(sanitizedText, match.index);
    const cleanExcerpt = sanitizeLearningStatement(sanitizeEvidenceText(sentence));
    if (isUsefulEvidenceExcerpt(cleanExcerpt)) {
      return cleanExcerpt.length <= MAX_EVIDENCE_EXCERPT_CHARS
        ? cleanExcerpt
        : `${cleanExcerpt.slice(0, MAX_EVIDENCE_EXCERPT_CHARS - 1).trimEnd()}…`;
    }
  }

  return "";
}

function isUsefulEvidenceExcerpt(excerpt: string): boolean {
  return (
    excerpt.length >= MIN_EVIDENCE_EXCERPT_CHARS &&
    !GENERIC_EVIDENCE_PATTERNS.some((pattern) => pattern.test(excerpt))
  );
}

function sentenceContainingMatch(text: string, matchIndex: number): string {
  const start =
    Math.max(
      text.lastIndexOf(".", matchIndex),
      text.lastIndexOf("!", matchIndex),
      text.lastIndexOf("?", matchIndex),
      text.lastIndexOf("\n", matchIndex),
    ) + 1;
  const remaining = text.slice(matchIndex);
  const endMatch = remaining.match(/[.?!\n]/);
  const end = endMatch?.index === undefined ? text.length : matchIndex + endMatch.index + 1;
  return text.slice(start, end).trim();
}

function sanitizeEvidenceText(text: string): string {
  return text
    .replace(/\b(?:[A-Za-z]:)?\/?(?:Users|home)\/[^\s]+/g, "[local-path]")
    .replace(/\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)\b\s*[=:]\s*\S+/gi, "[secret-ref]");
}
