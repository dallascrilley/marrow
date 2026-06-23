---
date: 2026-06-15
origin: direct brief — quality assessment of processed sessions found over-extraction, assistant-voice leakage, and low atomicity
td_epic: td-f24ad9
---

# Improve session artifact quality: de-noise summaries and learnings

**Summary:** Reduce noise in extracted learnings and summaries by capping over-extraction, stripping assistant process chatter, enforcing atomic statements, and reusing quality-audit heuristics upstream. Then drain the LLM review backlog and resummarize the low-signal corpus.

## Audit findings

Quality audit of **5,879** ledger sessions shows the pipeline produces far more artifacts than it should, and many are not reusable project knowledge:

| State | Count | % |
|---|---|---|
| Discovered only (no summary) | 5,145 | 87.5% |
| Summarized | 17 | 0.3% |
| Deletion candidates | 709 | 12.1% |
| Error / stale | 8 | 0.1% |

Quality issues among the **737** sessions with any artifacts:

| Issue | Count |
|---|---|
| `summary_missing` | 5,142 |
| `blocked_deletion` | 153 |
| `summary_low_signal` | 133 |
| `process_chatter` | 321 |
| `no_useful_commands` | 104 |
| `no_files_of_interest` | 132 |
| `no_project_learnings` | 150 |

Learning distribution is severely skewed: max **55** project learnings in one session, p99 **40**. The LLM review backlog is **3,226 learnings** across **446 sessions**, blocked by the `5/24h` count cap despite ~$0.99 USD headroom.

Spot-check of the worst session shows:
- Multi-paragraph "decision" statements that are clearly assistant narration.
- Markdown tables and "Verified:" / "Done —" framing treated as durable outcomes.
- Genuine fixes and file-scoped patterns buried in process prose.

## Requirements

- **R1.** Cap project-learning extraction so a single session cannot emit dozens of learnings.
- **R2.** Strip assistant process chatter and harness framing from summary and learning text before it is written.
- **R3.** Enforce atomic, concise learning statements that are reusable project knowledge.
- **R4.** Reuse quality-audit heuristics as upstream filters so bad artifacts never reach review.
- **R5.** Increase LLM review throughput for the existing backlog without breaching the USD cost ceiling.
- **R6.** Resummarize or reclassify the existing low-signal and over-extracted corpus.

## Key technical decisions

- **Cap learnings per session by priority.** `extract.ts` already scores candidates (`candidatePriority`). A trailing cap after `dedupeProjectCandidates` keeps the highest-value learnings and drops the long tail, rather than trying to invent a new ranking.
- **Filter before extraction where possible.** `process_chatter`, `wrapper_tags`, and non-durable summary patterns already exist in `quality-audit.ts` and `extract.ts`. Centralize them into shared predicates and call them in `toProjectEventCandidate` / `toProjectTurnCandidates` so low-signal candidates are dropped before deduplication.
- **Keep the deterministic pipeline fast.** These are pure string/regex changes in the reduction path; no LLM calls are required for the core quality fix.
- **Use the USD ceiling as the real guardrail.** The `5/24h` count cap is the bottleneck. Raising it to a moderate count cap with `ASD_LLM_MAX_USD=1/24h` still in place lets the backlog drain at roughly the cost pace, not an artificial call count.
- **Resummarize after the filters land.** Re-running `quality resummarize` against the same sessions with cleaner extraction will produce better artifacts than resummarizing first and filtering later.

## Implementation units

### U1. Cap project learnings per session
- **Goal:** No session contributes more than a configurable number of project learnings (default 12).
- **Requirements:** R1
- **Files:** `src/pipeline/extract.ts`, `test/extract.test.mjs`
- **Approach:**
  1. Add `DEFAULT_MAX_PROJECT_LEARNINGS_PER_SESSION = 12` constant in `extract.ts` (overridable via `ASD_MAX_PROJECT_LEARNINGS_PER_SESSION`).
  2. After `dedupeProjectCandidates`, slice the returned array to the cap, preserving the existing priority order.
  3. Emit a `quality`/`metric` log line when the cap truncates a session so audit can report it.
- **Tests:** A synthetic session with 20 candidates returns at most 12; verified-fix and decision kinds survive over lower-priority kinds; cap of 0 returns empty.
- **Verification:** `npm test` passes; `quality audit` reports `learning_distribution.max_project_learnings <= 12` after reprocessing.

### U2. Harden process-chatter filtering in extraction
- **Goal:** Drop assistant narration ("This is converging beautifully", "Good — and that's a genuinely important loosening", "Handoff written...", "Cold-read check passed...") before it becomes a learning.
- **Requirements:** R2, R4
- **Files:** `src/pipeline/extract.ts`, `src/pipeline/prompt-sanitize.ts`, `test/extract.test.mjs`, `test/prompt-sanitize.test.mjs`
- **Approach:**
  1. Extend `isProcessText` / `looksLikeProcessNarration` with the concrete phrases observed in the worst sessions.
  2. Add a shared `looksLikeAssistantProcessChatter(value)` predicate in `prompt-sanitize.ts` and use it in both `extract.ts` and `quality-audit.ts` so the rule is identical upstream and downstream.
  3. Apply the predicate in `toProjectEventCandidate` (decision/failure/pattern candidates) and `toProjectTurnCandidates`.
- **Tests:** Each observed bad phrase returns `true`; genuine fix/decision statements return `false`.
- **Verification:** `quality audit` issue count for `process_chatter` drops after reprocessing affected sessions.

### U3. Sanitize assistant framing from event summaries
- **Goal:** Remove "Verified:", "Done —", "Good —", "Summary of what changed:", and completion-block wrappers from learning statements and summary lines.
- **Requirements:** R2, R3
- **Files:** `src/pipeline/prompt-sanitize.ts`, `src/pipeline/extract.ts`, `src/pipeline/summarize.ts`
- **Approach:**
  1. Add `stripAssistantFraming(value)` helper in `prompt-sanitize.ts` that removes leading/trailing framing tokens.
  2. Call it inside `normalizeSummaryLine`, `sanitizeHarnessLeakText`, and `finalizeProjectLearningCandidate` so framing never reaches the output.
  3. Keep existing `stripCompletionBlock` logic; this is a broader polish layer.
- **Tests:** Fuzzy samples from the worst session are cleaned to single-sentence facts.
- **Verification:** Spot-read a sample of regenerated summaries shows no "Verified:" / "Done —" prefixes.

### U4. Enforce learning atomicity
- **Goal:** Learning statements are one concise sentence and under a max length; multi-paragraph statements are rejected or rewritten.
- **Requirements:** R3
- **Files:** `src/pipeline/extract.ts`, `src/pipeline/llm-learning-review.ts`
- **Approach:**
  1. In `finalizeProjectLearningCandidate`, reject candidates whose statement contains more than one sentence (heuristic: `/.+[.!?]\s+.+/`) **unless** it is a verified-fix pattern with a semicolon.
  2. Keep the existing 180-char truncation in `normalizeSummaryLine`; add a 240-char ceiling for learning statements.
  3. Let the LLM reviewer still rewrite, but make its input less noisy.
- **Tests:** Multi-sentence decision candidates are dropped; single concise verified-fix candidates are kept.
- **Verification:** `quality audit` `learning_distribution.p99` drops and `process_chatter` counts fall.

### U5. Reuse quality audit heuristics upstream
- **Goal:** Bad artifacts that `quality-audit.ts` flags are filtered before they are written.
- **Requirements:** R4
- **Files:** `src/pipeline/quality-audit.ts`, `src/pipeline/extract.ts`, `src/pipeline/summarize.ts`, `src/pipeline/prompt-sanitize.ts`
- **Approach:**
  1. Extract `isProcessChatterText`, `hasWrapperTags`, and `isLowSignalSummary` into shared predicates in a new file `src/pipeline/artifact-heuristics.ts`.
  2. Import those predicates from `quality-audit.ts` (replacing inline regexes) and from `extract.ts`/`summarize.ts`.
  3. Apply them to candidate statements before creating learnings, and to summary fields before writing the summary.
- **Tests:** The same test vectors pass for both upstream and downstream consumers.
- **Verification:** `quality audit` reports fewer newly created issues after the change.

### U6. Raise LLM review count cap with USD hard ceiling
- **Goal:** Drain the 3,226 pending learning reviews faster without increasing real spend.
- **Requirements:** R5
- **Files:** `src/pipeline/llm-budget.ts`, `AGENTS.md`, `docs/recipes/llm-budget.md` (create if absent)
- **Approach:**
  1. Change `defaultMaxPer` from `"5/24h"` to `"50/24h"` in `llm-budget.ts`.
  2. Keep `defaultMaxUsd = "1/24h"` as the hard ceiling.
  3. Document the rationale: count cap is a courtesy throttle; USD cap is the financial guardrail.
- **Tests:** Budget unit tests updated; `assessLlmBudget` reports 50 remaining after fresh state.
- **Verification:** `quality cost-report` shows review pace increases while 24h spend stays under $1.

### U7. Resummarize low-signal and over-extracted sessions
- **Goal:** Repair the existing 133 low-signal summaries and any sessions whose learning count exceeds the new cap.
- **Requirements:** R6
- **Files:** `src/commands/quality-resummarize.ts`, `src/pipeline/resummarize.ts`, `scripts/resummarize-corpus.mjs`
- **Approach:**
  1. Add `--over-extracted-only` flag to `quality resummarize` that selects sessions where `project_learning_count > cap`.
  2. Run `node dist/cli.js quality resummarize --low-signal-only --dry-run` to estimate scope.
  3. Run `node dist/cli.js quality resummarize --low-signal-only --no-llm-topic` for deterministic repair first.
  4. If budget allows, run `npm run corpus:resummarize` with LLM topic rescue for remaining low-signal sessions.
  5. Re-run `quality audit` and compare `summary_low_signal`, `process_chatter`, and learning distribution.
- **Tests:** Dry-run returns finite counts; resummarize completes without errors; re-audit shows improvement.
- **Verification:**
  ```bash
  node dist/cli.js quality audit --limit 500
  node dist/cli.js stats
  node dist/cli.js quality cost-report
  ```

### U8. Verify artifact quality improvement
- **Goal:** Prove the changes moved the quality metrics in the right direction.
- **Requirements:** R1–R6
- **Files:** `docs/plans/2026-06-15-refactor-session-artifact-quality-plan.md`, runtime reports
- **Approach:**
  1. Capture a baseline `quality audit` before any code changes.
  2. After U1–U7, capture a second `quality audit` on the same session set.
  3. Compare issue counts, learning distribution percentiles, and deletion readiness.
  4. Record the delta in this plan under a "Results" section.
- **Tests:** N/A — verification is empirical comparison.
- **Verification:**
  ```bash
  node dist/cli.js quality audit
  node dist/cli.js quality audit --topic-distribution
  ```

## Prior learnings applied

- `docs/solutions/performance/openrouter-reasoning-tokens-dominate-trivial-tasks.md` — the LLM review already caps reasoning effort; U6 raises the call-count throttle but keeps the USD ceiling so the cost guardrail from this learning remains the binding constraint.
- `docs/solutions/tooling/openrouter-byok-effective-cost.md` — effective cost tracking for BYOK keys means `assessUsdBudget` is the right hard ceiling even when OpenRouter's own charge is $0.

## Deferred / out of scope

- Full-corpus LLM topic rescue. Too expensive for this quality pass; use `corpus:resummarize` when budget and value align.
- Per-project quality tuning. The cap and heuristics are global first; project-specific rules can be added if the global policy proves too coarse.
- New CLI quality dashboard. `quality audit` JSON is sufficient for the current metric-driven loop.
- Deletion apply (`delete apply --apply`). Retention decisions are separate from artifact-quality work.

## Open questions

- What is the right default cap? 12 is a starting guess; inspect the post-U1 distribution and adjust before merging.
- How many of the 133 `summary_low_signal` sessions will still be low-signal after deterministic cleaning? U7 dry-run will tell us.
- Does raising the count cap to 50/24h risk provider rate limits? Monitor the first batched run and dial back if `429` responses appear.
