# Repo Audit & Roadmap — 2026-07-06

**Status:** planning artifact (no code changed in the audit session)
**Baseline:** `main` @ `3178821`, clean tree, CI green (473/473 tests, lint clean, `tsc --noEmit` clean)
**Inputs:** README, `docs/plans/2026-06-29-feat-close-distillery-feedback-loop-plan.md`, ADRs 0001–0011, td board (ses_5b0e38), two independent exploration passes (plans-vs-code, technical health).

---

## 1. Executive summary

agent-session-distillery (asd) is a Node 22 / strict-TypeScript CLI that ingests local
AI-coding-agent transcripts (Cursor, Claude Code, Codex CLI, Kimi, Pi), runs them through a
deterministic lifecycle (`discovered → … → deleted`), distills them into atomic per-project
"instinct" memories, LLM-reviews them under hard budget gates, and renders/pushes curated
`MEMORY.md` rollups into the operator's vault via a code-enforced path carve-out
(`src/config/vault-paths.ts`). The newest arc — "close the feedback loop"
(epic `td-31338a`, plan `docs/plans/2026-06-29-feat-close-distillery-feedback-loop-plan.md`)
— added the read-back half: `asd recall` + SessionStart hook, an MCP query server, confidence
floors, a global rollup, and an LLM-judged global-promotion fast path.

**Overall health is strong.** All gates are green, debt-marker density is near zero for a
24.6k-line codebase, plan self-reporting is accurate against source (no unit claimed done that
isn't), and the risky surfaces (LLM spend, vault writes) are allowlisted/gated and tested.

**The real gaps, in priority order:**

1. **Critical-path defect already tracked but unimplemented** — `td-02d1fe`: review sweeps
   never persist per-learning reviewed state, so repeat sweeps re-select the same ~100
   learnings forever. This blocks the whole U-chain (U6 backfill, epic closure). No code
   written yet.
2. **Destructive-operation test gap** — `delete-candidates` / `delete-apply --apply`
   (tombstone-writing, irreversible) has zero functional tests; only a `--help` string check.
3. **Tracker hygiene** — U4 (`td-683c75`) and U5 (`td-f49619`) have met their acceptance
   criteria but sit in_progress; `.agents-state/handoff.md` still claims everything is blocked
   on an OpenRouter 404 that was resolved via `openrouter/auto` (2026-07-05/07 sessions).
4. **README drift** — four live commands (`check`, `search`, `migrate project-ids`,
   `doctor provider`) have zero README coverage; `export-index` and `memory export-wiki` are
   mentioned only in passing.
5. **Structural debt (non-urgent)** — `src/pipeline/extract.ts` at 2,134 lines (~5× the next
   file); `src/v2/promotion/queue.ts:115` full-scan `TODO(perf)`.

---

## 2. Audit & gap assessment

### 2.1 Plan vs implementation (feedback-loop epic, td-31338a)

| Unit | Title | Plan claims | Verified in source |
|---|---|---|---|
| U1 | `asd recall` + SessionStart hook | done (PR #95) | ✅ `src/commands/recall.ts`, `src/cli.ts:255`, `scripts/claude-session-start-recall.sh`, `src/commands/hooks-install.ts` |
| U2 | `asd mcp serve` registration + global-scope fix | partial — registration "deferred" | ✅ code fix present (`src/v2/mcp/query.ts:136-141`); note: `mcp install` subcommand is **fully implemented + README-documented** — only *running it against the live `~/.claude.json`* is deferred (operator opt-in) |
| U3 | epoch-0 `generated_at` fix | done | ✅ `src/v2/vault/render-memory.ts:36,93-113` |
| U4 | confidence floor persisted | done | ✅ `src/v2/instinct/schema.ts:73`, `apply-delta.ts` |
| U5 | canonical-key merge | spike only, **not wired** | ✅ accurate — `canonicalKey()` exists (`src/v2/instinct/id.ts:36`) but unreferenced in `bundle.ts`/`from-learning.ts` |
| U6 | trigger backfill (1,570 trigger-less instincts) | not started, budget-gated | ✅ absent; tracked as `td-e2bc6d` |
| U7 | global rollup render + read-back | render/recall done; promote-review **writer deferred** | ✅ accurate — `renderGlobalMemoryToVault` + recall read exist; `src/commands/promote-review.ts` is a 14-line read-only queue dump, no `scope: global` write path anywhere |
| U8 | delivered/consumed metric in `asd stats` | done | ✅ `computeReachability` + recall-events log wired into `stats.ts` and `recall.ts` |
| U9 | ADR-0010 + README | done | ✅ (filename drift only: plan said `0010-reinforcement-and-readback.md`, shipped as `0010-recall-read-back.md`) |
| U10 | LLM-judged global promotion (`promote judge`) | done (PR #101) | ✅ `src/commands/promote-judge.ts`, `src/cli.ts:243-249`, README §promote judge, ADR-0011 |

**Verdict:** plan self-reporting is trustworthy. Remaining implementation work from this epic:
U6 backfill, U5 merge wiring (explicitly parked pending evidence), U7 promotion writer
(explicitly deferred), U2 live registration (operator opt-in).

### 2.2 Live td state (the U-chain, epic td-85e202)

- **U4 sweep (`td-683c75`)** — executed 2026-07-07Z (ses_4630b5): 100 learnings reviewed
  (36 reject / 58 rewrite / 6 keep), $0.00 spend (100% judge-cache hits). Acceptance criteria
  met. **Still in_progress — needs `td review` → approve.**
- **U5 apply (`td-f49619`)** — executed: `quality apply-learning-review` exit 0, 49 kept →
  `knowledge/projects-reviewed`, 51 rejected; audit before/after captured; all three
  acceptance criteria met. **Still in_progress — needs review flow.**
- **Reviewed-ids ledger (`td-02d1fe`)** — the defect U4 uncovered: `quality review-learnings`
  selects via `readProjectLearnings` with no exclusion of already-reviewed ids, and the sidecar
  is overwritten each run, so sweep→apply→sweep never advances (verified: sweeps 1 and 2
  identical). Agreed fix (in task description): append-only
  `reports/llm-learning-review-ledger.jsonl` `{learning_id, verdict, reviewed_at}`; sweep
  excludes ledger ids; `countPendingLlmReview` reads ledger instead of sidecar. **Started,
  zero commits — this is the single highest-leverage code task in the repo.**
- **U6 backfill (`td-e2bc6d`)** — blocked by ledger + sweep; target: trigger-less 78% → <25%.
- **U6 findings doc (`td-ade10a`)** — blocked by U5.
- Historical note: the 50/24h default call cap was **ratified** (operator-delegated ruling,
  2026-07-05 log on td-85e202) — the USD ceiling (`ASD_LLM_MAX_USD`, $1/24h) is the real
  financial guard. `td-ade10a` should record this ratification when documenting findings.

### 2.3 Technical health

- **Gates:** `npm test` 473/473 pass (~115s); `biome check` clean over 218 files;
  `tsc --noEmit` clean. CI = `./script/cibuild` on push/PR (same entrypoint as local).
- **Stack:** npm (package-lock; **not** bun — global bun preference does not apply, lockfile
  is law), zod as the only runtime dep, strict tsconfig (`noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`).
- **Deployment:** launchd plist (6h interval) runs `~/.agent-session-distillery/run-pipeline.sh`
  against the **primary checkout's `dist/`** — ship to main + rebuild that dist for changes to
  take effect. Drift between the deployed script and in-repo
  `scripts/scheduled-memory-pipeline.sh` is unverified (see task R3-4).
- **Test coverage gaps (functional):** `delete-apply --apply` / `delete-candidates` (destructive
  — highest priority), `migrate-project-ids` (untested and absent from `--help` enumeration),
  `doctor provider` success path, `stats`, `check-sessions`, `explain`, `review-queue`,
  `review-show`, `archive-run`, `promote-review` (help-string-only), `src/v2/mcp/stdio-server.ts`
  (268 lines, unreferenced by tests), `src/pipeline/summarize-phase.ts`.
- **Complexity hotspots:** `src/pipeline/extract.ts` 2,134 lines; then `summarize.ts` 929,
  `llm-learning-review.ts` 828, `db/ledger.ts` 811, `report/dashboard.ts` 645.
- **Debt markers:** effectively one — `src/v2/promotion/queue.ts:115`
  `TODO(perf): full scan — loads every instinct of every project on each run`.
- **Risk surfaces verified sound:** LLM budget double-gate (count throttle + USD ceiling,
  fail-closed telemetry, tested); vault writes forced through `vaultProjectPath()` allowlist
  (throws outside the 8-path carve-out, tested at unit + integration level).

### 2.4 Documentation drift

- README omits runnable coverage for: `asd check`, `asd search`, `asd migrate project-ids`,
  `asd doctor provider`; `export-index` and `memory export-wiki` appear only in passing prose.
- `.agents-state/handoff.md` (2026-06-27) is stale: claims all work blocked on OpenRouter
  data-policy 404, since resolved via `--model openrouter/auto`.
- Plan-vs-test filename mismatches (cosmetic; coverage exists under different names):
  e.g. plan's `test/mcp-query.test.mjs` → actual `test/mcp.test.mjs` + `test/mcp-install.test.mjs`.

---

## 3. Phased roadmap

### Phase 1 — Unblock the critical path (the U-chain)

Everything downstream hangs on the reviewed-ids ledger.

1. **Implement `td-02d1fe`** (reviewed-ids ledger) — see task list below. *Verification:*
   new regression test proving a second sweep selects different learnings and
   `pending_learnings` decreases; full `script/cibuild` green.
2. **Run the sweep→apply loop for real** — with the ledger in place, resume `td-683c75`-style
   sweeps under the standing budget gate ($1/24h USD ceiling, `--model openrouter/auto`),
   apply via `quality apply-learning-review`, and confirm backlog progression (pending count
   monotonically decreasing across runs).
3. **Close out U4/U5** — submit `td-683c75` and `td-f49619` through `td review` → independent
   approve (acceptance evidence already logged on both).

### Phase 2 — Safety & tracker hygiene

4. **Functional tests for the deletion path** — `delete-candidates` +
   `delete-apply --apply` (tombstones, `safe_to_delete` filter, phase transition). This is the
   only destructive operation without a test and should land **before** delete-apply is ever
   run in anger. *Verification:* new `test/delete-apply.test.mjs` (or equivalent) exercising
   dry-run vs `--apply` against a fixture ledger; `npm test` green.
5. **Refresh `.agents-state/handoff.md`** — replace the stale OpenRouter-404 blocker note with
   current state (unblocked via `openrouter/auto`; critical path = ledger). *Verification:*
   handoff reflects td board.
6. **`doctor provider` success-path test + `migrate project-ids` test/help registration.**

### Phase 3 — Finish the feedback-loop epic

7. **U6 trigger backfill (`td-e2bc6d`)** — extend review-learnings with trigger
   reconstruction, budget-gated, serialized after sweeps. Target: trigger-less 78% → <25% on
   reprocessed instincts. *Verification:* audit metric delta captured before/after.
8. **U6 findings doc (`td-ade10a`)** — document sweep findings; record the 50/24h cap
   ratification (supersedes plan R1/R5 and acceptance criterion 5); update the epic plan doc's
   Progress section.
9. **Close epics** `td-85e202` and `td-31338a` (remaining children: U6 only), or explicitly
   re-park U5-merge/U7-writer as new follow-on items if evidence now justifies them.

### Phase 4 — Documentation & polish

10. **README command coverage** — add runnable sections for `check`, `search`,
    `migrate project-ids`, `doctor provider`; promote `export-index` and `memory export-wiki`
    to first-class examples. *Verification:* every command registered in `src/cli.ts` has a
    README section (spot-check by diffing the dispatch table against README headings); every
    documented command actually run once.
11. **Verify deployed-pipeline parity** — diff `~/.agent-session-distillery/run-pipeline.sh`
    against `scripts/scheduled-memory-pipeline.sh`; document (or script) the sync step so the
    6h launchd job can't silently drift from the repo.

### Phase 5 — Structural debt (opportunistic, non-blocking)

12. **Decompose `src/pipeline/extract.ts`** (2,134 lines) into cohesive modules — behavior-
    preserving, test-backed, no API change. Do this only alongside other extract work or as a
    dedicated pass; not urgent while gates are green.
13. **Fix `queue.ts:115` full-scan perf TODO** — promotion queue loads every instinct of every
    project per run; add an index/incremental scan when promotion volume grows.
14. **MCP stdio-server test** — direct test for `src/v2/mcp/stdio-server.ts` (268 lines).

---

## 4. Actionable task list

Filed in td 2026-07-06 (label `audit-2026-07-06`):

- [ ] **P1 — Implement reviewed-ids ledger** (`td-02d1fe`, already filed, in_progress):
      append-only `reports/llm-learning-review-ledger.jsonl` written by
      `quality review-learnings` (`src/pipeline/llm-learning-review.ts`); sweep excludes ledger
      ids before partitioning; `countPendingLlmReview` reads ledger not sidecar; sidecar stays
      per-run output for apply. **Files:** `src/pipeline/llm-learning-review.ts`,
      `src/pipeline/quality-audit.ts` (pending count), new test. **Verify:** regression test —
      two consecutive sweeps select disjoint learning ids; `script/cibuild` green.
- [ ] **P2 — Functional tests for delete-candidates/delete-apply** (`td-da6f51`): fixture ledger with
      deletion candidates; assert dry-run prints without mutation; assert `--apply` writes
      tombstones, calls `markDeletionCandidateApplied` + `transitionPhase`, and respects
      `safe_to_delete === 1` + state filter. **Files:** new `test/delete-apply.test.mjs`;
      no src changes expected. **Verify:** `npm test` green, new tests fail if `--apply`
      guard removed.
- [ ] **P2 — Submit U4/U5 for review** (`td-683c75`, `td-f49619`): evidence already in session
      logs; run `td review`, dispatch independent reviewer, approve. **Verify:** both closed
      via review flow, not `td close`.
- [ ] **P3 — Refresh `.agents-state/handoff.md`** (`td-f5cdd7`, minor): replace stale OpenRouter-404
      framing with current critical path. **Verify:** handoff matches `td critical-path`.
- [ ] **P3 — README coverage for undocumented commands** (`td-a2cc8c`): add sections + runnable
      examples for `check` (`src/cli.ts:115`), `search` (`src/cli.ts:166`),
      `migrate project-ids` (`src/cli.ts:188`), `doctor provider` (`src/cli.ts:144`);
      first-class examples for `export-index`, `memory export-wiki`. **Verify:** each example
      command executed once against the built CLI before documenting (docs-lifecycle rule).
- [ ] **P3 — Test gaps: doctor-provider success path, migrate-project-ids, stdio-server**
      (`td-7577f4`): one task, three small test files. **Verify:** `npm test` green; coverage of the
      named modules confirmed by grep.
- [ ] **P3 — Deployed-pipeline parity check** (`td-463ef1`, minor): diff live
      `~/.agent-session-distillery/run-pipeline.sh` vs `scripts/scheduled-memory-pipeline.sh`;
      document sync procedure in `docs/recipes/scheduled-memory-pipeline.md`. **Verify:**
      drift report recorded; recipe updated.
- [ ] **P4 (ideas) — Decompose `src/pipeline/extract.ts`** (`td-ed46e3`): split 2,134-line module into
      cohesive units behind unchanged exports. **Verify:** behavior-preserving (full suite
      green, no snapshot churn).
- [ ] **P4 (ideas) — promotion queue full-scan perf** (`td-b6cea3`): address
      `src/v2/promotion/queue.ts:115` TODO. **Verify:** benchmark or complexity argument in PR.

Already tracked, unchanged: `td-e2bc6d` (U6 backfill), `td-ade10a` (U6 findings doc,
must record the 50/24h cap ratification).
