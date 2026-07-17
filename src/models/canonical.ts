import { z } from "zod";

// Keep the canonical contract in one module for now so adapters, pipeline work,
// and artifact writers can share one import surface while the model set is still compact.

const isoTimestampSchema = z.string().datetime({ offset: true });
const nonEmptyStringSchema = z.string().min(1);

export const eventTypes = [
  "user_message",
  "assistant_message",
  "tool_use",
  "tool_result_stub",
  "decision",
  "failure",
  "fix",
  "verification",
  "next_step",
] as const;

export const learningScopes = ["project", "user"] as const;

export const learningKinds = [
  "decision",
  "pattern",
  "preference",
  "workflow",
  "failure_mode",
  "verification_rule",
  // An approach that was tried and abandoned — a negative-polarity learning that
  // steers future work away from a known dead end (see classification contract).
  "dead_end",
] as const;

export const ingestStatuses = [
  "discovered",
  "parsed",
  "reduced",
  "summarized",
  "extracted",
  "archived",
  "deletion_candidate",
  "deleted",
  "error",
] as const;

export const retentionStatuses = ["kept", "archived", "eligible_for_delete", "deleted"] as const;

export const confidenceLevels = ["high", "medium", "low"] as const;

// Trust tier of a learning, ordered most- to least-trusted. `verified` = backed
// by observed fix and/or verification evidence in the transcript (not a guess);
// `user_stated` = a direct operator instruction; `inferred` = a
// deterministic/heuristic extraction claim; `model_inferred` is reserved for the
// future LLM extraction path (kept distinct so a model guess never shares a tier
// with a deterministic claim).
export const evidenceTypes = ["verified", "user_stated", "inferred", "model_inferred"] as const;

export type EventType = (typeof eventTypes)[number];
export type LearningScope = (typeof learningScopes)[number];
export type LearningKind = (typeof learningKinds)[number];
export type IngestStatus = (typeof ingestStatuses)[number];
export type RetentionStatus = (typeof retentionStatuses)[number];
export type ConfidenceLevel = (typeof confidenceLevels)[number];
export type EvidenceType = (typeof evidenceTypes)[number];

export type JsonValue =
  | boolean
  | null
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const eventTypeSchema = z.enum(eventTypes);
export const learningScopeSchema = z.enum(learningScopes);
export const learningKindSchema = z.enum(learningKinds);
export const ingestStatusSchema = z.enum(ingestStatuses);
export const retentionStatusSchema = z.enum(retentionStatuses);
export const confidenceLevelSchema = z.enum(confidenceLevels);
export const evidenceTypeSchema = z.enum(evidenceTypes);

export const sourceRefSchema = z.object({
  source_path: nonEmptyStringSchema,
  source_hash: nonEmptyStringSchema,
  session_id: nonEmptyStringSchema,
  turn_id: nonEmptyStringSchema.nullable(),
  event_id: nonEmptyStringSchema.nullable(),
  line: z.number().int().nonnegative().nullable(),
});

export const sourceSessionSchema = z.object({
  source_tool: nonEmptyStringSchema,
  source_format: nonEmptyStringSchema,
  source_path: nonEmptyStringSchema,
  source_hash: nonEmptyStringSchema,
  workspace_path: nonEmptyStringSchema,
  project_key: nonEmptyStringSchema,
  session_id: nonEmptyStringSchema,
  conversation_id: nonEmptyStringSchema,
  started_at: isoTimestampSchema,
  updated_at: isoTimestampSchema,
  ingest_status: ingestStatusSchema,
  retention_status: retentionStatusSchema,
});

export const turnSchema = z.object({
  turn_id: nonEmptyStringSchema,
  session_id: nonEmptyStringSchema,
  index: z.number().int().nonnegative(),
  user_prompt: nonEmptyStringSchema,
  assistant_summary: nonEmptyStringSchema,
  tool_stub_count: z.number().int().nonnegative(),
  files_touched: z.array(nonEmptyStringSchema),
  commands_seen: z.array(nonEmptyStringSchema),
  verification_seen: z.boolean(),
  started_at: isoTimestampSchema,
  ended_at: isoTimestampSchema,
});

export const eventSchema = z.object({
  event_id: nonEmptyStringSchema,
  turn_id: nonEmptyStringSchema,
  type: eventTypeSchema,
  summary: nonEmptyStringSchema,
  payload_small: z.record(z.string(), jsonValueSchema),
  confidence: confidenceLevelSchema,
  source_offsets: z.object({
    start_line: z.number().int().nonnegative().nullable(),
    end_line: z.number().int().nonnegative().nullable(),
  }),
});

// Backward-compat default for learnings persisted before `trigger` became a
// required tier-1 field. Fresh extractions always set a real trigger (the
// extractor falls back to a project-scoped signature), so this only fills the
// field on records written before the field existed, instead of aborting the
// whole pipeline on parse. Mirrors the `.default([])` treatment the tier-2
// `technologies`/`skill_ref` fields already got.
const legacyLearningTrigger =
  "When a similar situation recurs (legacy learning; original trigger not recorded).";

export const learningSchema = z.object({
  learning_id: nonEmptyStringSchema,
  scope: learningScopeSchema,
  scope_key: nonEmptyStringSchema,
  kind: learningKindSchema,
  title: nonEmptyStringSchema,
  // Precondition — "when this matters". Gates contextual recall and is the
  // identity input on the durable Instinct (see learning-classification-contract).
  // `.default` only applies to legacy records missing the field; live extraction
  // always sets a real trigger.
  trigger: nonEmptyStringSchema.default(legacyLearningTrigger),
  statement: nonEmptyStringSchema,
  evidence: z.array(nonEmptyStringSchema),
  confidence: confidenceLevelSchema,
  // Trust tier of the evidence behind this learning (see evidenceTypes).
  // Legacy records predate this field; default them to `inferred`, the tier for a
  // deterministic/heuristic extraction claim (these learnings came from the
  // deterministic extractor, never the LLM path that owns `model_inferred`).
  evidence_type: evidenceTypeSchema.default("inferred"),
  // Subject — technologies/entities the source session touched (languages, package
  // managers, CLIs). Always present; `[]` when nothing is detected. Deterministic.
  technologies: z.array(nonEmptyStringSchema).default([]),
  // Capability — harness skill(s) this learning informs, for contextual injection.
  // Always present; `[]` when no skill maps. Deterministic command->skill lookup.
  skill_ref: z.array(nonEmptyStringSchema).default([]),
  promotion_basis: nonEmptyStringSchema,
  source_refs: z.array(sourceRefSchema),
});

export const summarySchema = z.object({
  session_id: nonEmptyStringSchema,
  topic: nonEmptyStringSchema,
  topic_source: z.enum(["deterministic", "llm"]).default("deterministic"),
  what_worked: z.array(nonEmptyStringSchema),
  what_failed: z.array(nonEmptyStringSchema),
  what_was_decided: z.array(nonEmptyStringSchema),
  useful_commands: z.array(nonEmptyStringSchema),
  files_of_interest: z.array(nonEmptyStringSchema),
  next_step: nonEmptyStringSchema,
  project_learnings: z.array(nonEmptyStringSchema),
  user_learnings: z.array(nonEmptyStringSchema),
  deletion_readiness: nonEmptyStringSchema,
});

export const retentionReceiptSchema = z.object({
  session_id: nonEmptyStringSchema,
  source_hash: nonEmptyStringSchema,
  extracted_at: isoTimestampSchema,
  summary_written: z.boolean(),
  project_learnings_written: z.boolean(),
  user_learnings_written: z.boolean(),
  archive_copy_written: z.boolean(),
  safe_to_delete: z.boolean(),
  reason_if_not: z.string(),
});

export const rawSourceArchiveReceiptSchema = z.object({
  archive_path: nonEmptyStringSchema,
  archive_sha256: nonEmptyStringSchema,
  archived_at: isoTimestampSchema,
  compressed_bytes: z.number().int().nonnegative(),
  session_id: nonEmptyStringSchema,
  source_bytes: z.number().int().nonnegative(),
  source_hash: nonEmptyStringSchema,
  source_path: nonEmptyStringSchema,
  source_removed_at: isoTimestampSchema.nullable(),
  source_tool: nonEmptyStringSchema,
});

export type SourceRef = z.infer<typeof sourceRefSchema>;
export type SourceSession = z.infer<typeof sourceSessionSchema>;
export type Turn = z.infer<typeof turnSchema>;
export type Event = z.infer<typeof eventSchema>;
export type Learning = z.infer<typeof learningSchema>;
export type Summary = z.infer<typeof summarySchema>;
export type RetentionReceipt = z.infer<typeof retentionReceiptSchema>;
export type RawSourceArchiveReceipt = z.infer<typeof rawSourceArchiveReceiptSchema>;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    const record = value as Record<string, unknown>;

    for (const child of Object.values(record)) {
      deepFreeze(child);
    }

    Object.freeze(value);
  }

  return value;
}

export const sourceSessionFixture: Readonly<SourceSession> = deepFreeze({
  source_tool: "cursor",
  source_format: "jsonl",
  source_path: "/Users/example/.cursor/projects/demo/agent-transcripts/run/session.jsonl",
  source_hash: "sha256:session-0001",
  workspace_path: "/Users/example/Code/demo",
  project_key: "demo",
  session_id: "session-0001",
  conversation_id: "conversation-0001",
  started_at: "2026-05-16T08:30:00Z",
  updated_at: "2026-05-16T08:33:00Z",
  ingest_status: "summarized",
  retention_status: "kept",
});

export const turnFixture: Readonly<Turn> = deepFreeze({
  turn_id: "turn-0001",
  session_id: "session-0001",
  index: 0,
  user_prompt: "Implement canonical distillery models.",
  assistant_summary: "Added the canonical schemas and validation fixtures.",
  tool_stub_count: 1,
  files_touched: ["src/models/canonical.ts", "test/canonical.test.mjs"],
  commands_seen: ["npm run build", "npm test"],
  verification_seen: true,
  started_at: "2026-05-16T08:30:00Z",
  ended_at: "2026-05-16T08:30:03Z",
});

export const eventFixture: Readonly<Event> = deepFreeze({
  event_id: "event-0001",
  turn_id: "turn-0001",
  type: "decision",
  summary: "Kept the canonical model in one module for now.",
  payload_small: {
    rationale: "Single import surface while the model set is still compact.",
  },
  confidence: "high",
  source_offsets: {
    start_line: 1,
    end_line: 3,
  },
});

export const learningFixture: Readonly<Learning> = deepFreeze({
  learning_id: "learning-0001",
  scope: "project",
  scope_key: "agent-session-distillery",
  kind: "decision",
  title: "Canonical model lives in one file during early slices",
  trigger: "When revisiting related design decisions in agent-session-distillery.",
  statement:
    "Keep the canonical contract in one focused module until adapters and pipeline code justify splitting it.",
  evidence: ["Task 2 implementation grouped all model contracts under src/models/canonical.ts."],
  confidence: "high",
  evidence_type: "inferred",
  technologies: ["typescript"],
  skill_ref: [],
  promotion_basis: "Explicit implementation decision captured during scaffolding.",
  source_refs: [
    {
      source_path: sourceSessionFixture.source_path,
      source_hash: sourceSessionFixture.source_hash,
      session_id: sourceSessionFixture.session_id,
      turn_id: turnFixture.turn_id,
      event_id: eventFixture.event_id,
      line: 1,
    },
  ],
});

export const summaryFixture: Readonly<Summary> = deepFreeze({
  session_id: "session-0001",
  topic: "Canonical schema implementation",
  topic_source: "deterministic",
  what_worked: ["TypeScript schemas compiled cleanly.", "Runtime validation tests passed."],
  what_failed: [],
  what_was_decided: [
    "Use one canonical schema module until the model surface becomes large enough to split.",
  ],
  useful_commands: ["npm run build", "npm test"],
  files_of_interest: ["src/models/canonical.ts", "test/canonical.test.mjs"],
  next_step: "Implement the ledger database and migration layer.",
  project_learnings: [learningFixture.statement],
  user_learnings: [],
  deletion_readiness: "not_ready",
});

export const retentionReceiptFixture: Readonly<RetentionReceipt> = deepFreeze({
  session_id: "session-0001",
  source_hash: "sha256:session-0001",
  extracted_at: "2026-05-16T08:33:07Z",
  summary_written: true,
  project_learnings_written: true,
  user_learnings_written: false,
  archive_copy_written: false,
  safe_to_delete: false,
  reason_if_not: "Archive copy has not been written yet.",
});
