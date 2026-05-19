# ADR-0005: MCP tool surface cap

- Date: 2026-05-19
- Status: accepted (2026-05-19)
- Deciders: operator
- Related: [td-3d5e2b](#), claude-self-reflect (reference)

## Context

[td-3d5e2b] adds an MCP server exposing the distilled corpus to
running Claude Code sessions. claude-self-reflect ships **12 MCP
tools** (search, search_by_recency, search_by_file, search_insights,
…). Each tool is one more thing the model has to decide between.

asd is starting from zero. The question is how aggressively to ship
tool surface. The risk of "ship 12" is well-documented: more tools
→ more confusion → worse tool selection by the model. The risk of
"ship 1" is forcing every query through a generic search when a
specific shape would work better.

The ECC v2 / lamarck approach implicitly answers this by *not*
shipping MCP — they rely on file auto-load. asd has decided (via
the report) that MCP is the right runtime contract, so this ADR is
about the *count*.

## Options

### Option A — Hard cap at 3 for v1, measure, add only with evidence (recommended)

Initial tools:

1. `search_instincts(query, scope?, project?)` — semantic search.
2. `instincts_for_file(path)` — exact file-path lookup; leverages
   `source_refs.file_path`.
3. `recent_instincts(window, project?)` — chronological.

Add a 4th only when usage logs show a query pattern none of the
three handles well.

### Option B — Match claude-self-reflect's surface (12 tools)

Ship parity from day one. Includes aggregated-insight queries,
session-scoped queries, conversation traversal, etc.

### Option C — One generic tool

`asd_query(intent, params)`. Pass everything as a JSON intent. The
server routes internally.

### Option D — Tiered (3 visible + N gated)

3 default tools always loaded; a 4th `asd_advanced(...)` tool exposes
the long tail for power-user queries.

## Tradeoffs

| Aspect | A (cap 3) | B (12) | C (1 generic) | D (tiered) |
|---|---|---|---|---|
| Tool-selection accuracy by model | Best | Worst | Hard to evaluate | Good |
| Query expressiveness | OK | Best | Best (intent-routed) | Best |
| Implementation cost | Low | High | Low (one tool, complex schema) | Medium |
| Discoverability for model | Best | Worst | Worst (intent is opaque) | Good |
| Ability to grow surface | High | Locked in | High | High |
| Token cost per tool decision | Low | High | Low | Medium |

## Recommendation

**Option A.** Start with 3 well-named tools. The three named cover
the surface area observed in the survey:

- semantic (catch-all) → `search_instincts`
- structural (file-anchored) → `instincts_for_file`
- temporal (recency-anchored) → `recent_instincts`

Add a 4th only when measurement justifies it. Self-reflect's 12-tool
surface accumulated over time; asd has the chance to start lean.

A useful side rule: every new tool added later requires either a usage-log
data point showing demand, or an ADR amending this one. No "while
we're at it" tool growth.

## Decision

**Accepted: Option A — hard cap at 3 tools for v1, expand only with
usage-log evidence.**

Initial surface:

1. `search_instincts(query, scope?, project?, domain?, min_maturity?, limit?)`
2. `instincts_for_file(path, project?, include_proximal?, limit?)`
3. `recent_instincts(window_days, scope?, project?, domain?, only_new_or_changed?, limit?)`

Tool signatures already drafted at `src/v2/mcp/types.ts`. The
compile-time `_toolCountCheck` assertion in that file enforces the
cap so a tool can't be silently added.

Adding a 4th tool requires either (a) usage-log evidence that the
existing 3 don't serve a real query pattern, or (b) an ADR amending
this one. Usage logging is part of the v1 MCP server scope.

## Consequences

If A:

- MCP server scope for v1 is 3 tools. Done definition is clear.
- Add lightweight usage logging (which tool, which query, result
  count) so the 4th-tool decision is data-driven.
- ADR amendment required for any tool added later.

If B or D:

- Wider scope on [td-3d5e2b]; reschedule.

If C:

- Different mental model. The intent schema becomes the API; tool
  count stays 1. Worth revisiting if A's tool-selection quality is
  bad in practice.
