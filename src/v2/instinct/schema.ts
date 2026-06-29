// Atomic instinct schema — v2 storage unit.
// Specification: docs/specs/atomic-instinct-schema.md
// Decision: docs/decisions/0001-storage-unit.md (accepted)
//
// v2 storage types — imported by pipeline bridges and tests only.

import { z } from "zod";

export const SCHEMA_VERSION = 1 as const;

const isoTimestampSchema = z.string().datetime({ offset: true });
const nonEmptyStringSchema = z.string().min(1);

export const domains = [
  "code-style",
  "testing",
  "git",
  "debugging",
  "workflow",
  "tooling",
  "security",
  "performance",
  "product",
] as const;
export type Domain = (typeof domains)[number];
export const domainSchema = z.enum(domains);

export const maturityLevels = ["candidate", "established", "proven", "deprecated"] as const;
export type Maturity = (typeof maturityLevels)[number];
export const maturitySchema = z.enum(maturityLevels);

export const scopes = ["project", "global"] as const;
export type Scope = (typeof scopes)[number];
export const scopeSchema = z.enum(scopes);

// Confidence floor and ceiling from ADR-0001 / spec.
export const CONFIDENCE_MIN = 0.3;
export const CONFIDENCE_MAX = 0.9;
export const confidenceSchema = z.number().min(CONFIDENCE_MIN).max(CONFIDENCE_MAX);

// id format: kebab(slug) + "-" + 8 hex. Total length 8..80.
export const instinctIdSchema = z
  .string()
  .regex(/^[a-z0-9-]+-[0-9a-f]{8}$/)
  .min(8)
  .max(80);
export type InstinctId = z.infer<typeof instinctIdSchema>;

export const sourceRefSchema = z.object({
  kind: z.enum(["file", "function", "command", "url"]),
  path: nonEmptyStringSchema,
  session: nonEmptyStringSchema,
});
export type SourceRef = z.infer<typeof sourceRefSchema>;

export const observationSchema = z.object({
  session: nonEmptyStringSchema,
  reinforcing: z.boolean(),
  at: isoTimestampSchema,
  correction: z.string().optional(),
});
export type Observation = z.infer<typeof observationSchema>;

export const instinctSchema = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  id: instinctIdSchema,
  trigger: nonEmptyStringSchema,
  finding: nonEmptyStringSchema,
  confidence: confidenceSchema,
  // Create-time confidence floor, derived from the learning's signal level
  // (high/medium/low). The recompute base in decay.ts; legacy YAML without
  // this field defaults to 0.5 to preserve existing behavior.
  confidence_floor: confidenceSchema.default(0.5),
  domain: domainSchema,
  maturity: maturitySchema,
  scope: scopeSchema,
  // Empty string when scope === "global" and instinct has been promoted.
  project_id: z.string(),
  source: z.object({
    first_session: nonEmptyStringSchema,
    first_observed_at: isoTimestampSchema,
    source_refs: z.array(sourceRefSchema),
    observations: z.array(observationSchema).min(1),
  }),
  related: z.array(instinctIdSchema).default([]),
  created_at: isoTimestampSchema,
  updated_at: isoTimestampSchema,
  last_promoted_at: isoTimestampSchema.nullable(),
});
export type Instinct = z.infer<typeof instinctSchema>;

// ---- Session bundle: the immutable audit-trail record per session. -----

export const deltaOpSchema = z.enum([
  "create",
  "reinforce",
  "correct",
  "deprecate",
  "merge",
  "revive",
]);
export type DeltaOp = z.infer<typeof deltaOpSchema>;

export const createDeltaSchema = z.object({
  op: z.literal("create"),
  instinct_id: instinctIdSchema,
  trigger: nonEmptyStringSchema,
  finding: nonEmptyStringSchema,
  domain: domainSchema,
  initial_confidence: confidenceSchema,
});
export type CreateDelta = z.infer<typeof createDeltaSchema>;

export const reinforceDeltaSchema = z.object({
  op: z.literal("reinforce"),
  instinct_id: instinctIdSchema,
  delta: z.object({ confidence: z.number() }),
});

export const correctDeltaSchema = z.object({
  op: z.literal("correct"),
  instinct_id: instinctIdSchema,
  correction: nonEmptyStringSchema,
  delta: z.object({ confidence: z.number() }),
});

export const deprecateDeltaSchema = z.object({
  op: z.literal("deprecate"),
  instinct_id: instinctIdSchema,
  reason: nonEmptyStringSchema,
});

export const mergeDeltaSchema = z.object({
  op: z.literal("merge"),
  instinct_id: instinctIdSchema,
  into: instinctIdSchema,
});

export const reviveDeltaSchema = z.object({
  op: z.literal("revive"),
  instinct_id: instinctIdSchema,
  reason: nonEmptyStringSchema,
});

export const deltaSchema = z.discriminatedUnion("op", [
  createDeltaSchema,
  reinforceDeltaSchema,
  correctDeltaSchema,
  deprecateDeltaSchema,
  mergeDeltaSchema,
  reviveDeltaSchema,
]);
export type Delta = z.infer<typeof deltaSchema>;

export const extractionCostSchema = z.object({
  model: nonEmptyStringSchema,
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  usd: z.number().nonnegative(),
});
export type ExtractionCost = z.infer<typeof extractionCostSchema>;

export const sessionBundleSchema = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  session_id: nonEmptyStringSchema,
  project_id: nonEmptyStringSchema,
  source_adapter: z.enum(["cursor", "claude-code", "codex-cli", "kimi", "pi"]),
  source_transcript: nonEmptyStringSchema,
  ingested_at: isoTimestampSchema,
  reviewed_at: isoTimestampSchema.nullable(),
  reviewer: nonEmptyStringSchema.nullable(),
  diary: z.string(),
  deltas: z.array(deltaSchema),
  extraction_cost: extractionCostSchema.nullable(),
});
export type SessionBundle = z.infer<typeof sessionBundleSchema>;

// ---- Maturity transition predicates. Pure; no I/O. ---------------------

export interface MaturityState {
  confidence: number;
  age_days: number;
  reinforcing_count: number;
  correction_count: number;
  survived_contradiction: boolean;
}

export function eligibleForEstablished(s: MaturityState): boolean {
  return s.confidence >= 0.6 && s.age_days >= 7 && s.reinforcing_count >= 2;
}

export function eligibleForProven(s: MaturityState): boolean {
  return (
    s.confidence >= 0.8 && s.age_days >= 30 && s.reinforcing_count >= 5 && s.survived_contradiction
  );
}

export function shouldDeprecate(s: MaturityState): boolean {
  return s.confidence < CONFIDENCE_MIN + 0.001;
}

// ---- ID generation helper. -------------------------------------------

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "be",
  "but",
  "by",
  "do",
  "for",
  "from",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "so",
  "that",
  "the",
  "this",
  "to",
  "when",
  "where",
  "while",
  "with",
]);

export function slugFromFinding(finding: string): string {
  const words = finding
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0 && !STOPWORDS.has(w));
  const deduped: string[] = [];
  for (const w of words) {
    if (deduped.length === 0 || deduped[deduped.length - 1] !== w) {
      deduped.push(w);
    }
    if (deduped.length >= 8) break;
  }
  return deduped.join("-");
}

// Implementation note: the hash suffix is sha256(trigger + "|" + finding).hex
// truncated to 8 chars. Implemented in the production module, not here, to
// keep this file dependency-free beyond zod.
