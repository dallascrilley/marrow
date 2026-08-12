// MCP query engine — pure reads over the instinct store. Capped at the 3
// tools defined in types.ts per ADR-0005. No mutation; safe to call from the
// stdio server or the CLI one-shot path.

import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";

import { getRuntimePath } from "../../config/paths.js";
import type { Instinct, Maturity, Scope } from "../instinct/schema.js";
import { loadAllInstincts } from "../instinct/store.js";
import { loadGlobalInstincts } from "../vault/render-memory.js";
import type {
  InstinctHit,
  InstinctsForFileInput,
  InstinctsForFileOutput,
  McpUsageLogEntry,
  RecentInstinctsInput,
  RecentInstinctsOutput,
  SearchInstinctsInput,
  SearchInstinctsOutput,
} from "./types.js";

const MATURITY_ORDER: Maturity[] = ["candidate", "established", "proven", "deprecated"];
const DEFAULT_PROJECT_SCOPE: Scope[] = ["project"];
const DEFAULT_COMBINED_SCOPE: Scope[] = ["project", "global"];

interface FilterOptions {
  domain?: string;
  minMaturity?: Maturity;
  scopes?: Set<Scope>;
}

export function getMcpUsageLogPath(): string {
  return join(getRuntimePath("reports"), "mcp-usage.jsonl");
}

export async function searchInstincts(input: SearchInstinctsInput): Promise<SearchInstinctsOutput> {
  const parsed = normalizeSearchInput(input);
  const corpus = await loadScopedInstincts(parsed.project_id, parsed.scopeList);
  const filtered = filterCorpus(
    corpus,
    buildFilterOptions(parsed.domain, parsed.min_maturity, parsed.scopeList),
  );
  const queryTerms = tokenize(parsed.query);
  const hits = filtered
    .map((instinct) => rankSearchHit(instinct, queryTerms))
    .filter((hit) => hit.score > 0)
    .sort(compareHits)
    .slice(0, parsed.limit);
  return {
    hits,
    total_in_corpus: filtered.length,
    truncated: hits.length < filtered.length,
  };
}

export async function instinctsForFile(
  input: InstinctsForFileInput,
): Promise<InstinctsForFileOutput> {
  const parsed = normalizeFileInput(input);
  const corpus = await loadScopedInstincts(parsed.project_id, DEFAULT_PROJECT_SCOPE);
  const target = normalizeComparablePath(parsed.path);
  const exactHits: InstinctHit[] = [];
  const proximalHits: InstinctHit[] = [];
  for (const instinct of corpus) {
    const best = bestFileMatch(instinct, target);
    if (!best) {
      continue;
    }
    if (best.kind === "exact") {
      exactHits.push(best.hit);
      continue;
    }
    if (parsed.include_proximal) {
      proximalHits.push(best.hit);
    }
  }
  exactHits.sort(compareHits);
  proximalHits.sort(compareHits);
  return {
    exact_hits: exactHits.slice(0, parsed.limit),
    proximal_hits: proximalHits.slice(0, parsed.limit),
  };
}

export async function recentInstincts(input: RecentInstinctsInput): Promise<RecentInstinctsOutput> {
  const parsed = normalizeRecentInput(input);
  const corpus = await loadScopedInstincts(parsed.project_id, parsed.scopeList);
  const filtered = filterCorpus(
    corpus,
    buildFilterOptions(parsed.domain, undefined, parsed.scopeList),
  );
  const windowEnd = latestTimestamp(filtered) ?? new Date().toISOString();
  const windowStart = subtractDays(windowEnd, parsed.window_days);
  const hits = filtered
    .filter((instinct) => instinct.updated_at >= windowStart && instinct.updated_at <= windowEnd)
    .filter(
      (instinct) => !parsed.only_new_or_changed || instinct.created_at === instinct.updated_at,
    )
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
    .slice(0, parsed.limit)
    .map((instinct, index, list) => ({
      instinct,
      score: list.length <= 1 ? 1 : 1 - index / list.length,
      reason: `Updated ${instinct.updated_at}.`,
    }));
  return {
    hits,
    window_start: windowStart,
    window_end: windowEnd,
  };
}

export async function appendMcpUsageLog(
  record: McpUsageLogEntry,
  options: { path?: string } = {},
): Promise<void> {
  const path = options.path ?? getMcpUsageLogPath();
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
  } catch (error) {
    console.warn(`[marrow] mcp usage log write failed (non-fatal): ${String(error)}`);
  }
}

async function loadScopedInstincts(projectId: string, scope: Scope[]): Promise<Instinct[]> {
  const scopes = new Set(scope);
  const result: Instinct[] = [];
  if (scopes.has("project")) {
    if (!projectId) {
      throw new Error("project_id is required when scope includes project instincts");
    }
    result.push(...(await loadAllInstincts(projectId)).values());
  }
  // Global scope was declared in DEFAULT_COMBINED_SCOPE but never loaded, so
  // every search/recent query silently dropped global-scope instincts. Load
  // them from the same store render/reachability read so the MCP query honors
  // the scope contract it advertises.
  if (scopes.has("global")) {
    result.push(...(await loadGlobalInstincts()));
  }
  return dedupeInstincts(result);
}

function dedupeInstincts(instincts: Instinct[]): Instinct[] {
  const map = new Map<string, Instinct>();
  for (const instinct of instincts) {
    const existing = map.get(instinct.id);
    if (!existing || instinct.updated_at > existing.updated_at) {
      map.set(instinct.id, instinct);
    }
  }
  return [...map.values()];
}

function filterCorpus(instincts: Instinct[], options: FilterOptions): Instinct[] {
  return instincts.filter((instinct) => {
    if (options.domain && instinct.domain !== options.domain) {
      return false;
    }
    if (options.scopes && !options.scopes.has(instinct.scope)) {
      return false;
    }
    if (
      options.minMaturity &&
      MATURITY_ORDER.indexOf(instinct.maturity) < MATURITY_ORDER.indexOf(options.minMaturity)
    ) {
      return false;
    }
    return instinct.maturity !== "deprecated";
  });
}

function rankSearchHit(instinct: Instinct, queryTerms: string[]): InstinctHit {
  const haystacks = [instinct.trigger, instinct.finding, instinct.domain, instinct.scope];
  let matched = 0;
  for (const term of queryTerms) {
    if (haystacks.some((value) => value.toLowerCase().includes(term))) {
      matched += 1;
    }
  }
  const sourcePathMatches = instinct.source.source_refs.filter((ref) =>
    queryTerms.some((term) => ref.path.toLowerCase().includes(term)),
  ).length;
  const score =
    queryTerms.length === 0
      ? 0
      : Math.min(1, (matched + sourcePathMatches * 0.5) / queryTerms.length);
  const reasonParts: string[] = [];
  if (matched > 0) {
    reasonParts.push(`Matched ${matched}/${queryTerms.length} query terms in trigger/finding.`);
  }
  if (sourcePathMatches > 0) {
    reasonParts.push(
      `Matched ${sourcePathMatches} source path${sourcePathMatches === 1 ? "" : "s"}.`,
    );
  }
  return {
    instinct,
    score,
    reason: reasonParts.join(" ") || "No strong lexical overlap.",
  };
}

function bestFileMatch(
  instinct: Instinct,
  targetPath: string,
): { kind: "exact" | "proximal"; hit: InstinctHit } | null {
  let best: { kind: "exact" | "proximal"; hit: InstinctHit } | null = null;
  for (const ref of instinct.source.source_refs) {
    const refPath = normalizeComparablePath(ref.path);
    if (refPath === targetPath) {
      return {
        kind: "exact",
        hit: { instinct, score: 1, reason: `Exact source_ref match: ${ref.path}` },
      };
    }
    const proximity = comparePathProximity(targetPath, refPath);
    if (proximity <= 0) {
      continue;
    }
    const candidate = {
      kind: "proximal" as const,
      hit: { instinct, score: proximity, reason: `Nearby source_ref match: ${ref.path}` },
    };
    if (!best || candidate.hit.score > best.hit.score) {
      best = candidate;
    }
  }
  return best;
}

function comparePathProximity(targetPath: string, refPath: string): number {
  const targetParts = targetPath.split("/").filter(Boolean);
  const refParts = refPath.split("/").filter(Boolean);
  if (targetParts.length === 0 || refParts.length === 0) {
    return 0;
  }
  const targetDir = targetParts.slice(0, -1).join("/");
  const refDir = refParts.slice(0, -1).join("/");
  if (targetDir.length > 0 && targetDir === refDir) {
    return 0.75;
  }
  if (targetParts[targetParts.length - 1] === refParts[refParts.length - 1]) {
    return 0.6;
  }
  return 0;
}

function compareHits(left: InstinctHit, right: InstinctHit): number {
  if (right.score !== left.score) {
    return right.score - left.score;
  }
  if (right.instinct.confidence !== left.instinct.confidence) {
    return right.instinct.confidence - left.instinct.confidence;
  }
  return right.instinct.updated_at.localeCompare(left.instinct.updated_at);
}

function latestTimestamp(instincts: Instinct[]): string | null {
  let latest: string | null = null;
  for (const instinct of instincts) {
    if (latest === null || instinct.updated_at > latest) {
      latest = instinct.updated_at;
    }
  }
  return latest;
}

function subtractDays(iso: string, days: number): string {
  const date = new Date(iso);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString();
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9_/-]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 1);
}

function normalizeComparablePath(value: string): string {
  return normalize(value).replace(/\\/g, "/").toLowerCase();
}

function buildFilterOptions(
  domain: string | undefined,
  minMaturity: Maturity | undefined,
  scope: Scope[],
): FilterOptions {
  const options: FilterOptions = { scopes: new Set(scope) };
  if (domain !== undefined) {
    options.domain = domain;
  }
  if (minMaturity !== undefined) {
    options.minMaturity = minMaturity;
  }
  return options;
}

function normalizeSearchInput(input: SearchInstinctsInput): SearchInstinctsInput & {
  scopeList: Scope[];
  project_id: string;
} {
  return {
    ...input,
    scopeList: input.scope ? [input.scope] : DEFAULT_COMBINED_SCOPE,
    project_id: input.project_id ?? "",
  };
}

function normalizeFileInput(input: InstinctsForFileInput): InstinctsForFileInput & {
  project_id: string;
} {
  if (!input.project_id) {
    throw new Error("instincts_for_file requires --project-id");
  }
  return { ...input, project_id: input.project_id };
}

function normalizeRecentInput(input: RecentInstinctsInput): RecentInstinctsInput & {
  scopeList: Scope[];
  project_id: string;
} {
  return {
    ...input,
    scopeList: input.scope ? [input.scope] : DEFAULT_COMBINED_SCOPE,
    project_id: input.project_id ?? "",
  };
}
