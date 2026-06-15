import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Learning, SourceSession, Turn } from "../models/canonical.js";
import { learningSchema } from "../models/canonical.js";
import { extractSubstantivePrompt, sanitizeHarnessLeakText } from "./prompt-sanitize.js";

export const defaultOpenRouterLearningReviewModel = "openai/gpt-5-nano";
export const defaultOpenRouterTopicModel = "openai/gpt-5.4-nano";
export const openRouterApiKeyEnvVar = "OPENROUTER_API_KEY";
export const openRouterModelEnvVar = "OPENROUTER_MODEL";
export const learningReviewCacheSchemaVersion = "llm-learning-review-cache-v1";
export const learningReviewPromptVersion = "llm-learning-review-prompt-v1";
export const learningReviewValidatorVersion = "llm-learning-review-validator-v1";

export type LearningReviewVerdict = "keep" | "reject" | "rewrite";
export type LearningReviewDurability =
  | "durable"
  | "transient"
  | "process"
  | "duplicate"
  | "unclear";

export type LearningReviewResult = {
  durability: LearningReviewDurability;
  keep: boolean;
  reason: string;
  statement: string;
  verdict: LearningReviewVerdict;
};

/**
 * Per-call OpenRouter usage + cost, captured at the source boundary.
 * Field names mirror OpenTelemetry GenAI semantics for later portability.
 * Cost is the actual amount OpenRouter reports (USD); we never estimate it
 * from a pricing table — when the provider does not return it we fail closed
 * with `cost_is_known: false` and a `missing_reason`.
 */
/** Where the effective `cost` figure came from. */
export type LlmCostSource = "openrouter" | "upstream" | "cache" | "none";

export type LlmCallUsage = {
  model: string;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  reasoning_tokens: number | null;
  cached_tokens: number | null;
  // `cost` is the effective spend: OpenRouter's own charge when it bills us, or
  // the upstream provider cost for BYOK keys (where OpenRouter's charge is 0 but
  // real money is still spent on the upstream key). `cost_source` says which.
  cost: number | null;
  cost_source: LlmCostSource;
  cost_is_known: boolean;
  missing_reason: string | null;
  duration_ms: number;
  cache_hit: boolean;
};

export type ReviewedLearning = {
  learning: Learning;
  review: LearningReviewResult;
  usage: LlmCallUsage;
};

export type LlmUsageSink = (usage: LlmCallUsage) => void;

/** Usage record for a cache hit: no API call, so it cost nothing. */
export function cacheHitUsage(model: string): LlmCallUsage {
  return {
    model,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    reasoning_tokens: 0,
    cached_tokens: 0,
    cost: 0,
    cost_source: "cache",
    cost_is_known: true,
    missing_reason: null,
    duration_ms: 0,
    cache_hit: true,
  };
}

type FetchLike = typeof fetch;
type ChatMessage = {
  content: string;
  role: "system" | "user";
};

export async function reviewLearningWithOpenRouter(input: {
  apiKey?: string | undefined;
  cacheDir?: string | undefined;
  fetchImpl?: FetchLike | undefined;
  learning: Learning;
  model?: string | undefined;
  noCache?: boolean | undefined;
  onUsage?: LlmUsageSink | undefined;
  projectKey: string;
  refreshLlm?: boolean | undefined;
}): Promise<LearningReviewResult> {
  const model =
    input.model ?? process.env[openRouterModelEnvVar] ?? defaultOpenRouterLearningReviewModel;
  const learning = learningSchema.parse(input.learning);
  const cachePath =
    input.cacheDir === undefined
      ? undefined
      : getLearningReviewCachePath({
          cacheDir: input.cacheDir,
          learning,
          model,
          projectKey: input.projectKey,
        });

  if (cachePath !== undefined && input.noCache !== true && input.refreshLlm !== true) {
    const cached = await readCachedLearningReview(cachePath);
    if (cached !== undefined) {
      input.onUsage?.(cacheHitUsage(model));
      return cached;
    }
  }

  const { content, usage } = await completeOpenRouterJson({
    apiKey: input.apiKey,
    errorLabel: "learning review",
    fetchImpl: input.fetchImpl,
    messages: [
      {
        content: buildLearningReviewSystemPrompt(),
        role: "system",
      },
      {
        content: JSON.stringify(
          {
            evidence: learning.evidence,
            kind: learning.kind,
            project_key: input.projectKey,
            statement: learning.statement,
          },
          null,
          2,
        ),
        role: "user",
      },
    ],
    model,
  });
  input.onUsage?.(usage);

  const review = parseLearningReview(content);
  if (cachePath !== undefined && input.noCache !== true) {
    await writeCachedLearningReview(cachePath, review);
  }

  return review;
}

export async function generateTopicWithOpenRouter(input: {
  apiKey?: string | undefined;
  deterministicTopic: string;
  fetchImpl?: FetchLike | undefined;
  model?: string | undefined;
  onUsage?: LlmUsageSink | undefined;
  sourceSession: SourceSession;
  turns: readonly Turn[];
}): Promise<string> {
  const model = input.model ?? process.env[openRouterModelEnvVar] ?? defaultOpenRouterTopicModel;
  const { content, usage } = await completeOpenRouterJson({
    apiKey: input.apiKey,
    errorLabel: "topic generation",
    fetchImpl: input.fetchImpl,
    messages: [
      {
        content: buildTopicGenerationSystemPrompt(),
        role: "system",
      },
      {
        content: JSON.stringify(buildTopicGenerationPayload(input), null, 2),
        role: "user",
      },
    ],
    model,
  });
  input.onUsage?.(usage);

  return parseTopicGeneration(content);
}

export async function reviewProjectLearningsWithOpenRouter(input: {
  apiKey?: string | undefined;
  cacheDir?: string | undefined;
  fetchImpl?: FetchLike | undefined;
  learnings: readonly Learning[];
  model?: string | undefined;
  noCache?: boolean | undefined;
  onUsage?: LlmUsageSink | undefined;
  projectKey: string;
  refreshLlm?: boolean | undefined;
}): Promise<ReviewedLearning[]> {
  const resolvedModel =
    input.model ?? process.env[openRouterModelEnvVar] ?? defaultOpenRouterLearningReviewModel;
  const reviewed: ReviewedLearning[] = [];
  for (const learning of input.learnings) {
    let captured: LlmCallUsage | undefined;
    const review = await reviewLearningWithOpenRouter({
      apiKey: input.apiKey,
      cacheDir: input.cacheDir,
      fetchImpl: input.fetchImpl,
      learning,
      model: input.model,
      noCache: input.noCache,
      onUsage: (usage) => {
        captured = usage;
        input.onUsage?.(usage);
      },
      projectKey: input.projectKey,
      refreshLlm: input.refreshLlm,
    });
    reviewed.push({ learning, review, usage: captured ?? cacheHitUsage(resolvedModel) });
  }

  return reviewed;
}

function buildLearningReviewSystemPrompt(): string {
  return [
    "You are a strict memory-lint judge for project learnings extracted from agent transcripts.",
    "Return only JSON with keys: keep, verdict, durability, statement, reason.",
    "verdict must be one of: keep, reject, rewrite.",
    "durability must be one of: durable, transient, process, duplicate, unclear.",
    "Reject chat narration, progress reports, generic completion summaries, and statements that are not reusable project knowledge.",
    "If useful but raw, rewrite into one concise durable project-memory statement under 140 characters.",
    "Prefer imperative rule/action form: Use..., Keep..., Move..., Forward..., Add..., Configure..., Avoid...",
    "Do not include test counts, coverage percentages, email counts, or other validation stats unless they are the durable rule itself.",
    "Do not introduce facts, file paths, commands, or tools that are not present in the statement or evidence.",
    "Reject generic completion summaries whose only durable fact is that work was completed or verified.",
    "Use keep=false for reject; use keep=true for keep or rewrite.",
  ].join("\n");
}

function buildTopicGenerationSystemPrompt(): string {
  return [
    "You generate concise display topics for agent session summaries.",
    "Return only JSON with key: topic.",
    "The topic must be specific, human-readable, and at most 10 words.",
    "Use the actual requested work, not harness text, file paths, commands, or boilerplate.",
    "Do not invent product names, outcomes, or files absent from the provided turns.",
  ].join("\n");
}

function buildTopicGenerationPayload(input: {
  deterministicTopic: string;
  sourceSession: SourceSession;
  turns: readonly Turn[];
}): Record<string, unknown> {
  return {
    deterministic_topic: input.deterministicTopic,
    project_key: input.sourceSession.project_key,
    session_id: input.sourceSession.session_id,
    turns: input.turns
      .map((turn) => ({
        assistant_summary: sanitizeTopicPayloadText(turn.assistant_summary, 240),
        commands_seen: turn.commands_seen.slice(0, 4),
        files_touched: turn.files_touched.slice(0, 6),
        index: turn.index,
        user_prompt: sanitizeTopicPayloadText(
          extractSubstantivePrompt(turn.user_prompt) ?? turn.user_prompt,
          500,
        ),
      }))
      .filter(
        (turn) =>
          turn.user_prompt.length > 0 ||
          turn.assistant_summary.length > 0 ||
          turn.commands_seen.length > 0 ||
          turn.files_touched.length > 0,
      )
      .slice(0, 8),
  };
}

function sanitizeTopicPayloadText(value: string, maxLength: number): string {
  const sanitized = sanitizeHarnessLeakText(value);
  const normalized = (sanitized.length > 0 ? sanitized : value).replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

export function buildLearningReviewCacheKey(input: {
  learning: Learning;
  model: string;
  projectKey: string;
}): string {
  const learning = learningSchema.parse(input.learning);
  return sha256Hex(
    stableStringify({
      cache_schema_version: learningReviewCacheSchemaVersion,
      evidence: learning.evidence,
      kind: learning.kind,
      learning_id: learning.learning_id,
      model: input.model,
      project_key: input.projectKey,
      prompt_version: learningReviewPromptVersion,
      source_refs: learning.source_refs,
      statement: learning.statement,
      validator_version: learningReviewValidatorVersion,
    }),
  );
}

function getLearningReviewCachePath(input: {
  cacheDir: string;
  learning: Learning;
  model: string;
  projectKey: string;
}): string {
  return join(input.cacheDir, `${buildLearningReviewCacheKey(input)}.json`);
}

async function readCachedLearningReview(
  cachePath: string,
): Promise<LearningReviewResult | undefined> {
  try {
    const contents = await readFile(cachePath, "utf8");
    return parseLearningReview(contents);
  } catch {
    return undefined;
  }
}

async function writeCachedLearningReview(
  cachePath: string,
  review: LearningReviewResult,
): Promise<void> {
  await mkdir(dirname(cachePath), { recursive: true });
  const tempPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(review, null, 2)}\n`, "utf8");
  await rename(tempPath, cachePath);
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

async function completeOpenRouterJson(input: {
  apiKey?: string | undefined;
  errorLabel: string;
  fetchImpl?: FetchLike | undefined;
  messages: readonly ChatMessage[];
  model: string;
}): Promise<{ content: string; usage: LlmCallUsage }> {
  const apiKey = input.apiKey ?? process.env[openRouterApiKeyEnvVar];
  if (apiKey === undefined || apiKey.trim().length === 0) {
    throw new Error(`${openRouterApiKeyEnvVar} is required for LLM ${input.errorLabel}`);
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 30_000);
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
      body: JSON.stringify({
        messages: input.messages,
        model: input.model,
        response_format: { type: "json_object" },
        temperature: 0,
        // Ask OpenRouter to include the actual cost + token accounting inline so we
        // capture spend from the source of truth instead of estimating it later.
        usage: { include: true },
      }),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/agent-session-distillery",
        "X-Title": "agent-session-distillery",
      },
      method: "POST",
      signal: abortController.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  const durationMs = Date.now() - startedAt;

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenRouter ${input.errorLabel} failed (${response.status}): ${body}`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: OpenRouterUsage;
  };
  return {
    content: extractMessageContent(payload, input.errorLabel),
    usage: parseOpenRouterUsage(payload.usage, input.model, durationMs),
  };
}

type OpenRouterUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost?: number;
  cost_details?: { upstream_inference_cost?: number };
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
};

function parseOpenRouterUsage(
  usage: OpenRouterUsage | undefined,
  model: string,
  durationMs: number,
): LlmCallUsage {
  // OpenRouter's `cost` is what it bills us. For BYOK keys that is 0 while real
  // money is still spent upstream (`cost_details.upstream_inference_cost`), so
  // the effective cost prefers a non-zero OpenRouter charge and otherwise falls
  // back to the upstream cost. Fail closed when neither is a finite number.
  const openRouterCost = numberOrNull(usage?.cost);
  const upstreamCost = numberOrNull(usage?.cost_details?.upstream_inference_cost);

  let cost: number | null = null;
  let costSource: LlmCostSource = "none";
  if (openRouterCost !== null && openRouterCost > 0) {
    cost = openRouterCost;
    costSource = "openrouter";
  } else if (upstreamCost !== null) {
    cost = upstreamCost;
    costSource = "upstream";
  } else if (openRouterCost !== null) {
    // OpenRouter explicitly reported 0 and there is no upstream figure.
    cost = openRouterCost;
    costSource = "openrouter";
  }

  return {
    model,
    input_tokens: numberOrNull(usage?.prompt_tokens),
    output_tokens: numberOrNull(usage?.completion_tokens),
    total_tokens: numberOrNull(usage?.total_tokens),
    reasoning_tokens: numberOrNull(usage?.completion_tokens_details?.reasoning_tokens),
    cached_tokens: numberOrNull(usage?.prompt_tokens_details?.cached_tokens),
    cost,
    cost_source: costSource,
    cost_is_known: cost !== null,
    missing_reason:
      cost !== null
        ? null
        : usage === undefined
          ? "openrouter_usage_absent"
          : "openrouter_cost_absent",
    duration_ms: durationMs,
    cache_hit: false,
  };
}

function numberOrNull(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function extractMessageContent(
  payload: {
    choices?: Array<{ message?: { content?: string } }>;
  },
  errorLabel: string,
): string {
  const content = payload.choices?.[0]?.message?.content;
  if (content === undefined || content.trim().length === 0) {
    throw new Error(`OpenRouter ${errorLabel} returned no message content`);
  }

  return content.trim();
}

function parseTopicGeneration(content: string): string {
  const parsed = JSON.parse(content) as { topic?: unknown };
  if (typeof parsed.topic !== "string" || parsed.topic.trim().length === 0) {
    throw new Error("Topic generation JSON must include non-empty topic");
  }

  return parsed.topic.replace(/\s+/g, " ").trim();
}

function parseLearningReview(content: string): LearningReviewResult {
  const parsed = JSON.parse(content) as Partial<LearningReviewResult>;
  const verdict = parseEnum(parsed.verdict, ["keep", "reject", "rewrite"] as const, "verdict");
  const durability = parseEnum(
    parsed.durability,
    ["durable", "transient", "process", "duplicate", "unclear"] as const,
    "durability",
  );

  if (typeof parsed.keep !== "boolean") {
    throw new Error("Learning review JSON must include boolean keep");
  }

  const statement = normalizeReviewStatement({
    keep: parsed.keep,
    statement: parsed.statement,
  });

  if (statement.length === 0) {
    throw new Error("Learning review JSON must include non-empty statement");
  }

  if (typeof parsed.reason !== "string" || parsed.reason.trim().length === 0) {
    throw new Error("Learning review JSON must include non-empty reason");
  }

  return {
    durability,
    keep: parsed.keep,
    reason: parsed.reason.trim(),
    statement,
    verdict,
  };
}

function normalizeReviewStatement(input: { keep: boolean; statement: unknown }): string {
  if (typeof input.statement === "string") {
    const trimmed = input.statement.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  return input.keep ? "__missing_statement__" : "Rejected learning";
}

function parseEnum<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  fieldName: string,
): Values[number] {
  if (typeof value === "string" && values.includes(value)) {
    return value as Values[number];
  }

  throw new Error(`Learning review JSON has invalid ${fieldName}`);
}
