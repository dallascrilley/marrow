// MCP tool input/output types — capped at 3 tools per ADR-0005.
// Spec inspiration: ramakay/claude-self-reflect (which ships 12).
// Type-only. Not imported by v1 code paths.

import { z } from "zod";
import {
  domainSchema,
  instinctIdSchema,
  maturitySchema,
  scopeSchema,
  type Instinct,
} from "../instinct/schema.js";

// Hard cap on the number of tools the MCP server exposes. New tools require
// either usage-log evidence or an ADR amending 0005.
export const MAX_MCP_TOOLS = 3 as const;

// Common: result envelope. All tools return this shape so the model has a
// consistent surface across the cap.

export interface InstinctHit {
  instinct: Instinct;
  score: number; // 0..1; semantics differ per tool (see each below).
  reason: string; // short human-readable; why this matched.
}

export const instinctHitSchema = z.object({
  // Embedding the full instinct shape is overkill in the Zod-validated form;
  // the runtime emits the instinct as JSON. Schema here is mostly for input
  // validation. Output validation is by hand in the server.
  instinct: z.any(),
  score: z.number().min(0).max(1),
  reason: z.string(),
}) as z.ZodType<InstinctHit>;

// ---- Tool 1: search_instincts ----------------------------------------
// Semantic search across the corpus. score = cosine similarity if local
// embedding index is available, otherwise BM25-ish rank fallback.

export const searchInstinctsInputSchema = z.object({
  query: z.string().min(1).max(500),
  scope: scopeSchema.optional(), // default: both
  project_id: z.string().optional(), // default: caller's resolved project
  domain: domainSchema.optional(),
  min_maturity: maturitySchema.optional(), // default: "established"
  limit: z.number().int().min(1).max(20).default(5),
});
export type SearchInstinctsInput = z.infer<typeof searchInstinctsInputSchema>;

export interface SearchInstinctsOutput {
  hits: InstinctHit[];
  total_in_corpus: number;
  truncated: boolean;
}

// ---- Tool 2: instincts_for_file --------------------------------------
// Exact file-path lookup. score = 1.0 for direct hit, <1.0 for proximal
// (sibling file, same directory).

export const instinctsForFileInputSchema = z.object({
  path: z.string().min(1),
  project_id: z.string().optional(),
  include_proximal: z.boolean().default(false),
  limit: z.number().int().min(1).max(20).default(10),
});
export type InstinctsForFileInput = z.infer<typeof instinctsForFileInputSchema>;

export interface InstinctsForFileOutput {
  exact_hits: InstinctHit[];
  proximal_hits: InstinctHit[]; // empty unless include_proximal=true
}

// ---- Tool 3: recent_instincts ----------------------------------------
// Chronological. score = recency weight, 1.0 = newest.

export const recentInstinctsInputSchema = z.object({
  window_days: z.number().int().min(1).max(365).default(14),
  scope: scopeSchema.optional(),
  project_id: z.string().optional(),
  domain: domainSchema.optional(),
  only_new_or_changed: z.boolean().default(false),
  limit: z.number().int().min(1).max(50).default(10),
});
export type RecentInstinctsInput = z.infer<typeof recentInstinctsInputSchema>;

export interface RecentInstinctsOutput {
  hits: InstinctHit[];
  window_start: string; // ISO timestamp
  window_end: string;
}

// ---- Tool catalog (for registration with the MCP runtime) -----------

export interface McpToolDescriptor<I, O> {
  name: string;
  description: string;
  inputSchema: z.ZodType<I>;
  // Output schema is intentionally informational; runtime serializer
  // does the encoding. The TS type O is the contract.
  outputContract: string;
}

export const searchInstinctsTool: McpToolDescriptor<
  SearchInstinctsInput,
  SearchInstinctsOutput
> = {
  name: "search_instincts",
  description:
    "Semantic search across distilled instincts. Use to find prior learnings related to a topic or problem.",
  inputSchema: searchInstinctsInputSchema,
  outputContract: "SearchInstinctsOutput",
};

export const instinctsForFileTool: McpToolDescriptor<
  InstinctsForFileInput,
  InstinctsForFileOutput
> = {
  name: "instincts_for_file",
  description:
    "Look up instincts whose source_refs touch a given file path. Use when starting work on a specific file.",
  inputSchema: instinctsForFileInputSchema,
  outputContract: "InstinctsForFileOutput",
};

export const recentInstinctsTool: McpToolDescriptor<
  RecentInstinctsInput,
  RecentInstinctsOutput
> = {
  name: "recent_instincts",
  description:
    "List instincts created or updated within a recent time window. Use for catching up after time away.",
  inputSchema: recentInstinctsInputSchema,
  outputContract: "RecentInstinctsOutput",
};

export const allTools = [
  searchInstinctsTool,
  instinctsForFileTool,
  recentInstinctsTool,
] as const;

// Runtime assertion: never exceed the cap without amending ADR-0005.
// Kept as a literal compile-time check, since `allTools` is a const tuple.
type AssertLength<T extends readonly unknown[], N extends number> =
  T["length"] extends N ? true : never;
const _toolCountCheck: AssertLength<typeof allTools, typeof MAX_MCP_TOOLS> =
  true;
void _toolCountCheck;

// Usage-log entry. Required so the 4th-tool decision is data-driven.
export interface McpUsageLogEntry {
  tool: (typeof allTools)[number]["name"];
  ts: string; // ISO
  input_size_chars: number;
  result_count: number;
  duration_ms: number;
  session_id?: string;
}
