---
date: 2026-06-29
origin: chat-diagnosis (this session) — "how do we make this actually useful?"
td_epic: td-31338a
worktree_slug: feat/close-distillery-feedback-loop
---

# Close the distillery feedback loop

**Summary:** asd ingests and renders prolifically but delivers almost nothing
back to agents. The deterministic 80% (ingest → summarize → extract → render →
vault push) is mature and runs every 6h; the value-bearing 20% (reinforce →
promote → read-back) is unbuilt. This plan builds that 20% in nine
stable-numbered units, ordered by leverage: make agents *read* the memory
(U1–U2), make instincts *mature* so there is good memory to read (U3–U5), refine
the corpus and surface it globally (U6–U7), and measure the only number that
matters — instincts a future agent will actually see (U8) — then document the
new contract (U9).

This is a living document. Update **Progress**, **Surprises & Discoveries**,
**Decision Log**, and **Outcomes** at every stopping point. No `PLANS.md` exists
in this repo; default plan home is `docs/plans/`.

## Purpose / Big Picture

Today, across 259 projects and 2,009 instincts, exactly **2** instinct lines
have ever reached a vault `MEMORY.md`, and **nothing reads those files back**
into a session. After this plan:

- A new Claude Code (or Cursor/Codex) session in any ingested project
  automatically receives that project's curated memory at session start,
  plus any globally-promoted instincts.
- High-signal instincts climb past the `0.54` confidence floor and accrue
  reinforcement across sessions, so `established`/`proven` maturity and
  cross-project promotion (ADR-0006) actually fire instead of being dead code.
- `asd stats` reports *reachable* instincts (rendered + consumed), not just
  *produced* artifacts — so we measure delivered signal, the failure mode this
  whole exercise exists to fix.

## Progress

- [x] (2026-06-29) U1. SessionStart read-back: `asd recall` + hook installer — PR #95, 438 tests green, smoke-tested against the live vault
- [~] U2. In-repo half **done** (2026-06-29, PR #95 commit dd40ab0): `query.ts` now loads global-scope instincts (the requested-but-never-loaded branch), reusing the render/reachability `loadGlobalInstincts`; tested. **Deferred:** `asd mcp serve` registration in `~/.claude.json` (mutates the live global env — needs explicit operator opt-in).
- [x] (2026-06-29) U3. Fix epoch-0 `generated_at` in MEMORY.md renderer — PR #95 commit 5983390; renderer omits epoch seed / stamps real clock
- [x] (2026-06-29) U4. Persist instinct confidence floor — PR #95 commit 088895e; `confidence_floor` persisted, recompute starts from the create-time signal instead of the 0.5 floor
- [x] (2026-06-29) U5. Canonical-key reinforcement — **spike null result**: PR #95 commits 8ad425e (floor-threading review fixes) + 4eade4a (canonicalKey + U5a spike). Spike proved zero merge opportunity at every granularity; merge path NOT wired (see Surprises/Decision Log). Reframes the epic toward extraction quality.
- [ ] U6. Trigger backfill for the 1,570 trigger-less instincts (budget-gated)
- [~] U7. Global rollup render + read-back (`wiki/projects/_global/MEMORY.md`) — render + read-back + store plumbing **done** (2026-06-29): `renderGlobalMemoryToVault` writes `scope: global` instincts once to the reserved `_global` project; `renderProjectMemoryToVault` no longer duplicates global into every per-project file; `asd recall` prepends the global rollup (dropped when empty); `query.ts` already loads global scope (U2). 3 new tests + full suite (463) green. **Deferred:** wiring a promote-review *apply* step to mark approved candidates `scope: global` — no apply/approval mechanism exists yet, so the global store stays empty until that separate unit lands.
- [x] (2026-06-29) U8. Delivered-and-consumed metric in `asd stats` — PR #95; live runtime reads 1,065 produced / 2 reachable (0.19%)
- [x] (2026-06-29) U9. ADR-0010 + README/docs for the reinforcement + read-back contract — `docs/decisions/0010-recall-read-back.md`, README "Read Back (Recall)" section. Also shipped the **live delivery surface** the diagnosis flagged as missing: `asd-recall-sessionstart` hub hook (`~/.hub/artifacts/hooks/asd-recall-sessionstart/`, hub commit 2cc353ef7) wired surgically into `~/.claude/settings.json`. Verified end-to-end: 2,279 bytes/10 bullets for `agent-ntfy-ios`, 1,034 bytes/4 bullets for `cohost-ai-studio`; header-only (unmemoried) projects fail-open to `{}`. **The read-back loop is now live, not just renderable.**

## Surprises & Discoveries

- Observation (U8, 2026-06-29): the live `reachable` count is exactly **2** —
  the diagnosis's headline confirmed by an in-tree metric, not a one-off manual
  count. Evidence: `asd stats` reports `reachability.produced=1065`,
  `reachable=2`, `reachable_ratio=0.0019` over 259 projects (only 2 with any
  reachable instinct). Note `produced` via bundle-replay is 1,065, not the
  2,009 quoted from the raw instinct-yaml store — replay folds merges/supersedes,
  so 1,065 is the *current* instinct population and aligns with the diagnosis's
  "1,065 candidate" maturity bucket. The 2,009 figure double-counts superseded
  records; future reporting should prefer the replay count.
- Observation (U8, 2026-06-29): recall is already firing in the real runtime —
  `recall.total_fires=4, fires_delivered=3` after U1's smoke tests — so the
  read-back loop is observably live, not just unit-tested.
- Observation (U1, 2026-06-29): after wiring read-back, this repo's own
  per-project `MEMORY.md` is still effectively empty — only the boilerplate
  curated header renders, no instinct bullets. Evidence: `asd recall` against
  the live vault for this project printed the header and stripped frontmatter
  but no findings. This is the diagnosis made concrete from the consumer side:
  read-back now works end-to-end, but there is nothing mature to read until the
  upstream confidence/reinforcement fixes (U4/U5) land. Confirms U1 alone is
  necessary but not sufficient; the milestone ordering holds.
- Observation: the read-back path was never an oversight — `memory-push-wiki.ts:137`
  already prints "Add @import for MEMORY.md in the consuming repo CLAUDE.md if
  ambient context is desired." Evidence: that string is a manual suggestion with
  no automation behind it; project-id is a 12-hex hash so a static `@import`
  line can't be templated generically — dynamic resolution at session start is
  required.
- Observation: a runnable MCP server already exists (`asd mcp serve`,
  `src/v2/mcp/stdio-server.ts:81`) but is registered nowhere, and its `global`
  scope is requested-but-never-loaded. Evidence: `query.ts:126-136` only has a
  `project` loader branch.
- Observation: `finalizeInstinct` recomputes confidence from the observation log
  starting at `INITIAL_CONFIDENCE = 0.5`, *discarding* the learning's intended
  `initial_confidence` (0.7/0.55/0.4). Evidence: `decay.ts:59-74` +
  `apply-delta.ts:184-203`. Every single-observation instinct pins to exactly
  `0.5 + 0.04 = 0.54`. **Fixed by U4** (commit 088895e): `confidence_floor` is
  now persisted and recompute starts from it.
- **Major finding (U5a spike, 2026-06-29): the singleton problem is NOT a
  dedup-key problem — the corpus has no reinforcement signal at any
  granularity.** The U5 premise was that reworded duplicates spawn distinct
  slug-hash ids that never reinforce, so a semantic canonical key would recover
  the lost signal. The spike (`scripts/canonical-merge-spike.mjs`, commit
  4eade4a) disproves it on the live corpus (259 projects, 1072 create-deltas):
  - within-project: **1065 distinct exact ids == 1065 distinct canonical keys**
    (0% bucket reduction; not one project has two ids sharing a canonical key).
  - cross-project: **0 instincts appear in ≥2 projects** by exact id *or*
    canonical key — so the ADR-0006 promotion gate (`min_projects:2`) is
    *starved of input*, not miscalibrated. It can never fire on this corpus.
  Implication: the same insight essentially never recurs — within a project,
  across projects, reworded or verbatim. No dedup key (canonical or embedding)
  can manufacture maturity that organic recurrence never produces. The maturity
  ladder's `reinforcing_count ≥ 2` requirement is structurally unsatisfiable at
  the current extraction granularity. The real bottleneck is **upstream**:
  extraction emits hyper-specific, one-off findings (avg ~4 instincts/project,
  almost all unique), so there is nothing to reinforce. This reframes the epic:
  read-back (U1) and floor-persistence (U4) are correct and necessary, but the
  path to a non-empty vault `MEMORY.md` runs through extraction *generality* and
  the maturity/promotion contract — NOT through better dedup. See the new
  Decision Log entry and Open Questions.

- **Major finding (post-U4, 2026-06-29): U4 alone moved per-project reachability
  from 2 → 259, across 105 of 259 projects.** The `reachable=2` figure above was
  measured at U8 time, *before* U4's `confidence_floor` persistence propagated
  through bundle-replay. Re-running `asd stats` against the U4-aware build now
  reports `reachability.reachable=259`, `projects_with_reachable=105`,
  `reachable_ratio=0.2432` (produced=1065). The two reachability gates are
  distinct and only one was ever starved:
  - **Per-project rollup** (`shouldIncludeInRollup`: candidate + conf ≥ 0.6):
    was starved by the confidence-reset bug, **now satisfied** — high-floor
    (0.7) instincts recompute to ~0.74 and clear the bar. This is the win.
  - **Cross-project promotion** (ADR-0006 `min_projects ≥ 2`): still starved
    (U5a's 0-overlap finding stands). Genuinely unsatisfiable on this corpus.
  Quality check (read-only dump of all 259 reachable findings): they are NOT the
  "mostly trivial" noise the operator feared — that worry was about the full
  2,009-row store; the reachable slice is the high-confidence subset. Examples:
  *"Avoid using 'status' as a variable name in zsh (read-only shell variable)"*
  (recurs across two projects), *"Always pipe input to jq when parsing JSON in
  shell scripts"*, *"Write all logs to stderr so stdout stays valid JSON for
  Tauri"*. **Implication:** the loop is closeable *now* with the units already
  shipped — the gap is that the live vault was rendered pre-U4 (empty files). The
  fix is to ship U4 to main so the installed 6h pipeline re-renders with real
  content. Rendering from the feat branch first would be clobbered by the next
  main-build pipeline run, so merge precedes re-render.

## Decision Log

- **Decision (2026-06-29, accepted direction):** asd's product is **per-project
  working memory that is read back**, not a cross-project distillation of how the
  operator works. **Rationale:** the U5a spike proved cross-project recurrence is
  ~0 on this corpus (diverse, mostly one-off work), so the ADR-0006 promotion
  ladder is structurally unsatisfiable and not worth further investment. The
  post-U4 finding proved the per-project gate is *already satisfied* (259
  reachable across 105 projects) and the content is genuinely useful. So:
  finish closing the per-project loop (ship U4 → re-render → recall delivers real
  content); keep cross-project/global *promotion* explicitly **out of scope**
  until the corpus shows recurrence (which is an extraction-generality question,
  a separate epic, not a code-calibration one). The single-high-signal global
  fast-path is rejected — it would flood the vault with the trivial tail.
  Date/Author: 2026-06-29 / execution (plow-ahead).
- **Decision:** Read-back ships as BOTH a SessionStart hook (deterministic
  file-inject, U1) and an optional registered MCP server (live queries, U2),
  with the hook first. **Rationale:** the hook delivers value with zero model
  tool-selection cost and works for Cursor/Codex too; the MCP server adds live
  semantic/file/recency queries for power use. Hook-first means the highest-
  leverage win (#1) lands in the smallest, lowest-risk unit. Reversible.
  Date/Author: 2026-06-29 / planning.
- **Decision:** Global rollup writes to a reserved project-id `_global`
  (`wiki/projects/_global/MEMORY.md`), NOT a new top-level vault path.
  **Rationale:** stays inside the ADR-0004 carve-out allowlist (a `MEMORY.md`
  under `wiki/projects/<id>/`), so it needs no carve-out re-opening per
  CLAUDE.md. `sanitiseProjectId` (`vault-paths.ts:88`) preserves a leading
  underscore (only leading dots are stripped), so `_global` is a legal id.
  Date/Author: 2026-06-29 / planning.
- **Decision:** Cross-session identity uses a deterministic **canonical key**
  (normalized trigger+finding: lowercase, strip punctuation, drop stopwords,
  sort tokens), not embeddings. **Rationale:** zero new dependency or LLM cost,
  matches the existing in-session `dedupeLearnings` approach (`extract.ts:1879`),
  and is unit-testable. Embeddings remain a labeled future option if the
  canonical key under-merges. Date/Author: 2026-06-29 / planning.
- **Decision:** Do NOT change ADR-0006 promotion thresholds (`min_projects:2`,
  `avg_confidence≥0.8`, `min_age_days:14`). **Rationale:** ADR-0006 explicitly
  feared "nothing ever promotes → dead code" — which is exactly what happened.
  The fix is restoring the *reinforcement signal* the thresholds assume (U4/U5),
  not lowering the bar. Lowering the bar would pollute the global tier with the
  same noise. Date/Author: 2026-06-29 / planning.
- **Decision (2026-06-29, execution):** U5's canonical-merge path is NOT wired
  into the live pipeline; only the `canonicalKey` util and the U5a spike ship.
  **Rationale:** the U5a spike (see Surprises) measured *zero* merge opportunity
  at every granularity, so a canonical-merge code path would be dead code that
  silently changes nothing while adding a branch to maintain (YAGNI). The spike
  is retained as the evidence-producer: re-run it after any change to extraction
  granularity to re-validate the assumption. The `confidence_floor` merge-max
  fix (apply-delta.ts) and queue floor-threading (queue.ts) *did* ship because
  they are correctness fixes independent of the merge opportunity. This upholds
  the earlier "do NOT lower ADR-0006 thresholds" decision — the spike confirms
  lowering the bar would only admit unique, mostly-trivial singletons (which the
  operator explicitly does not trust yet). Date/Author: 2026-06-29 / execution.

## Outcomes & Retrospective

**The feedback loop is closed (2026-06-29).** End-to-end, with hard numbers:

- **Reachable instincts: 2 → 259** (`asd stats` reachability, U4-aware build).
- **Curated `MEMORY.md` content: 0 → 259 bullets across 105 projects.** Before
  the re-render every project's `MEMORY.md` was a bare 9-line header; after, 105
  projects carry real instinct bullets (exactly matching the reachable count —
  no render gap). Top project `d14ae13c25f6` renders 25 bullets.
- **Consumer proof:** `asd recall` (the exact invocation the SessionStart hook
  runs) now returns **3,895 bytes** of curated memory for a populated project
  (capped at the 4 KB budget), vs the empty header it returned before.
- **Content quality:** the reachable slice is the high-confidence subset (floor
  0.7 → ~0.74), not the trivial tail — e.g. "Avoid `status` as a zsh variable
  (read-only)", "pipe input to jq when parsing JSON in shell", "write logs to
  stderr so stdout stays valid JSON for Tauri".

What closed it: **U4** (persist `confidence_floor`) was the single unlock — it
stopped recompute from resetting high-signal instincts to the 0.54 noise floor,
so they clear the per-project rollup gate. **U1** (read-back) + the U4-aware
re-render then delivered that content to the consumer. The live launchd pipeline
runs the primary checkout's `dist/` (rebuilt U4-aware post-merge), so the 6-hour
cycle keeps it current idempotently.

Per-unit acceptance: U1 ✓ (recall delivers real content), U2 in-repo ✓ (global
scope loads), U3 ✓ (real `generated_at`), U4 ✓ (floor persisted, the unlock),
U5 ✓ (null result, no merge wired), U8 ✓ (reachability metric). Deferred: U2
registration (env opt-in), U6 (trigger backfill, budget-gated), U7 global
*writer* (cross-project promotion out of scope per Decision Log; a within-
environment global rollup remains an optional feature — its *reader* now works),
U9 (ADR-0010 docs).

## Context and Orientation

asd is a TypeScript/Node 22 CLI; runtime root `~/.agent-session-distillery`,
vault output `~/vault/wiki/projects/<id>/`. Key modules for this plan
(repo-relative):

- Read-back: `src/commands/mcp.ts`, `src/v2/mcp/{stdio-server.ts,query.ts,types.ts}`,
  `src/commands/hooks-install.ts`, `scripts/claude-session-end-ingest.sh`,
  `src/v2/project/resolve.ts`, `src/config/vault-paths.ts`.
- Instinct math: `src/v2/math/decay.ts`, `src/v2/instinct/{apply-delta.ts,
  from-learning.ts,bundle.ts,schema.ts,id.ts,yaml-io.ts}`.
- Render: `src/v2/vault/render-memory.ts`, `src/commands/memory-push-wiki.ts`.
- Promotion: `src/v2/promotion/queue.ts`, `src/commands/promote-review.ts`.
- Stats: `src/commands/stats.ts`.

Governing ADRs (must be respected or amended): 0002 (project-id), 0004
(carve-out boundary), 0005 (MCP 3-tool cap), 0006 (promotion thresholds), 0009
(extraction quality gates). Relevant prior learning:
`docs/solutions/performance/openrouter-reasoning-tokens-dominate-trivial-tasks.md`
(cap reasoning effort on trivial LLM classify — binds U6 cost).

Terms: **instinct** = atomic distilled learning (YAML in `instincts/projects/<id>/`).
**candidate/established/proven** = maturity tiers. **reinforcing observation** =
a later session re-asserting the same instinct, raising confidence. **canonical
key** (new, U5) = normalized text used to decide two extractions are the same
instinct.

Build/test/lint: `npm run build` (tsc), `npm test` (`node --test`,
`--test-concurrency=1`), `npm run lint` (biome). CLI after build:
`node dist/cli.js <cmd>` or linked `asd <cmd>`.

## Plan of Work

Work proceeds in leverage order. U1–U3 are independent and low-risk and may land
in any order or in parallel branches. U4 precedes U5 (confidence floor before
reinforcement so the maturity math is correct when reinforcement starts firing).
U5 precedes U7 (global promotion needs reinforcement working). U6 is independent
but budget-gated and serializes after the existing `td-85e202` U4 sweep. U8 lands
with U1 (it measures what U1 enables). U9 documents U2/U4/U5/U7 and lands last.

## Milestones

**M1 — Read-back live (U1, U2, U8).** A fresh session in an ingested project
receives its curated memory; `asd stats` reports reachable instincts. Proves the
loop is closed even before maturity improves.

**M2 — Instincts mature (U3, U4, U5).** Re-extracting the corpus produces
non-trivial `established` counts and collapses duplicate singletons; per-project
`MEMORY.md` files carry real timestamps and multiple high-confidence lines.

**M3 — Refine + globalize + document (U6, U7, U9).** Trigger-less instincts get
triggers; cross-project promotion populates a global rollup the harness reads;
the new contract is captured in ADR-0010 and the README.

## Implementation units

### U1. SessionStart read-back: `asd recall` + hook installer

- **Goal:** A new session in an ingested project automatically receives that
  project's curated `MEMORY.md` (and topic files) as session-start context.
- **Requirements:** R1 (close the read-back loop — top priority).
- **Files:**
  - Create `src/commands/recall.ts` — resolves project id via
    `resolveProjectId({ workspacePath: cwd })` (`src/v2/project/resolve.ts:32`),
    locates `vaultProjectPath(vaultRoot, id, "MEMORY.md")`
    (`src/config/vault-paths.ts:42`), reads it plus any present topic files
    (`workflow.md`, `tooling.md`, `pitfalls.md`, `debugging.md`,
    `preferences.md`), prints a compact merged block to stdout. Flags:
    `--cwd <dir>` (default `process.cwd()`), `--vault-root <dir>` (default
    `$ASD_VAULT_ROOT || ~/vault`), `--max-bytes <n>` (default 4000, cap injected
    context). Missing vault/file → print nothing, exit 0 (fail-open, mirror
    `scripts/claude-session-end-ingest.sh:23`).
  - Modify `src/cli.ts` — register a `recall` command alongside `mcp`
    (`src/cli.ts:243`) dispatching to `executeRecall`.
  - Create `scripts/claude-session-start-recall.sh` — mirror
    `scripts/claude-session-end-ingest.sh`; drain stdin, run
    `asd recall --cwd "$CLAUDE_PROJECT_DIR"`, emit stdout (Claude Code injects a
    SessionStart hook's stdout as additional context), fail open on any error.
  - Modify `src/commands/hooks-install.ts` — add `mergeSessionStartHook(...)`
    mirroring `mergeSessionEndHook` (`hooks-install.ts:96-120`), copy the new
    template, and register a `SessionStart` entry in `.claude/settings.json`
    (project) or `~/.claude/settings.json` (`--global`). Keep SessionEnd
    install intact; install both by default, gate with `--events end,start`.
- **Approach:** Pure-read command + a second hook event. No instinct mutation.
  The hash project-id is resolved dynamically so no static `@import` is needed,
  superseding the manual suggestion at `memory-push-wiki.ts:137`.
- **Tests** (`test/recall.test.mjs`): (a) seed a temp vault
  `wiki/projects/<id>/MEMORY.md` with two curated lines and a resolvable
  `workspacePath`; `asd recall --cwd <dir> --vault-root <tmp>` prints both lines
  within the byte cap. (b) Missing MEMORY.md → empty stdout, exit 0. (c)
  `--max-bytes` truncates deterministically at a line boundary. (d)
  `test/hooks-install.test.mjs` (extend existing if present, else create):
  `asd hooks install --global --events start` merges exactly one SessionStart
  entry and is idempotent on re-run.
- **Verification:** `npm test`; then `node dist/cli.js recall --cwd "$(pwd)"`
  prints this repo's curated memory (or nothing if none qualifies yet);
  `node dist/cli.js hooks install` then `grep -A3 SessionStart ~/.claude/settings.json`.

### U2. Register `asd mcp serve` + fix global-scope-never-loaded

- **Goal:** The existing MCP server is registered into Claude Code, and its
  `global` scope actually returns global instincts.
- **Requirements:** R1 (second read-back path — live queries).
- **Files:**
  - Modify `src/v2/mcp/query.ts:126-136` — add the missing `global` loader
    branch so `scope` including `"global"` loads global-scope instincts (the
    `search_instincts` default scope is `["project","global"]` per
    `types.ts:34-41` but only `project` is ever loaded today).
  - Modify `src/commands/mcp.ts` — add an `install` subcommand that merges an
    entry into `~/.claude.json` `mcpServers` (`agent-session-distillery` →
    `{ command: "node", args: ["<abs>/dist/cli.js","mcp","serve"] }`), idempotent;
    print the equivalent `claude mcp add` command for manual/portable use.
- **Approach:** No new tools (respects ADR-0005 `MAX_MCP_TOOLS=3`,
  `types.ts:10`). Fixing global loading honors ADR-0005's intent rather than
  changing surface.
- **Tests:** (a) `test/mcp-query.test.mjs` (extend): seed one `project` and one
  `global` instinct; `search_instincts` with default scope returns both; with
  `scope:["project"]` returns only project. (b) `mcp.ts install` writes the
  expected JSON shape and is idempotent.
- **Verification:** `npm test`; `node dist/cli.js mcp search_instincts --query
  "build" --scope global` returns global hits (after U5/U7 populate global, else
  empty but well-formed); `node dist/cli.js mcp install` then confirm
  `~/.claude.json` entry; `node dist/cli.js mcp serve` responds to a piped
  `initialize` JSON-RPC line.

### U3. Fix epoch-0 `generated_at` in MEMORY.md renderer

- **Goal:** No rendered `MEMORY.md` carries `generated_at: 1970-01-01T00:00:00.000Z`.
- **Requirements:** R5 (recency correctness — decay/curation depend on it).
- **Files:** Modify `src/v2/vault/render-memory.ts`: at `:154` pass an explicit
  `generatedAt` (real clock, threaded from the caller — `memory-push-wiki.ts`
  already has a run timestamp) into `renderMemoryMarkdown`; and harden the
  `:74-79` reduce so an empty `instincts` array or empty `updated_at` does not
  emit the epoch seed (skip writing frontmatter `generated_at` or use the passed
  clock). Decide via test: empty selection should not render a misleading
  timestamp.
- **Approach:** Renderer-default-seed bug, not a stored-zero. One-file change.
- **Tests** (`test/render-memory.test.mjs`): (a) non-empty instincts →
  `generated_at` equals the passed clock (or max `updated_at`), never epoch. (b)
  empty selection → no epoch-0 frontmatter emitted.
- **Verification:** `npm test`; regenerate one project
  (`node dist/cli.js memory push-wiki ...` against a temp vault) and
  `grep generated_at` shows a real timestamp.

### U4. Persist instinct confidence floor (stop discarding `initial_confidence`)

- **Goal:** A high-signal (`high`) learning finalizes at ≥0.7 confidence, not
  the 0.54 floor; corrections still decay correctly.
- **Requirements:** R2 (fix promotion economics — part 1).
- **Files:**
  - `src/v2/instinct/schema.ts` — persist the create-time level/floor on the
    instinct (e.g. `confidence_floor` derived from `from-learning.ts:6-10`
    `high:0.7/medium:0.55/low:0.4`).
  - `src/v2/math/decay.ts:59-74` — `confidenceFromObservations` starts from the
    instinct's persisted floor instead of the hardcoded `INITIAL_CONFIDENCE=0.5`
    (default to 0.5 when absent, preserving back-compat for existing YAML).
  - `src/v2/instinct/apply-delta.ts:184-203` — thread the floor through
    `recomputeInstinct`/`finalizeInstinct` so it is not overwritten.
- **Approach:** Smallest change that makes the learning's confidence level
  survive finalize. Existing instincts without the field keep current behavior.
- **Tests** (`test/decay.test.mjs` / `test/apply-delta.test.mjs`): (a) a `high`
  learning with one reinforcing observation finalizes ≥0.7. (b) a `low` learning
  finalizes ≥0.4. (c) a correction after reinforcement still drops below the
  established bar. (d) legacy instinct with no floor field → unchanged 0.54.
- **Verification:** `npm test`; re-extract one project deterministically and
  confirm a known high-signal instinct now reports ≥0.7.

### U5. Cross-session reinforcement via canonical-key merge (core fix)

- **Goal:** Two sessions asserting the *same* insight in slightly different words
  reinforce one instinct (reinforcing_count climbs) instead of spawning two
  floor-confidence singletons — so `established`/`proven` and ADR-0006 promotion
  actually fire.
- **Requirements:** R2 (fix promotion economics — part 2, the root cause).
- **Files:**
  - `src/v2/instinct/id.ts` — add `canonicalKey(trigger, finding)`: normalize
    (lowercase, strip punctuation, drop stopwords, dedupe + sort tokens). Keep
    the existing exact `sha256(trigger|finding)` id for addressing; the canonical
    key is the *merge* discriminator.
  - `src/v2/instinct/bundle.ts:55-76` (`replayBundles`) and
    `src/v2/instinct/from-learning.ts:36-59` — when a new `create` delta's
    canonical key matches an existing instinct, route to a `reinforce` (append
    observation) instead of creating a new instinct. The `merge`/`reinforce`
    delta shapes already parse (`yaml-io.ts:358-408`) but are never emitted —
    emit them here.
  - `src/v2/instinct/apply-delta.ts` — ensure the reinforce path appends an
    observation and re-runs `recomputeInstinct`.
- **Approach:** Deterministic canonical key (Decision Log), no embeddings. This
  is the highest-risk unit → gated by a prototype milestone before it touches
  the live pipeline default.
- **Prototype (spike, U5a):** Add `asd pipeline reextract --canonical-merge
  --dry-run` (or a one-off script under `scripts/`) that replays the existing
  corpus with canonical-key merging and prints: singleton count before/after,
  new maturity distribution (candidate/established/proven), and the top 20
  largest merge clusters for eyeball validation. **Promote criteria:**
  established count > 0 AND singleton reduction ≥ 25% AND spot-checked clusters
  are genuinely the same insight (no obvious over-merge). **Discard criteria:**
  visible over-merging of distinct insights → fall back to stricter key or
  embeddings (labeled future option). Record the numbers in Surprises.
- **Tests** (`test/canonical-merge.test.mjs`): (a) two learnings with reworded
  but semantically identical trigger/finding produce one instinct with
  `reinforcing_count = 2`. (b) two genuinely distinct learnings stay separate.
  (c) after merge, a 2-observation instinct aged ≥7d with confidence ≥0.6
  reaches `established` (`decay.ts:119-136`). (d) idempotent re-replay does not
  double-count observations.
- **Verification:** `npm test`; run the U5a spike on the live corpus and record
  before/after maturity distribution in Surprises; confirm `promote-queue.json`
  gains ≥1 entry after a full re-extract + `detectPromotionCandidates`.

### U6. Trigger backfill for the 1,570 trigger-less instincts (budget-gated)

- **Goal:** Reduce the share of instincts whose trigger reads "original trigger
  not recorded" (78% → target < 25% on re-processed projects), restoring the
  retrieval AND canonical-merge key.
- **Requirements:** R3 (rescue the trigger field).
- **Files:** Extend the existing LLM review path
  (`asd quality review-learnings` / `apply-learning-review`) with a
  trigger-reconstruction mode that fills a missing/placeholder trigger from the
  learning's finding + session context. Reuse the budget gate
  (`reports/llm-budget.json`) and **cap reasoning effort** per
  `docs/solutions/performance/openrouter-reasoning-tokens-dominate-trivial-tasks.md`
  (gpt-5-nano was spending ~94% of tokens on reasoning for a trivial classify —
  minimal effort is mandatory here).
- **Approach:** This is the natural continuation of `td-85e202` (U4/U5/U6 review
  sweep). **Serialize after** the in-progress `td-683c75` sweep to avoid double-
  spending budget. Deterministic re-extraction (`asd pipeline reextract
  --process-chatter-only`) handles non-LLM cases first; LLM only for the
  residue.
- **Tests:** (a) an instinct with placeholder trigger + a concrete finding gets
  a reconstructed trigger containing a condition clause. (b) the budget gate
  blocks the sweep at the configured cap (no overspend). (c) reasoning-effort
  param is set minimal on the request body.
- **Verification:** `npm test`; bounded sweep on N projects, then
  `grep -rl "original trigger not recorded" instincts/` count drops; record
  cost-per-learning from telemetry.

### U7. Global rollup render + read-back (`wiki/projects/_global/MEMORY.md`)

- **Goal:** Cross-project-promoted (`scope: global`) instincts render to a single
  global rollup, and the read-back path (U1/U2) surfaces them in every session.
- **Requirements:** R4 (roll up globally, not 259 silos).
- **Files:**
  - `src/v2/vault/render-memory.ts` — render `scope: global` instincts to
    `vaultProjectPath(vaultRoot, "_global", "MEMORY.md")` (legal under the
    carve-out; `sanitiseProjectId` preserves `_global`).
  - `src/commands/recall.ts` (from U1) — also read `_global/MEMORY.md` and
    prepend a "Global instincts" section.
  - `src/v2/mcp/query.ts` — ensure the now-loadable global scope (U2) reads from
    the global instinct store so MCP and file-inject agree.
  - Wire the promote-review apply step (`src/commands/promote-review.ts`) to mark
    approved candidates `scope: global` so they flow into the global render.
- **Approach:** Depends on U5 (promotion must fire to have anything global).
  Reserved-id strategy avoids touching ADR-0004.
- **Tests:** (a) a `global`-scope instinct renders into `_global/MEMORY.md` and
  nowhere else. (b) `asd recall` output includes a Global section when
  `_global/MEMORY.md` exists. (c) carve-out guard still rejects any non-allowed
  `_global/...` path.
- **Verification:** `npm test`; after U5 promotion + `asd promote review`
  approval, `_global/MEMORY.md` is populated and `asd recall` shows it.

### U8. Delivered-and-consumed metric in `asd stats`

- **Goal:** `asd stats` reports the number that matters — instincts *reachable*
  by a future agent (rendered into some `MEMORY.md` and/or returned by recall),
  not just total produced.
- **Requirements:** R1-meta (measure delivered signal, not artifacts).
- **Files:**
  - `src/commands/stats.ts` — add a `reachable` section: count instincts that
    appear in any rendered `MEMORY.md` (cross-ref the render selection) and the
    count surfaced per project; show "produced vs reachable" ratio.
  - `src/commands/recall.ts` (U1) — append one structured line per fire to a
    recall log (e.g. `<runtime>/reports/recall-events.jsonl`) so consumption is
    observable; `stats` summarizes recent recall fires.
- **Approach:** Lands with U1 since it measures what U1 enables.
- **Tests** (`test/stats.test.mjs`): (a) with 5 instincts of which 2 are in a
  rendered MEMORY.md, stats reports reachable=2. (b) recall-event log lines are
  appended and summarized.
- **Verification:** `npm test`; `node dist/cli.js stats` shows
  produced/reachable (today: ~2,009 produced / ~2 reachable — the headline this
  plan moves).

### U9. ADR-0010 + README/docs for the new reinforcement + read-back contract

- **Goal:** The new behavior is documented as accepted decisions and discoverable
  in the README.
- **Requirements:** Docs-are-part-of-done; U2/U4/U5/U7 change accepted behavior.
- **Files:**
  - Create `docs/decisions/0010-reinforcement-and-readback.md` (use
    `docs/decisions/0000-template.md`): records (1) canonical-key reinforcement
    (U5) and `confidence_floor` persistence (U4) — and that ADR-0006 thresholds
    are unchanged, only the signal feeding them is restored; (2) the read-back
    contract (SessionStart hook + registered MCP, U1/U2); (3) the `_global`
    reserved-id rollup (U7) and why it stays inside the ADR-0004 carve-out.
  - Modify `README.md` Automation table — add `asd recall`, `asd hooks install
    --events start`, and `asd mcp install` rows.
  - Capture the U5 spike result + the produced/reachable delta in this plan's
    **Outcomes**, and a one-line learning via `ce-compound` if the canonical-key
    approach proves out.
- **Tests:** none (docs); `npm run lint` for any touched code comments.
- **Verification:** ADR renders; README commands all run as written
  (run each once before documenting — docs-accuracy rule).

## Worktree & concurrency

- **worktree_slug:** `feat/close-distillery-feedback-loop`
- **spine_owner:** self
- **Pre-flight:** `scripts/worktree-posture.sh --json` then
  `scripts/worktree-posture.sh --check-surfaces "<surfaces below>" || true`
  (run if the script exists; this repo's checkout is otherwise clean except a
  foreign linter edit to `CLAUDE.md`).
- **Active conflicts:** none known. `td-683c75` (U4 review-learnings sweep) is
  in-progress and touches the LLM review path — **U6 here serializes after it**
  to avoid budget contention; no file-level overlap expected (U6 extends the
  review command, the sweep only runs it).

### Write surfaces

- U1: `src/commands/recall.ts`, `src/cli.ts`, `src/commands/hooks-install.ts`,
  `scripts/claude-session-start-recall.sh`, `test/recall.test.mjs`
- U2: `src/v2/mcp/query.ts`, `src/commands/mcp.ts`, `test/mcp-query.test.mjs`
- U3: `src/v2/vault/render-memory.ts`, `test/render-memory.test.mjs`
- U4: `src/v2/instinct/schema.ts`, `src/v2/math/decay.ts`,
  `src/v2/instinct/apply-delta.ts`, `test/decay.test.mjs`
- U5: `src/v2/instinct/{id.ts,bundle.ts,from-learning.ts,apply-delta.ts}`,
  `test/canonical-merge.test.mjs` (+ spike script under `scripts/`)
- U6: LLM review-learnings command + pipeline reextract paths
- U7: `src/v2/vault/render-memory.ts`, `src/commands/recall.ts`,
  `src/v2/mcp/query.ts`, `src/commands/promote-review.ts`
- U8: `src/commands/stats.ts`, `src/commands/recall.ts`, `test/stats.test.mjs`
- U9: `docs/decisions/0010-reinforcement-and-readback.md`, `README.md`

Note: U2/U5/U7 each touch `src/v2/mcp/query.ts` or
`src/v2/vault/render-memory.ts` — land them on the same branch in unit order
(U2 → U5 → U7) to avoid spine collisions; do not parallelize those across
worktrees.

## Validation and Acceptance

System-level acceptance (human-observable):

1. **Loop closed:** in a freshly-ingested project, `node dist/cli.js recall`
   prints that project's curated lines; with the SessionStart hook installed, a
   new Claude Code session shows that content as session-start context.
2. **Maturity moves:** after a full re-extract with U4+U5, `asd stats` (or a
   maturity count) shows `established > 0` where today it is 1, and
   `promote-queue.json` is non-empty.
3. **Reachable signal up:** `asd stats` produced/reachable ratio improves
   materially from ~2,009 / ~2.
4. **No epoch timestamps:** `grep -rl "1970-01-01" ~/vault/wiki/projects/*/MEMORY.md`
   returns nothing after a re-render.
5. **Global tier real:** `_global/MEMORY.md` exists and `asd recall` surfaces it.

Per-unit acceptance is in each unit's **Tests** + **Verification**. Standard gate
for every unit: `npm run build && npm test && npm run lint` green, plus the
unit's CLI verification command run and read.

## Idempotence and Recovery

- `asd recall`, `asd hooks install`, and `asd mcp install` must be idempotent
  (re-run adds no duplicate hook/server entries) — asserted in tests.
- U4/U5 change confidence math: existing YAML without the new `confidence_floor`
  field must replay unchanged (back-compat test). A full re-extract is the
  recovery path; the runtime root is rebuildable from `ledger/sessions.sqlite`
  + source transcripts. Take a `backups/` snapshot before the first live
  canonical-merge re-extract (U5) so the corpus can be restored if over-merge is
  detected.
- The U5 spike runs `--dry-run` only; it must not mutate the instinct store.

## Interfaces and Dependencies

- `resolveProjectId({ workspacePath })` → `src/v2/project/resolve.ts:32`
- `vaultProjectPath(vaultRoot, id, "MEMORY.md")` → `src/config/vault-paths.ts:42`
  (guarded by `assertAllowedVaultProjectPath`, allowlist `:12-21`)
- `confidenceFromObservations(observations, now)` → `src/v2/math/decay.ts:59`
- `proposedMaturity(...)` thresholds → `src/v2/math/decay.ts:119-136`
- `instinctIdFromTriggerFinding` / id gen → `src/v2/instinct/id.ts:5-14`
- `runMcpStdioServer()` → `src/v2/mcp/stdio-server.ts:81`; tools/schemas →
  `src/v2/mcp/types.ts:34-77`
- `renderMemoryMarkdown` / `renderProjectMemoryToVault` →
  `src/v2/vault/render-memory.ts:65/147`
- `detectPromotionCandidates` / thresholds → `src/v2/promotion/queue.ts:11-15,87`
- No new runtime dependencies. Stays on `zod` + Node stdlib.

## Artifacts and Notes

- Diagnosis numbers (this session): 2,009 instincts / 259 projects; maturity
  1,065 candidate / 1 established (of the measured subset); confidence 1,063 in
  0.5–0.6, 3 above 0.6; 1,570/2,009 trigger-less; 2 instinct lines promoted into
  any vault MEMORY.md; largest MEMORY.md = 420 bytes (1 instinct).
- launchd job `com.dallascrilley.asd-memory-pipeline` runs every 6h; last clean
  run 2026-06-29 02:40.

## Open Questions

- **(Raised by the U5a spike — needs operator direction before U6/U7 continue.)**
  The spike proved the maturity/promotion ladder is structurally unsatisfiable on
  the current corpus: insights never recur, so `reinforcing_count ≥ 2` and the
  `min_projects:2` gate can never fire. Three mutually-exclusive directions, none
  a routine default:
  1. **Fix extraction generality** (largest effort, addresses root cause): make
     extraction emit fewer, more general findings that *do* recur across sessions
     /projects, so reinforcement happens organically. This is a separate epic.
  2. **Single-high-signal fast-path** (medium effort): let a lone `high`-confidence
     finding reach `established` without a second observation, so floor-0.7
     instincts become reachable. Risk: the operator stated the raw instincts are
     "mostly trivial… I wouldn't trust them as input yet" — this would surface
     exactly that noise. Needs a quality gate first.
  3. **Accept per-project-only memory** (smallest effort): drop the cross-project
     promotion ambition; ship U7 as a within-project rollup only. Honest about
     what the data supports, but abandons the "global instincts" goal.
  U6 (trigger backfill) and U7 (global rollup) still have standalone value
  (retrieval keys; per-project surfacing) and can proceed regardless, but the
  *promotion* half of U7 is moot until one of the above is chosen.

## Revision History

- 2026-06-29: Initial plan authored from session diagnosis + two code-mechanism
  surveys (promotion/reinforcement map; MCP/render/hook/timestamp map).
- 2026-06-29: U1/U3/U4/U8 landed; U5 closed as a spike null result (no merge
  opportunity at any granularity) — reframed the epic toward extraction quality.
  Added the Open Questions section for the operator decision this surfaced.
