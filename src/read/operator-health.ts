import type { DatabaseSync } from "node:sqlite";
import {
  type LlmLearningReviewApplyLedgerEntry,
  readLlmLearningReviewApplyLedger,
} from "../pipeline/llm-learning-review-apply-ledger.js";
import {
  type LlmLearningReviewLedgerWatermark,
  readLlmLearningReviewLedgerWatermark,
} from "../pipeline/llm-learning-review-ledger.js";
import { assessPipelineGate, type PipelineGateReport } from "../pipeline/pipeline-gate.js";
import type { ProviderPreflightReport } from "../pipeline/provider-preflight.js";
import { computeReachability, type ReachabilitySnapshot } from "../v2/metrics/reachability.js";
import { type RecallEventsSummary, summarizeRecallEvents } from "../v2/metrics/recall-events.js";
import {
  listRuntimeLifecycleInventory,
  type RuntimeLifecycleInventory,
} from "./lifecycle-inventory.js";
import { listPipelineStatus, type PipelineStatus } from "./operations.js";

const defaultReviewFreshnessMs = 7 * 24 * 60 * 60 * 1000;
const defaultStoragePressureBytes = 5 * 1024 * 1024 * 1024;

export type OperatorHealthStatus = "degraded" | "healthy";
export type OperatorHealthReviewFreshness = "fresh" | "missing" | "stale";
export type OperatorHealthStoragePressure = "elevated" | "normal";

export interface OperatorHealthRecommendation {
  command: string;
  reason: string;
}

export interface OperatorHealthPipelineState {
  gate: PipelineGateReport;
  pending_learnings: number;
  pending_sessions: number;
  status: PipelineStatus;
}

export interface OperatorHealthReviewState {
  freshness: OperatorHealthReviewFreshness;
  latest_apply: Pick<
    LlmLearningReviewApplyLedgerEntry,
    "batch_id" | "recorded_at" | "reviewed_at" | "status"
  > | null;
  reviewed: LlmLearningReviewLedgerWatermark;
}

export interface OperatorHealthRecallState {
  failed_fires: number;
  events: RecallEventsSummary;
  reachability: ReachabilitySnapshot;
}

export interface OperatorHealthStorageState {
  inventory: RuntimeLifecycleInventory;
  pressure: OperatorHealthStoragePressure;
  pressure_threshold_bytes: number;
  reclaimable_bytes: number;
}

export interface OperatorHealthModel {
  pipeline: OperatorHealthPipelineState;
  provider: ProviderPreflightReport | null;
  reasons: string[];
  recall: OperatorHealthRecallState;
  recommendation: OperatorHealthRecommendation;
  review: OperatorHealthReviewState;
  status: OperatorHealthStatus;
  storage: OperatorHealthStorageState;
}

export interface OperatorHealthDependencies {
  assessPipelineGate: (
    database: DatabaseSync,
    options?: { skipIngest?: boolean },
  ) => Promise<PipelineGateReport>;
  assessProviderPreflight?: () => Promise<ProviderPreflightReport>;
  computeReachability: () => Promise<ReachabilitySnapshot>;
  listPipelineStatus: (database: DatabaseSync) => PipelineStatus;
  listRuntimeLifecycleInventory: (database: DatabaseSync) => Promise<RuntimeLifecycleInventory>;
  readApplyLedger: () => Promise<LlmLearningReviewApplyLedgerEntry[]>;
  readReviewWatermark: () => Promise<LlmLearningReviewLedgerWatermark>;
  summarizeRecallEvents: () => Promise<RecallEventsSummary>;
}

export interface OperatorHealthOptions {
  dependencies?: Partial<OperatorHealthDependencies>;
  now?: Date;
  reviewFreshnessMs?: number;
  storagePressureBytes?: number;
}

/**
 * Compose the existing read/gate metrics once per invocation into a single bounded model.
 * It owns no cache: filesystem inventory and bundle replay each execute exactly once here.
 */
export async function buildOperatorHealthModel(
  database: DatabaseSync,
  options: OperatorHealthOptions = {},
): Promise<OperatorHealthModel> {
  const dependencies: OperatorHealthDependencies = {
    assessPipelineGate,
    computeReachability,
    listPipelineStatus,
    listRuntimeLifecycleInventory,
    readApplyLedger: readLlmLearningReviewApplyLedger,
    readReviewWatermark: readLlmLearningReviewLedgerWatermark,
    summarizeRecallEvents,
    ...options.dependencies,
  };
  const [
    pipelineGate,
    provider,
    reachability,
    recallEvents,
    inventory,
    reviewWatermark,
    applyLedger,
  ] = await Promise.all([
    dependencies.assessPipelineGate(database, { skipIngest: true }),
    dependencies.assessProviderPreflight?.() ?? null,
    dependencies.computeReachability(),
    dependencies.summarizeRecallEvents(),
    dependencies.listRuntimeLifecycleInventory(database),
    dependencies.readReviewWatermark(),
    dependencies.readApplyLedger(),
  ]);
  const now = options.now ?? new Date();
  const reviewFreshnessMs = options.reviewFreshnessMs ?? defaultReviewFreshnessMs;
  const storagePressureBytes = options.storagePressureBytes ?? defaultStoragePressureBytes;
  const review = buildReviewState(reviewWatermark, applyLedger, now, reviewFreshnessMs);
  const recall = {
    events: recallEvents,
    failed_fires: Math.max(0, recallEvents.total_fires - recallEvents.fires_delivered),
    reachability,
  };
  const storage = buildStorageState(inventory, storagePressureBytes);
  const status = dependencies.listPipelineStatus(database);
  const pipeline = {
    gate: pipelineGate,
    pending_learnings: pipelineGate.llm_review.pending_learnings,
    pending_sessions: status.sessionsByLifecycle.discovered ?? 0,
    status,
  };
  const reasons = collectReasons({ pipeline, provider, recall, review, storage });

  return {
    pipeline,
    provider,
    reasons,
    recall,
    recommendation: recommendNextAction({ pipeline, provider, recall, review, storage }),
    review,
    status: reasons.length === 0 ? "healthy" : "degraded",
    storage,
  };
}

function buildReviewState(
  watermark: LlmLearningReviewLedgerWatermark,
  applyLedger: readonly LlmLearningReviewApplyLedgerEntry[],
  now: Date,
  reviewFreshnessMs: number,
): OperatorHealthReviewState {
  const lastReviewedAt = watermark.last_reviewed_at;
  const lastReviewedMs = lastReviewedAt === null ? Number.NaN : Date.parse(lastReviewedAt);
  const freshness: OperatorHealthReviewFreshness =
    watermark.entry_count === 0 || Number.isNaN(lastReviewedMs)
      ? "missing"
      : now.getTime() - lastReviewedMs > reviewFreshnessMs
        ? "stale"
        : "fresh";
  const latestApply = applyLedger.at(-1);

  return {
    freshness,
    latest_apply:
      latestApply === undefined
        ? null
        : {
            batch_id: latestApply.batch_id,
            recorded_at: latestApply.recorded_at,
            reviewed_at: latestApply.reviewed_at,
            status: latestApply.status,
          },
    reviewed: watermark,
  };
}

function buildStorageState(
  inventory: RuntimeLifecycleInventory,
  pressureThresholdBytes: number,
): OperatorHealthStorageState {
  const reclaimableBytes = inventory.artifacts
    .filter((artifact) => artifact.retention === "reclaimable")
    .reduce((total, artifact) => total + artifact.bytes, 0);

  return {
    inventory,
    pressure: inventory.total.bytes >= pressureThresholdBytes ? "elevated" : "normal",
    pressure_threshold_bytes: pressureThresholdBytes,
    reclaimable_bytes: reclaimableBytes,
  };
}

function collectReasons(
  input: Pick<OperatorHealthModel, "pipeline" | "provider" | "recall" | "review" | "storage">,
): string[] {
  const reasons: string[] = [];

  if (!input.pipeline.gate.session_integrity.ok) reasons.push("session_integrity_violations");
  if (input.provider !== null && !input.provider.ok) reasons.push("provider_unavailable");
  if (!input.pipeline.gate.llm_budget.allowed) reasons.push("llm_budget_exhausted");
  if (!input.pipeline.gate.usd_budget.allowed) reasons.push("llm_usd_budget_exhausted");
  if (input.pipeline.pending_sessions > 0) reasons.push("pending_ingest");
  if (input.pipeline.pending_learnings > 0) reasons.push("pending_review");
  if (input.review.freshness === "stale") reasons.push("review_stale");
  if (input.review.freshness === "missing") reasons.push("review_missing");
  if (input.recall.failed_fires > 0) reasons.push("recall_failures");
  if (!hasReachableMemory(input.recall.reachability)) reasons.push("no_reachable_memory");
  if (input.storage.pressure === "elevated") reasons.push("storage_pressure");

  return reasons;
}

function hasReachableMemory(reachability: ReachabilitySnapshot): boolean {
  return reachability.reachable + reachability.global_reachable > 0;
}

function recommendNextAction(
  input: Pick<OperatorHealthModel, "pipeline" | "provider" | "recall" | "review" | "storage">,
): OperatorHealthRecommendation {
  if (!input.pipeline.gate.session_integrity.ok) {
    return { command: "asd check", reason: "session_integrity_violations" };
  }
  if (input.provider !== null && !input.provider.ok) {
    return { command: "asd doctor provider", reason: "provider_unavailable" };
  }
  if (!input.pipeline.gate.llm_budget.allowed || !input.pipeline.gate.usd_budget.allowed) {
    return { command: "asd quality cost-report", reason: "llm_budget_exhausted" };
  }
  if (input.pipeline.pending_sessions > 0) {
    return { command: "asd ingest sync --source cursor", reason: "pending_ingest" };
  }
  if (input.pipeline.pending_learnings > 0) {
    return { command: "asd quality review-learnings --if-new", reason: "pending_review" };
  }
  if (input.review.freshness === "stale" || input.review.freshness === "missing") {
    return {
      command: "asd quality review-learnings --if-new",
      reason: input.review.freshness === "stale" ? "review_stale" : "review_missing",
    };
  }
  if (input.recall.failed_fires > 0 || !hasReachableMemory(input.recall.reachability)) {
    return {
      command: "asd recall --cwd .",
      reason: input.recall.failed_fires > 0 ? "recall_failures" : "no_reachable_memory",
    };
  }
  if (input.storage.pressure === "elevated") {
    return { command: "asd storage inventory --older-than-days 30", reason: "storage_pressure" };
  }
  return { command: "asd stats", reason: "healthy" };
}
