---
date: 2026-06-23
origin: docs/plans/2026-06-15-refactor-session-artifact-quality-plan.md
td_epic: <unassigned>
---

# Salvage PR #50 quality units (U6, U7) against current main

**Summary:** PR #50 is a wholesale rewrite of `extract.ts` on a pre-#56 tree
and conflicts with the #58–#61 Learning-schema enrichment now on main. Rather
than rebase and risk reverting that chain, close/re-cut #50 and land only the
units that are genuinely missing from main as small fresh PRs. Investigation
shows **only two** units are still novel: **U6** (review throttle default) and
**U7** (`--over-extracted-only`). **U1 (per-session cap of 12) already shipped
on main** and is re-scoped to a parity check, not new work.

## Requirements (carried from origin)

- R-U1. No session contributes more than a configurable number of project
  learnings (default 12).
- R-U6. Drain the LLM review backlog by raising the courtesy count cap while
  keeping the USD ceiling as the real guardrail.
- R-U7. Deterministically reprocess sessions whose learning count exceeds the
  cap via `quality resummarize --over-extracted-only`.

## Key technical decisions

- **Do not rebase or merge #50's branch.** `git show origin/main:…extract.ts`
  confirms main carries `applyProjectLearningCap` (extract.ts:161–185) plus the
  full #58–#61 enrichment chain. #50's extract.ts predates #56; resolving its
  10+ conflicts in favor of the older logic would silently revert
  trigger/evidence_type/technologies/skill_ref/dead_end/error-signature work —
  the exact "silently break extraction" failure mode. Close #50; land salvage
  units fresh.
- **U1 is already done — verify parity, don't reimplement.** Confirmed on
  `origin/main`: `defaultProjectLearningCap = 12`, env override
  `ASD_MAX_PROJECT_LEARNINGS`, truncation `console.warn`, and tests
  `test/extract-cap-atomicity.test.mjs` ("project learnings are capped at 12 by
  default" + higher-cap override). The earlier "U1 not present" finding came
  from grepping the literal `slice(0,12)`; main uses `slice(0, cap)`. The only
  deltas vs. the origin plan are cosmetic: env var name
  (`ASD_MAX_PROJECT_LEARNINGS` vs. plan's `…_PER_SESSION`) and a `console.warn`
  instead of a structured `quality`/`metric` log line. Neither is worth a
  branch unless audit specifically needs the structured line.
- **U7 reuses existing machinery.** `--low-signal-only` already exists in
  `src/commands/quality-resummarize.ts` and is applied as a per-candidate
  filter in `resummarizeSessions` (resummarize.ts:83–92). `--over-extracted-only`
  mirrors that exactly. The count source already exists:
  `countProjectLearnings(sourceSession)` in `quality-audit.ts:142` — export it
  (or lift to a shared util) and compare against `getProjectLearningCap()`.

## Implementation units

### U1. Parity check — project-learning cap (already on main)

- **Goal:** Confirm main's cap satisfies R-U1; decide if the structured metric
  log line is needed by `quality audit`. No reimplementation.
- **Requirements:** R-U1
- **Files (read-only unless gap found):** `src/pipeline/extract.ts:161-185`,
  `test/extract-cap-atomicity.test.mjs`, `src/pipeline/quality-audit.ts`
- **Approach:**
  1. Run the existing cap test; confirm green.
  2. Check whether `quality audit` reads truncation events. If it only needs
     `learning_distribution.max_project_learnings <= cap` (computable from
     stored counts), the `console.warn` is sufficient → **U1 closed, no PR.**
  3. Only if audit must report per-session truncation: add a structured
     `metric`-kind log alongside the existing warn (tiny, separate PR).
- **Tests:** existing `test/extract-cap-atomicity.test.mjs` passes.
- **Verification:** `npm test`; `quality audit` shows
  `max_project_learnings <= 12` on a reprocessed set.

### U6. Raise LLM review count cap with USD hard ceiling

- **Goal:** Default courtesy throttle moves from `5/24h` to `50/24h`; USD
  ceiling unchanged as the financial guardrail.
- **Requirements:** R-U6
- **Files:** `src/pipeline/llm-budget.ts` (`defaultMaxPer`, line 28),
  `test/llm-budget.test.mjs`
- **Approach:**
  1. Change `const defaultMaxPer = "5/24h"` → `"50/24h"`.
  2. Confirm `getDefaultMaxPerWindow()` env override (`ASD_LLM_MAX_PER`) and the
     USD guardrail path are untouched.
  3. Note in the commit body: count cap is a courtesy throttle; `ASD_LLM_MAX_USD`
     remains the real ceiling (origin plan §"Use the USD ceiling…").
- **Tests:** add/extend a case in `test/llm-budget.test.mjs` asserting
  `getDefaultMaxPerWindow()` returns `"50/24h"` with no env set, and that
  `ASD_LLM_MAX_PER` still overrides.
- **Verification:** `npm test`; `node …pipeline-gate`/`quality review-learnings`
  reports `max_per_window: "50/24h"` by default.

### U7. Add `--over-extracted-only` to `quality resummarize`

- **Goal:** Select only sessions whose `project_learning_count` exceeds the
  current cap, for deterministic reprocessing of the over-extracted corpus.
- **Requirements:** R-U7
- **Files:** `src/commands/quality-resummarize.ts` (flag parse, mirror
  `--low-signal-only`), `src/pipeline/resummarize.ts` (`ResummarizeOptions`,
  filter loop, new `ResummarizeSkipReason`), `src/pipeline/quality-audit.ts`
  (export `countProjectLearnings`), `src/cli.ts` (help text), plus a test.
- **Approach:**
  1. Parse `--over-extracted-only` → `overExtractedOnly?: boolean` in
     `parseResummarizeOptions` (mirror `lowSignalOnly`, ~lines 69-72, 103).
  2. Add `overExtractedOnly?: boolean` to `ResummarizeOptions`
     (resummarize.ts:30-40) and a skip reason
     `not_over_extracted` (resummarize.ts:23).
  3. In the candidate loop (resummarize.ts:82), when set, skip candidates where
     `countProjectLearnings(session) <= getProjectLearningCap()` with the new
     skip reason — sibling to the existing `lowSignalOnly` block (83-92).
  4. Export `countProjectLearnings` from `quality-audit.ts` (or extract a shared
     `learning-count` util both modules import — pick the smaller diff).
  5. Decide flag composition: document that `--over-extracted-only` and
     `--low-signal-only` AND together (both filters apply); state this in help.
- **Tests:** new test (mirror `extract-cap-atomicity` fixture style): seed two
  manifests — one with count > cap, one with count <= cap — assert dry-run
  selects only the over-extracted session and skips the other with
  `not_over_extracted`.
- **Verification:** `npm test`;
  `quality resummarize --over-extracted-only --dry-run` lists only sessions
  above the cap.

## Worktree & concurrency

- **worktree_slug:** feat/salvage-pr50-quality-units
- **spine_owner:** self
- **Active conflicts:** none with main spine. U6 and U7 touch disjoint files
  (`llm-budget.ts` vs. resummarize/quality-resummarize/quality-audit). They can
  land as two independent PRs in any order, or one branch — no shared edits.
- **Pre-flight:** `scripts/worktree-posture.sh --json` (if present); else
  `wt switch --create salvage-pr50-quality-units --yes`.

### Write surfaces

- U6: `src/pipeline/llm-budget.ts`, `test/llm-budget.test.mjs`
- U7: `src/commands/quality-resummarize.ts`, `src/pipeline/resummarize.ts`,
  `src/pipeline/quality-audit.ts`, `src/cli.ts`, new test under `test/`
- U1: read-only unless the structured-log gap is confirmed

## Prior learnings applied

- #56–#61 chain (trigger, evidence_type, technologies, skill_ref, dead_end,
  error-signature triggers) lives in main's `extract.ts`. The salvage path
  never edits `extract.ts`, so this chain cannot regress — the core risk that
  killed the rebase option.

## PR sequencing

1. **U6** — one-line default + test. Smallest, ship first.
2. **U7** — self-contained CLI flag + filter + test.
3. **U1** — close out as parity (likely no PR); open a tiny structured-log PR
   only if U1 step 2 finds `quality audit` needs it.
4. **Close PR #50** with a comment pointing to this plan and the landed PRs;
   note that U2–U5, U8 (chatter filtering, framing sanitization, atomicity,
   heuristics reuse, verification) were either superseded by #56–#61 or are out
   of scope here — confirm before closing whether any of those are still wanted.

## Deferred / out of scope

- U2–U5 and U8 from the origin plan. Several overlap #56–#61; a separate audit
  is needed to decide which (if any) remain unmet on current main. Not part of
  this salvage.
- Historical re-archive/re-extract pass to enforce the cap on already-written
  artifacts (origin plan "Risk" note). Operational follow-up, not code.

## Open questions

- **Q1.** Does `quality audit` require a structured per-session truncation
  metric, or is the stored-count distribution sufficient? Resolves whether U1
  needs any PR at all. (Answerable by reading `quality-audit.ts`
  `learning_distribution` computation — planning-owned, resolve in U1 step 2.)
- **Q2.** Should U2–U5/U8 be re-evaluated against main, or is the user content
  to drop everything from #50 except U6/U7? (User decision before closing #50.)
