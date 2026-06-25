---
date: 2026-06-24
topic: Interactive agent-session dashboard
type: design-note / roadmap
status: draft — awaiting review
source_ideation: docs/ideation/2026-06-24-agent-session-dashboard.md
delivery_posture: static HTML now, server-ready read layer for later
scope: MVP-first, then expand
---

# Roadmap: Interactive Agent-Session Dashboard

## 1. Summary

Give ASD a human-facing way to explore and view ingested agent sessions, without
breaking the project's deliberate **"No dev server: CLI-only"** posture
(`PROJECT_CONTEXT.md`). The spine is a **static single-file HTML report** produced
by a new `asd report` command: data is read through one **shared, typed read
module** and inlined into a self-contained `dashboard.html` that opens via
`file://`. Interactivity (search-as-you-type, facet filters, drill-down) is
client-side. The read module is designed so a future local server can serve the
same data for live, write-back features (review triage) **without rework**.

Derived from ideation survivors #1 (static HTML spine), #7 (shared read model),
#6 (session detail), #2 (pipeline observability), #3 (knowledge explorer),
#5 (cross-harness comparison), #4 (review triage).

## 2. Goals / Non-goals

**Goals**
- A no-server, self-contained interactive view of all ingested sessions.
- One typed read layer shared by CLI `search`, MCP server, and the dashboard.
- Operational visibility (pipeline lifecycle state) and content reading
  (session detail) in the MVP.
- A read layer whose interface is server-ready (returns plain typed data, no
  HTML/CLI coupling).

**Non-goals (now)**
- A long-running web server or live UI (deferred; see Phase 4 gate).
- Write-back actions from the dashboard (approve/discard). MVP is read-only;
  CLI remains the actor.
- Re-bloating pruned payloads — the reader view uses the reduced/tagged event
  stream, not full raw transcripts.
- Auth, multi-user, hosted deployment (single-operator, local-only by design).

## 3. Architecture

### 3.1 Shared read layer (the spine — Phase 1)

Today three consumers read the store independently and risk drift:
- `src/commands/search.ts` reads `index/session-index.jsonl` directly.
- `src/commands/mcp.ts` → `src/v2/mcp/query.js` reads instincts.
- A dashboard would be a fourth ad-hoc reader.

Introduce a single read module (proposed `src/read/`) exposing typed,
presentation-agnostic functions over the existing stores
(`sessions.sqlite` via `src/db/queries.ts`, `session-index.jsonl`, summaries,
knowledge JSONL). Contract sketch (names indicative, to firm up in planning):

```
listSessions(filter?): SessionListItem[]        // index + lifecycle state
getSession(uuid): SessionDetail                 // summary + reduced/tagged timeline
listPipelineStatus(): SessionPhaseStatus[]      // phase grid, stale/failed, run age
listKnowledge(filter?): KnowledgeItem[]         // learnings/instincts + provenance
harnessBreakdown(): HarnessStats[]              // volume/topic/cost/yield per adapter
listReviewQueue(): ReviewItem[]                 // pending triage (read-only in MVP)
```

Rules:
- Returns plain typed data (Zod-validated where schemas exist); **no** HTML,
  no CLI formatting, no process.stdout.
- CLI `search` and MCP server are refactored to consume it (proves the
  abstraction and kills drift). This refactor is the gate for everything after.
- Server-ready: a future `asd serve` would import the same functions; the static
  exporter and a server differ only in transport.

### 3.2 Static HTML exporter (Phase 2)

New command `asd report [--html] [--out <path>]`:
- Calls the read layer, serializes results to JSON, inlines into a template
  (`src/report/` template + vanilla JS; no framework, no build step — matches
  repo's zero-dev-server, npm/tsc-only stance).
- Output: one `dashboard.html` (default under the runtime root or `--out`).
- Client JS handles filter/sort/search/expand entirely in-browser.
- Open question to resolve in planning: full inline vs. lazy summary bodies for
  large corpora (see Risks).

### 3.3 Views

| View | Idea | Phase | Read fn |
|------|------|-------|---------|
| Session list + facet filter/search | #1 | 2 | `listSessions` |
| Session detail / tagged timeline | #6 | 2 | `getSession` |
| Pipeline health (phase grid, stale/failed) | #2 | 3 | `listPipelineStatus` |
| Knowledge & instinct explorer + provenance | #3 | 3 | `listKnowledge` |
| Cross-harness comparison | #5 | 3 | `harnessBreakdown` |
| Review-queue triage (read-only) | #4 | 4 | `listReviewQueue` |

## 4. Phased roadmap

### Phase 1 — Shared read layer (foundation, blocking)
- Extract `src/read/` with the typed functions above over existing stores.
- Refactor `asd search` and the MCP query path to consume it.
- Acceptance: `asd search` behavior unchanged; MCP tools unchanged; new module
  unit-tested; `script/cibuild` green.

### Phase 2 — Static dashboard MVP
- `asd report --html` emits self-contained `dashboard.html`.
- Session list (search/filter/sort) + session detail (summary + reduced/tagged
  timeline), each session showing its lifecycle state badge.
- Acceptance: open `dashboard.html` offline; list filters and drill-down work
  with no network; renders a realistic local corpus.

### Phase 3 — Observability & insight expansion
- Add pipeline-health view (#2), knowledge/instinct explorer with back-links
  (#3), cross-harness comparison (#5), reusing existing aggregations
  (`topic-distribution.ts`, quality-cost report).
- Acceptance: each view added behind the same exporter; no new runtime
  dependency; cibuild green.

### Phase 4 — Triage & the server decision (gate)
- Read-only review-queue view (#4) ships in the static report first.
- **Explicit gate:** write-back triage requires reversing "No dev server."
  Re-evaluate then: if approved, add `asd serve` reusing the Phase-1 read layer
  for live data + a thin write path. Do **not** build the server speculatively.

## 5. Risks & open questions
- **Inline payload size:** inlining all summaries may bloat `dashboard.html` for
  large corpora. Mitigation: inline list + lazy-load detail, or paginate/cap.
  Resolve in Phase 2 planning with a real corpus measurement.
- **Posture drift:** the static spine must not quietly become a server. Phase 4
  gate is deliberate; document the decision if reversed.
- **Read-layer scope creep:** keep `src/read/` presentation-agnostic; resist
  pushing formatting into it.
- **Schema coupling:** reuse `summarySchema`, `sessionIndexRecordSchema`, and
  ledger row types rather than redefining shapes.

## 6. Decision log
- **Static HTML now, server-ready read layer later** (chosen over static-only and
  server-now): preserves CLI-only constraint while avoiding a future rewrite.
- **MVP-first** (read layer + list + detail) before observability/knowledge/
  triage: validates the spine cheaply before breadth.
- **Read-only triage in MVP**, write-back gated behind an explicit posture
  reversal: avoids speculative server work (YAGNI).

## 7. Next step
Review this note. On approval, move Phase 1 into the repo's implementation/
planning workflow (e.g. a `docs/plans/...-plan.md` execution plan or `td` epic
mirroring §4 phases).
