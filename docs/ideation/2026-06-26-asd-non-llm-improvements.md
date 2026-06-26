---
date: 2026-06-26
subject: Non-LLM-blocked improvement opportunities for agent-session-distillery (asd)
focus: runnable work that does NOT require OpenRouter/paid LLM calls
mode: repo
axes: [dashboard-ux, ingestion-quality, operator-dx, data-integrity, knowledge-store]
candidates_generated: 19
survivors: 6
---

# Ideation: asd non-LLM-blocked improvements

**Subject & grounding:** asd is a ~21K-LoC TypeScript CLI that ingests AI coding-session
transcripts, runs deterministic extraction/summarization/quality-audit, builds a single-file
offline HTML dashboard (`src/report/dashboard.ts`), and manages a knowledge/instinct store
(`src/v2/`, SQLite ledger in `src/db/`). The LLM-review path (`src/pipeline/llm-learning-review.ts`)
is externally blocked (OpenRouter account data-policy 404, see
`docs/solutions/tooling/openrouter-data-policy-404.md`), so this pass targets only the
deterministic surfaces. Grounded in a repo scan plus first-hand work this session on
`dashboard.ts`, `quality-audit.ts`, `summarize.ts`, `queue.ts`, and `llm-budget.ts`.

**Cull summary:** Generated 19 candidates, kept 6. Cut 13 for: contradicted basis (4 — the
grounding scan's "0 test files" is false; the pre-push hook runs 405 tests, so generic
"add tests" ideas were dropped or narrowed); below the discussion bar (5 — e.g. an
`asd report --open` convenience flag, the promote-queue full-scan perf TODO which the code
itself notes is "fine at current scale", a dark-mode toggle); redundant (4 — several
dashboard-UX variants merged into the drill-down idea).

## Ranked ideas

### 1. Corpus resummarize sweep to clean stale/leaked topics
- **Axis:** ingestion-quality
- **Basis:** `direct` — PR #81 (merged this session) fixed `isHarnessTopicLine` so `# Instructions (read first)` and similar wrapper headers no longer become topics, but the fix only affects *future* derivation. The corpus still carries the bad topics in archived summaries (29 sessions with `# Instructions (read first)`, plus the residual ambiguous set on td-64f195). The tooling to fix this already exists and is fully deterministic: `npm run corpus:resummarize` (`scripts/resummarize-corpus.mjs`) and the `pipeline reextract` command with `--llm-topic` off.
- **Why it matters:** Highest leverage × feasibility on the board — it makes a fix already shipped actually visible across the whole corpus (better dashboard topic quality for every affected session) using existing, no-LLM tooling. It compounds work already done rather than starting cold.
- **What exploring it looks like:** Confirm the resummarize path regenerates topics deterministically without touching manifests/learnings; scope a `--dry-run` to count how many archived topics would change; decide the backup step (this mutates real personal-corpus artifacts, so a backup + dry-run gate is mandatory before any write sweep).

### 2. Surface quality-audit findings in the dashboard
- **Axis:** dashboard-ux
- **Basis:** `direct` — `src/pipeline/quality-audit.ts` computes per-session issue codes (`process_chatter`, `topic_process_chatter`, `wrapper_tags`, `summary_low_signal`, deletion-readiness) and a count map, but `buildDashboardData(sessions, pipeline, knowledge, harness, reviewItems)` in `src/report/dashboard.ts` takes no audit input and renders none of it. The audit is computed but invisible.
- **Why it matters:** Turns an existing deterministic signal into an actionable view — operators could see chatter/wrapper/low-signal rates and deletion-readiness per session and make archival decisions without any LLM. Closes the loop between the audit that already runs and the UI that already exists.
- **What exploring it looks like:** Decide whether audit runs at dashboard-build time or is read from a persisted report; design the panel (per-session badges + a corpus rollup of issue-code counts); confirm it fits the existing eager-list / lazy-detail payload split without re-inflating the eager payload.

### 3. `asd doctor` — provider/health preflight command
- **Axis:** operator-dx
- **Basis:** `reasoned` + `direct` — across 4+ sessions the OpenRouter data-policy 404 was diagnosed by hand-running a raw `curl`/`review-learnings --max-total-learnings 1` probe each time; there is no built-in command to report provider routing, credential resolution, and budget headroom together. `src/pipeline/pipeline-gate.ts` already computes budget/idle gating and `llm-budget.ts` the USD/count ceilings — the pieces exist but aren't surfaced as a single health check.
- **Why it matters:** Directly attacks the recurring pain that has gated this repo for multiple sessions — one command would have surfaced "blocked on OpenRouter data policy" instantly instead of repeated manual diagnosis. Pure DX, no LLM call needed for the routing/credential/budget checks (a 1-token probe is optional and bounded).
- **What exploring it looks like:** Define the checklist (credential resolves from 1Password/env? model id valid against `/models`? a route exists under the account data policy? budget headroom?) and the output contract (JSON + human summary, exit codes), reusing the gate/budget code rather than re-deriving it.

### 4. Drill-down for the dashboard's trimmed top-N aggregate panels
- **Axis:** dashboard-ux
- **Basis:** `direct` — `dashboard.ts` trims knowledge/review panels to `KNOWLEDGE_PROJECTS_SHOWN=6`, `KNOWLEDGE_INSTINCTS_SHOWN=8`, `REVIEW_ITEMS_SHOWN=12` and ships only precomputed counts (`projects_count`, `review_stats`), so the remaining entries are unreachable from the UI — a deliberate payload-size tradeoff made this session.
- **Why it matters:** The corpus has far more than 6 projects / 12 reviews; today everything past the cap is invisible. A lazy "show all" (second JSON payload, same pattern as the lazy session-detail blocks) restores full visibility without re-inflating the eager parse.
- **What exploring it looks like:** Decide between a lazy full-aggregate payload vs. client-side pagination; confirm the approach keeps the eager `const data` payload small (the whole reason for the top-N trim) and reuses the existing `asd-detail`-style lazy-block mechanism.

### 5. Extend topic-leak filtering to corpus-validated wrapper headers + flag the ambiguous set
- **Axis:** ingestion-quality
- **Basis:** `direct` — the corpus scan this session found additional high-frequency wrapper-header topics beyond the one fixed in PR #81: `# TASK` (4), `## Context Usage` (3), `# Handoff` (1), `# Prompt Optimizer` (8). td-64f195 explicitly defers these because some `#` headings are *legitimate* topics (`# Career-Ops Job Search Pipeline`), and the existing test asserts `# ce-work …` is valid.
- **Why it matters:** Continues de-noising topic derivation using real evidence, but the value is gated on resolving the wrapper-vs-legit ambiguity — so the right move pairs a tight filter for the unambiguous structural headers (`# TASK`, `## Context Usage`, `# Handoff`) with a quality-audit *flag* (not a silent drop) for the genuinely ambiguous ones.
- **What exploring it looks like:** Classify each corpus heading as structural-noise vs. possible-topic with a quoted example; tight-filter only the unambiguous structural set (with tests mirroring PR #81); add a `topic_wrapper_heading` advisory issue code to quality-audit for the ambiguous remainder rather than guessing.

### 6. Session integrity check — orphan/duplicate/state-transition validation
- **Axis:** data-integrity
- **Basis:** `reasoned` — the SQLite ledger (`src/db/queries.ts`) tracks lifecycle state (ingested → reduced → summarized → archived) and revision-addressed manifests (ADR-0008), but there is no command that validates invariants (no duplicate `asd_session_id`, no orphaned manifests after workspace rename, no illegal state transitions). This is inferred from the schema/ADRs, not a quoted TODO, so the gap should be confirmed before sizing.
- **Why it matters:** Silent data-integrity drift (duplicate IDs, orphaned manifests) is the kind of failure that corrupts dashboard counts and knowledge rollups without an obvious error. A deterministic `asd check` would catch it early and is fully offline.
- **What exploring it looks like:** First verify which invariants are *not* already enforced at write time (don't build a checker for guarantees the writers already make); then scope the smallest valuable subset (duplicate-ID + orphan-manifest detection) as a read-only report command.
