import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getRuntimePath } from "../config/paths.js";
import type { LlmCallUsage } from "./llm-learning-review.js";

export type LlmTelemetryOperation =
  | "learning_review"
  | "topic_generation"
  | "global_promotion_judge"
  | "workflow_judge";

/**
 * One OpenRouter call's telemetry, shaped for OpenTelemetry GenAI semantic
 * conventions (the `gen_ai.*` keys) with asd-local context under `asd.*`.
 * This is the raw receipt — derived rollups (cost per session, etc.) are
 * computed on demand by the cost-report command, never persisted twice.
 */
export type LlmTelemetryRecord = {
  "gen_ai.provider.name": "openrouter";
  "gen_ai.operation.name": LlmTelemetryOperation;
  "gen_ai.request.model": string;
  "gen_ai.usage.input_tokens": number | null;
  "gen_ai.usage.output_tokens": number | null;
  "gen_ai.usage.total_tokens": number | null;
  "gen_ai.usage.reasoning_tokens": number | null;
  "gen_ai.usage.cached_tokens": number | null;
  "gen_ai.usage.cost": number | null;
  "gen_ai.usage.cost_is_known": boolean;
  "gen_ai.client.operation.duration_ms": number;
  "asd.cost_source": string;
  "asd.session_id": string;
  "asd.learning_id": string | null;
  "asd.cache_hit": boolean;
  "asd.missing_reason": string | null;
  // Learnings that shared this record's underlying OpenRouter HTTP call. 1 for
  // unbatched calls and cache hits; N for a member of an N-learning batch.
  "asd.batch_size": number;
  "asd.created_at": string;
};

export function getLlmTelemetryPath(): string {
  return join(getRuntimePath("reports"), "llm-telemetry.jsonl");
}

export function buildLlmTelemetryRecord(input: {
  usage: LlmCallUsage;
  operation: LlmTelemetryOperation;
  sessionId: string;
  learningId?: string | null;
  createdAt: string;
}): LlmTelemetryRecord {
  const { usage } = input;
  return {
    "gen_ai.provider.name": "openrouter",
    "gen_ai.operation.name": input.operation,
    "gen_ai.request.model": usage.model,
    "gen_ai.usage.input_tokens": usage.input_tokens,
    "gen_ai.usage.output_tokens": usage.output_tokens,
    "gen_ai.usage.total_tokens": usage.total_tokens,
    "gen_ai.usage.reasoning_tokens": usage.reasoning_tokens,
    "gen_ai.usage.cached_tokens": usage.cached_tokens,
    "gen_ai.usage.cost": usage.cost,
    "gen_ai.usage.cost_is_known": usage.cost_is_known,
    "gen_ai.client.operation.duration_ms": usage.duration_ms,
    "asd.cost_source": usage.cost_source,
    "asd.session_id": input.sessionId,
    "asd.learning_id": input.learningId ?? null,
    "asd.cache_hit": usage.cache_hit,
    "asd.missing_reason": usage.missing_reason,
    "asd.batch_size": usage.batch_size ?? 1,
    "asd.created_at": input.createdAt,
  };
}

/**
 * Append a telemetry receipt. Telemetry is observability, never a hard
 * dependency of the pipeline: a write failure is logged and swallowed so it
 * cannot break ingest, review, or summarization.
 */
export async function appendLlmTelemetry(
  record: LlmTelemetryRecord,
  options: { path?: string } = {},
): Promise<void> {
  const path = options.path ?? getLlmTelemetryPath();
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
  } catch (error) {
    console.warn(`[asd] llm telemetry write failed (non-fatal): ${String(error)}`);
  }
}
