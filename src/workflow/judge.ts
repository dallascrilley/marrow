import { createHash } from "node:crypto";

import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import {
  assessLlmBudget,
  assessUsdBudget,
  getDefaultMaxPerWindow,
  getDefaultMaxUsd,
  recordLlmBudgetUse,
} from "../pipeline/llm-budget.js";
import {
  type ChatMessage,
  completeOpenRouterJson,
  defaultOpenRouterLearningReviewModel,
  type LlmCallUsage,
  openRouterModelEnvVar,
} from "../pipeline/llm-learning-review.js";
import { appendLlmTelemetry, buildLlmTelemetryRecord } from "../pipeline/llm-telemetry.js";
import {
  judgeCacheKey,
  loadJudgeCache,
  saveJudgeCache,
  setCachedVerdict,
} from "../v2/promotion/judge-cache.js";
import { appendWorkflowDecision } from "./decisions.js";
import { mineWorkflowCandidates } from "./mine.js";
import {
  type WorkflowCandidate,
  workflowArtifactKinds,
  workflowConfidenceLevels,
} from "./schema.js";

export const WORKFLOW_JUDGE_PROMPT_VERSION = "workflow-judge-v1";

const MAX_CONSECUTIVE_ERRORS = 3;
const DEFAULT_LIMIT = 5;

export const workflowJudgeVerdictSchema = z.object({
  wording_ok: z.boolean(),
  suggested_guidance: z.string().min(1).max(500).optional(),
  artifact_kind: z.enum(workflowArtifactKinds),
  confidence: z.enum(workflowConfidenceLevels),
  reason: z.string().min(1).max(400),
});

export type WorkflowJudgeVerdict = z.infer<typeof workflowJudgeVerdictSchema>;

export type WorkflowJudgeResult = {
  verdict: WorkflowJudgeVerdict;
  usage: LlmCallUsage;
};

export type WorkflowJudgeOptions = {
  database?: DatabaseSync | undefined;
  days?: number | undefined;
  fetchImpl?: typeof fetch | undefined;
  limit?: number | undefined;
  maxPer?: string | undefined;
  maxUsd?: string | undefined;
  model?: string | undefined;
  source?: string | null | undefined;
  apiKey?: string | undefined;
};

export type JudgedWorkflowCandidate = {
  candidate_id: string;
  rule_id: string;
  verdict: WorkflowJudgeVerdict;
  from_cache: boolean;
};

export type WorkflowJudgeRunResult = {
  candidates_considered: number;
  candidates_total: number;
  errored: number;
  from_cache: number;
  judged: number;
  judged_candidates: JudgedWorkflowCandidate[];
  model: string;
  skipped: boolean;
  stopped_reason: string | null;
  total_cost_usd: number;
};

export function resolveWorkflowJudgeModel(model?: string): string {
  const fromInput = model?.trim();
  if (fromInput) return fromInput;
  const fromEnv = process.env[openRouterModelEnvVar]?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : defaultOpenRouterLearningReviewModel;
}

export function workflowJudgeContentHash(candidate: WorkflowCandidate): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        artifact_kind: candidate.artifact_kind,
        cluster: candidate.cluster,
        confidence: candidate.confidence,
        contradicting_count: candidate.contradicting_count,
        evidence: candidate.evidence_sessions.map((item) => ({
          asd_session_id: item.asd_session_id,
          evidence_kind: item.evidence_kind,
          excerpt: item.excerpt,
          matched_rule_id: item.matched_rule_id,
        })),
        guidance: candidate.guidance,
        recommendation: candidate.recommendation,
        rule_id: candidate.rule_id,
        supporting_count: candidate.supporting_count,
        trigger: candidate.trigger,
      }),
    )
    .digest("hex");
}

export function parseWorkflowJudgeVerdict(content: string): WorkflowJudgeVerdict {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`workflow judge: no JSON object in response: ${content.slice(0, 120)}`);
  }
  return workflowJudgeVerdictSchema.parse(JSON.parse(content.slice(start, end + 1)));
}

export async function judgeWorkflowCandidate(input: {
  apiKey?: string;
  candidate: WorkflowCandidate;
  fetchImpl?: typeof fetch;
  model?: string;
}): Promise<WorkflowJudgeResult> {
  const model = resolveWorkflowJudgeModel(input.model);
  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt() },
    { role: "user", content: buildUserPrompt(input.candidate) },
  ];
  const { content, usage } = await completeOpenRouterJson({
    apiKey: input.apiKey,
    errorLabel: "workflow judge",
    fetchImpl: input.fetchImpl,
    messages,
    model,
  });
  return { verdict: parseWorkflowJudgeVerdict(content), usage };
}

export async function runWorkflowJudge(
  options: WorkflowJudgeOptions = {},
): Promise<WorkflowJudgeRunResult> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const model = resolveWorkflowJudgeModel(options.model);
  const apiKey = options.apiKey;
  if (apiKey === undefined || apiKey.trim().length === 0) {
    return emptyWorkflowJudgeResult(model, "missing_openrouter_key");
  }

  const mineOptions = {
    days: options.days ?? 7,
    includeDecided: true,
    limit: Number.MAX_SAFE_INTEGER,
    source: options.source ?? null,
    ...(options.database ? { database: options.database } : {}),
  };
  const mined = await mineWorkflowCandidates(mineOptions);
  const candidates = mined.candidates
    .filter((candidate) => candidate.decision === undefined)
    .slice(0, limit);
  if (candidates.length === 0) {
    return {
      ...emptyWorkflowJudgeResult(model, null),
      candidates_total: mined.candidates.length,
      skipped: false,
    };
  }

  const maxPer = options.maxPer ?? getDefaultMaxPerWindow();
  const maxUsd = options.maxUsd ?? getDefaultMaxUsd();
  const cache = await loadJudgeCache();
  let cacheDirty = false;
  let judged = 0;
  let fromCache = 0;
  let errored = 0;
  let consecutiveErrors = 0;
  let totalCost = 0;
  let stoppedReason: string | null = null;
  const judgedCandidates: JudgedWorkflowCandidate[] = [];

  for (const candidate of candidates) {
    const cacheKey = judgeCacheKey(
      `workflow:${workflowJudgeContentHash(candidate)}`,
      model,
      WORKFLOW_JUDGE_PROMPT_VERSION,
    );
    const cached = cache.get(cacheKey);
    let verdict: WorkflowJudgeVerdict;
    let cachedVerdict = false;

    if (cached !== undefined) {
      verdict = workflowJudgeVerdictSchema.parse(cached.verdict);
      cachedVerdict = true;
      fromCache += 1;
    } else {
      const budget = await assessLlmBudget(maxPer);
      const usdBudget = await assessUsdBudget(maxUsd);
      if (!budget.allowed || !usdBudget.allowed) {
        stoppedReason = budget.allowed ? "usd_budget_exhausted" : "count_budget_exhausted";
        break;
      }
      let result: WorkflowJudgeResult;
      try {
        result = await judgeWorkflowCandidate({
          apiKey,
          candidate,
          model,
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        });
      } catch (error) {
        errored += 1;
        consecutiveErrors += 1;
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          stoppedReason = `aborted_after_${consecutiveErrors}_consecutive_errors: ${(error as Error).message}`;
          break;
        }
        continue;
      }
      consecutiveErrors = 0;
      await recordLlmBudgetUse(maxPer);
      await appendLlmTelemetry(
        buildLlmTelemetryRecord({
          usage: result.usage,
          operation: "workflow_judge",
          sessionId: candidate.evidence_sessions[0]?.asd_session_id ?? candidate.candidate_id,
          learningId: candidate.rule_id,
          createdAt: new Date().toISOString(),
        }),
      );
      judged += 1;
      totalCost += result.usage.cost ?? 0;
      verdict = result.verdict;
      setCachedVerdict(
        cache,
        cacheKey,
        verdict,
        model,
        WORKFLOW_JUDGE_PROMPT_VERSION,
        new Date().toISOString(),
      );
      cacheDirty = true;
    }

    await appendWorkflowDecision({
      candidate_id: candidate.candidate_id,
      decision: "judged",
      note: formatJudgeNote(verdict),
      rule_id: candidate.rule_id,
    });
    judgedCandidates.push({
      candidate_id: candidate.candidate_id,
      rule_id: candidate.rule_id,
      verdict,
      from_cache: cachedVerdict,
    });
  }

  if (cacheDirty) {
    await saveJudgeCache(cache);
  }

  return {
    candidates_considered: candidates.length,
    candidates_total: mined.candidates.length,
    errored,
    from_cache: fromCache,
    judged,
    judged_candidates: judgedCandidates,
    model,
    skipped: false,
    stopped_reason: stoppedReason,
    total_cost_usd: Number(totalCost.toFixed(6)),
  };
}

function emptyWorkflowJudgeResult(
  model: string,
  stoppedReason: string | null,
): WorkflowJudgeRunResult {
  return {
    candidates_considered: 0,
    candidates_total: 0,
    errored: 0,
    from_cache: 0,
    judged: 0,
    judged_candidates: [],
    model,
    skipped: stoppedReason === "missing_openrouter_key",
    stopped_reason: stoppedReason,
    total_cost_usd: 0,
  };
}

function buildSystemPrompt(): string {
  return [
    "You judge whether a mined workflow-guidance candidate is ready for human review.",
    "Check that the guidance wording is specific, transferable, non-duplicative, and supported by the evidence summary.",
    "Do not invent new policy. Prefer conservative confidence when evidence is thin or contradictory.",
    "Return suggested_guidance only when wording_ok=false and a short replacement fixes the issue.",
    'Respond with ONLY JSON: {"wording_ok": boolean, "suggested_guidance"?: string, "artifact_kind": "skill"|"rule"|"workflow_doc"|"none", "confidence": "strong"|"medium"|"weak"|"contradicted", "reason": string}.',
  ].join("\n");
}

function buildUserPrompt(candidate: WorkflowCandidate): string {
  return JSON.stringify(
    {
      artifact_kind: candidate.artifact_kind,
      cluster: candidate.cluster,
      confidence: candidate.confidence,
      contradicting_count: candidate.contradicting_count,
      evidence: candidate.evidence_sessions.map((item) => ({
        evidence_kind: item.evidence_kind,
        excerpt: item.excerpt,
        matched_rule_id: item.matched_rule_id,
        source_tool: item.source_tool,
      })),
      guidance: candidate.guidance,
      recommendation: candidate.recommendation,
      rule_id: candidate.rule_id,
      source_tier: candidate.source_tier,
      supporting_count: candidate.supporting_count,
      trigger: candidate.trigger,
    },
    null,
    2,
  );
}

function formatJudgeNote(verdict: WorkflowJudgeVerdict): string {
  return JSON.stringify({
    artifact_kind: verdict.artifact_kind,
    confidence: verdict.confidence,
    reason: sanitizeJudgeText(verdict.reason),
    suggested_guidance: verdict.suggested_guidance
      ? sanitizeJudgeText(verdict.suggested_guidance)
      : null,
    wording_ok: verdict.wording_ok,
  });
}

function sanitizeJudgeText(value: string): string {
  return value
    .replace(/(?:[A-Za-z]:)?\/?(?:Users|home)\/[^\s]+/g, "[local-path]")
    .replace(/\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)\b\s*[=:]\s*\S+/gi, "[secret-ref]")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseWorkflowJudgeLimit(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) throw new Error("--limit must be a positive integer");
  return parsed;
}
