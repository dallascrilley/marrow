---
date: 2026-06-24
subject: An interactive dashboard for exploring and viewing agent sessions
focus: interactive dashboard / session exploration UI
mode: repo
axes: [browse-navigate, search-retrieval, pipeline-observability, knowledge-insight, delivery-architecture]
candidates_generated: 34
survivors: 7
---

# Ideation: An interactive dashboard for exploring and viewing agent sessions

**Subject & grounding:** ASD is a CLI-only tool (`asd`) that ingests local agent transcripts (Cursor, Claude Code, Codex, Kimi, Pi) through a deterministic pipeline (parse → reduce → summarize → extract → archive) into a durable runtime at `~/.agent-session-distillery`: a SQLite ledger (`sessions.sqlite`), `index/session-index.jsonl`, per-session summaries, knowledge JSONL, manifests, review queue, and deletion candidates (`src/db/queries.ts`, `src/commands/export-index.ts`). Human-facing read paths today are thin: `asd search` does substring filtering over the index (`src/commands/search.ts`) and an MCP stdio server exposes 3 instinct queries (`src/commands/mcp.ts`). A hard constraint shapes everything: `PROJECT_CONTEXT.md` declares **"No dev server: CLI-only"**, and `script/server` just prints `--help`. So a "dashboard" must either justify breaking that posture deliberately or deliver exploration without a long-running service.

**Cull summary:** Generated 34 candidates, kept 7. Cut 27 for: no verifiable basis or generic BI-dashboard slop (11), below the discussion bar / cosmetic (6), out of subject — replaced the pipeline rather than viewing it (4), redundant with a stronger sibling (6).

## Ranked ideas

### 1. Static single-file HTML report exporter (`asd report --html`)
- **Axis:** delivery-architecture
- **Basis:** `direct` — `PROJECT_CONTEXT.md`: "No dev server: CLI-only; `script/server` prints `--help`"; `src/commands/export-index.ts` already builds a structured `session-index.jsonl`; `src/writers/report-writer.ts` exists.
- **Why it matters:** The cheapest way to honor the CLI-only constraint and still get an *interactive* artifact. A command reads the existing index + summaries and emits one self-contained `dashboard.html` (data inlined as JSON, vanilla JS filter/sort/expand) that opens with `file://` — no server, no build step, no new runtime dependency. Interactivity (search-as-you-type, facet filters, expand-a-session) lives client-side. Becomes the foundation every other view idea can reuse.
- **What exploring it looks like:** What is the minimum data shape the HTML needs from the index vs. lazy-loading summary bodies, and does inlining everything stay under a sane file size for a realistic corpus?

### 2. Pipeline observability view: lifecycle state per session
- **Axis:** pipeline-observability
- **Basis:** `direct` — ledger already tracks `PhaseCheckpointRow`, `PhaseState`, `RunHistoryRow`, `LifecycleState` incl. `"stale"`, and `getDownstreamPhases()` for invalidation (`src/db/queries.ts:36-60,134-168`).
- **Why it matters:** The richest untapped data is *operational*, not content. A view showing each session's phase grid (parse/reduce/summarize/extract/archive × state), what's stale, what failed, and run history turns invisible pipeline state into something an operator can actually scan. This is the dashboard ASD uniquely can build because the ledger already records it — nobody else has this data.
- **What exploring it looks like:** Which lifecycle signals matter most at a glance (stale count, failed phase, last-run age), and is this a column in idea #1 or its own focused "pipeline health" surface?

### 3. Knowledge & instinct explorer with provenance back-links
- **Axis:** knowledge-insight
- **Basis:** `direct` — deterministic knowledge JSONL + LLM-reviewed sidecar (`PROJECT_CONTEXT.md` key decisions), `src/v2/instinct/`, MCP `search_instincts`/`recent_instincts` already implemented (`src/commands/mcp.ts`).
- **Why it matters:** Sessions are the raw material; the *extracted learnings and instincts* are the product. A view that browses learnings/instincts and lets you click back to the originating session(s) makes the distillation legible — you see not just "what was learned" but "from which session, via which phase." Directly leverages query logic that already exists for MCP.
- **What exploring it looks like:** Can the dashboard reuse the MCP query functions verbatim (shared read layer) so CLI, MCP, and dashboard never drift?

### 4. Review-queue triage surface
- **Axis:** browse-navigate
- **Basis:** `direct` — `ReviewQueueEntryRow`, `DeletionCandidateRow` with a `[REDACTED]`/discardable state in the ledger (`src/db/queries.ts:62-87`); deletion-safety decision in `PROJECT_CONTEXT.md`.
- **Why it matters:** There is already a human-in-the-loop concept (review queue, deletion candidates, no-signal sessions) but no human-friendly way to work it. A focused triage view — pending items, why each was queued, approve/discard — turns an existing data structure into an actual workflow. High leverage because the schema is done; only the view is missing.
- **What exploring it looks like:** Is triage read-only in v1 (dashboard shows, CLI acts) or does it need write-back, which would force the server question?

### 5. Cross-harness comparison view
- **Axis:** knowledge-insight
- **Basis:** `direct` — five adapters (`src/adapters/{cursor,claude-code,codex-cli,kimi,pi}/`) normalize to one canonical model; `src/pipeline/topic-distribution.ts` and quality-cost report already aggregate.
- **Why it matters:** ASD's distinctive position is that it sees *all* your harnesses in one normalized schema. A view that compares volume, topics, cost, and learning yield across Cursor vs Claude Code vs Codex etc. answers a question no single tool can: "where is my agent work actually happening, and which harness produces the most durable knowledge?" Turns normalization (an internal detail) into a user-facing payoff.
- **What exploring it looks like:** Which existing aggregations (topic-distribution, cost-report) are reusable as-is, and what's the smallest comparison that's genuinely insightful vs. vanity metrics?

### 6. Session detail / timeline reader
- **Axis:** browse-navigate
- **Basis:** `direct` — reducers already produce turn-grouping and event-tagging (`src/reducers/turn-grouping.ts`, `event-tagging.ts`); summaries are structured JSON (`summarySchema`).
- **Why it matters:** The literal core of "viewing agent sessions" — open one session and read it well: summary up top, then the reduced turn-by-turn timeline with tagged events (commands run, files touched, decisions). The distillery already computes this structure; today there's no readable rendering of it. Pairs naturally as the drill-down target for idea #1's list view.
- **What exploring it looks like:** What's the right grain — full transcript replay, or the reduced/tagged event stream only — to stay useful without re-bloating the payload the pipeline worked to prune?

### 7. Shared read-model layer as a deliberate prerequisite
- **Axis:** delivery-architecture
- **Basis:** `reasoned` — three read consumers now exist or are proposed (CLI `search`, MCP server, any dashboard) and each re-reads index/ledger independently (`search.ts` reads JSONL directly; `mcp.ts` calls `v2/mcp/query.js`). A first-principles argument: divergent read paths over the same store guarantee drift and triple maintenance.
- **Why it matters:** Whatever dashboard form wins, it should consume the *same* typed read functions the MCP server and CLI use, not a fourth ad-hoc reader. Naming this as its own idea prevents the dashboard from being built as a silo. It's the difference between a throwaway view and a durable third presentation of one read model.
- **What exploring it looks like:** Is there a clean `src/read/` (or extend `src/db/queries.ts`) module that CLI search, MCP, and dashboard all import — and what does extracting it cost?
