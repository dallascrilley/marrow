---
date: 2026-06-15
origin: direct brief
td_epic: td-cbc405
---

# Quality improvements follow-up plan

**Summary:** Execute the four quality improvement tasks surfaced by the harness ingestion health sweep: reduce `process_chatter` false positives, improve project-learning promotion for non-claude-code harnesses, investigate `summary_missing` candidates, and run budgeted `quality review-learnings` on low-signal summaries.

## Requirements

- **R1.** Reduce `process_chatter` issue count by improving the detector and/or upstream summary sanitization.
- **R2.** Increase project-learning yield for cursor/codex-cli/pi/kimi transcripts without lowering quality or over-promoting noise.
- **R3.** Determine why 147 sessions lack summaries and fix any code path that leaves them un-summarized.
- **R4.** Run `quality review-learnings` on the 770 `summary_low_signal` sessions within the LLM budget.
- **R5.** Maintain or improve existing test coverage and keep `npm test` / `npm run lint` green.

## Key technical decisions

- Keep changes incremental and reversible; prefer tunable heuristics over hard-coded harness-specific exceptions.
- Use the existing runtime for sampling and verification; do not create isolated test runtimes because these changes must generalize to live operator data.
- LLM-bound steps (`review-learnings`) run only when `ASD_LLM_MAX_USD` / `ASD_LLM_MAX_PER_WINDOW` budgets allow; dry-run first.
- Document non-obvious patterns in `docs/solutions/` so future harness adapters benefit.

## Implementation units

### U1. Diagnose process_chatter false positives

- **Goal:** Understand which summary phrases from cursor/codex-cli/pi/kimi are being misclassified as process chatter.
- **Requirements:** R1
- **Files:** `src/pipeline/quality-audit.ts`, runtime audit output
- **Approach:**
  1. Run `node dist/cli.js quality audit --limit 200`.
  2. Filter sessions with `process_chatter` to a representative sample (20–30) from non-claude-code harnesses.
  3. Inspect the summary text that triggered the regex and classify each as true-positive (genuine process narration) or false-positive (durable signal wrapped in process wording).
  4. Write findings to a temporary markdown note under `/tmp/` or in the plan doc.
- **Tests:** Add a unit test in `test/quality-audit.test.mjs` with the sampled false-positive phrases once they are identified.
- **Verification:** Sample classification table exists and false-positive rate is estimated.

### U2. Harden process_chatter detection

- **Goal:** Lower the false-positive rate without letting genuine process chatter through.
- **Requirements:** R1
- **Files:** `src/pipeline/quality-audit.ts` (and optionally `src/pipeline/summarize.ts` / `src/pipeline/prompt-sanitize.ts`)
- **Approach:**
  1. Update the `process_chatter` regex/conditions based on U1 findings.
  2. Consider adding negating context (e.g., a process phrase followed by a concrete outcome is not chatter) or moving suppression upstream into summary normalization.
  3. Run `quality audit` before and after; target a measurable drop in `process_chatter` count.
- **Tests:** New regression tests for each false-positive pattern fixed; existing true-positive tests must still pass.
- **Verification:** `process_chatter` count in `quality audit` drops by at least 10% and no new `completion_as_next_step` or `summary_low_signal` regressions appear.

### U3. Diagnose no_project_learnings false negatives

- **Goal:** Identify transcript patterns in cursor/codex-cli/pi/kimi that should yield project learnings but currently do not.
- **Requirements:** R2
- **Files:** `src/pipeline/extract.ts`, runtime audit output
- **Approach:**
  1. Sample 20–30 sessions flagged `no_project_learnings` from each non-claude-code harness.
  2. Inspect reduced events and turns to find missed fix/verification/decision/workflow patterns.
  3. Categorize root causes: missing event type classification, `looksLikeProcessNarration` too aggressive, missing command/file extraction, etc.
- **Tests:** Add fixture-based tests for each newly supported pattern.
- **Verification:** Categorized root-cause list exists with concrete examples.

### U4. Improve project-learning promotion

- **Goal:** Increase project-learning yield for non-claude-code harnesses by extending promotion heuristics.
- **Requirements:** R2
- **Files:** `src/pipeline/extract.ts`, `src/pipeline/reduce.ts`
- **Approach:**
  1. Implement targeted improvements from U3 (e.g., relax `isConcreteFailure` for harness-specific failure text, add command patterns, broaden verification detection).
  2. Keep the 12-learning cap intact.
  3. Run `quality audit` before and after on the same corpus.
- **Tests:** New unit tests for each promotion rule; ensure existing tests still pass and cap remains at 12.
- **Verification:** `no_project_learnings` count drops and `total_project_learnings` increases without increasing `summary_low_signal` or `process_chatter` disproportionately.

### U5. Investigate summary_missing candidates

- **Goal:** Determine why 147 sessions lack summary artifacts.
- **Requirements:** R3
- **Files:** `src/pipeline/summarize-phase.ts`, `src/commands/ingest-backfill.ts`, runtime database
- **Approach:**
  1. List the 147 session IDs from the latest audit.
  2. Query the ledger for their `summarized` checkpoint state and source format.
  3. Attempt `node dist/cli.js quality resummarize --session-id <id>` on a sample.
  4. If resummarize succeeds, the original summarize phase skipped them; investigate why (e.g., parser dropped the session, summary schema rejected output).
  5. If resummarize fails, capture the error and determine if it is a code bug or unrecoverable input.
- **Tests:** If a code bug is found, add a regression test with a minimal fixture.
- **Verification:** Root cause documented; if fixable, fix applied and sample count of `summary_missing` drops.

### U6. Run quality review-learnings on low-signal sessions

- **Goal:** Use LLM review to upgrade durable but low-signal summaries.
- **Requirements:** R4
- **Files:** `src/commands/quality-review-learnings.ts`, LLM budget telemetry
- **Approach:**
  1. Run dry-run first: `node dist/cli.js quality review-learnings --if-new --dry-run` to estimate cost.
  2. If within budget, run `node dist/cli.js quality review-learnings --if-new`.
  3. Capture output, cost telemetry, and re-run `quality audit`.
- **Tests:** N/A — operational step; relies on existing `review-learnings` tests.
- **Verification:** `summary_low_signal` count decreases or `project_learnings` count increases; telemetry JSONL shows spend within budget.

## Prior learnings applied

- `docs/solutions/tooling/resume-manifest-overwrite.md` — the sweep was only possible because resumed incremental sync works; keep all quality work incremental and reversible.
- `docs/plans/2026-06-15-harness-ingestion-health-sweep-plan.md` — carries the baseline metrics and the decision to stay incremental and budget-conscious.

## Deferred / out of scope

- Full historical backfill across all harnesses.
- Adding new harness adapters.
- Changes to vault export or memory push workflows.

## Open questions

- How many of the 147 `summary_missing` sessions are recoverable vs. unrecoverable no-signal inputs?
- Will LLM budget allow full review of 770 low-signal sessions, or should we prioritize a subset?
