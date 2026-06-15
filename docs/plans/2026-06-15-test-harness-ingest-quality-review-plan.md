---
date: 2026-06-15
origin: direct brief — test latest extraction/enrichment changes with raised LLM cap and incremental per-harness ingests
td_epic: td-3706e1
---

# Raised-cap harness ingest and extraction quality review

**Summary:** Temporarily raise the LLM per-call cap, then run small, source-ordered ingests for every supported harness (claude-code, codex-cli, cursor, kimi, pi). After each batch, audit the quality of summarization/enrichment and extraction so we can catch regressions or harness-specific gaps in the latest changes.

## Requirements

- **R1.** Raise the per-call LLM budget for the test window without changing the hardcoded default.
- **R2.** Keep the USD ceiling (`ASD_LLM_MAX_USD`) as the hard spend guard.
- **R3.** Ingest new/changed sessions from each harness incrementally, smallest/newest backlog first.
- **R4.** Review enrichment quality (summaries, topics, lifecycle promotion) and extraction quality (project/user learnings) per harness.
- **R5.** Capture findings, regressions, and any harness-specific anomalies in `docs/research/`.
- **R6.** Reset the per-call cap to the default after the test.

## Key technical decisions

- **Use an env var for the test window.** Set `ASD_LLM_MAX_PER=20/24h` in the shell session so every command in the test inherits the higher cap without touching the default in code.
- **Enable LLM topic rescue only for the test ingests.** Pass `--llm-topic` to `ingest backfill` so summaries are enriched; this is the main consumer of the raised cap.
- **Source order: claude-code → pi → kimi → codex-cli → cursor.** This mirrors the existing incremental-ingest plan (`docs/plans/2026-06-15-chore-incremental-session-ingest.md`) and gives fast feedback before the large cursor backlog.
- **Small `--limit` per batch.** Each harness gets a bounded run so a failure or quality regression is cheap and easy to inspect.
- **Quality audit after every harness.** Compare `quality audit --limit N` before and after each batch to spot new `summary_missing`, `summary_low_signal`, `process_chatter`, or `no_project_learnings` patterns.
- **Do not bypass USD accounting.** The USD sliding window remains the real stopper; if it exhausts, pause and wait rather than resetting telemetry.

## Implementation units

### U1. Raise cap and verify headroom

- **Goal:** Establish a test-wide higher per-call cap and confirm both count and USD budgets allow work.
- **Requirements:** R1, R2
- **Files:** `~/.agent-session-distillery/reports/llm-budget.json`, shell environment
- **Approach:**
  1. In the test shell: `export ASD_LLM_MAX_PER=20/24h`.
  2. Check headroom: `asd pipeline gate --skip-ingest`.
  3. Note current `quality audit --limit 100` baseline for later comparison.
- **Tests:** N/A — operational setup.
- **Verification:** `pipeline gate` reports `llm_budget.max_per_window: "20/24h"` and `llm_budget.allowed: true`.

### U2. Ingest and review claude-code sessions

- **Goal:** Process the newest claude-code sessions and review quality.
- **Requirements:** R3, R4
- **Files:** runtime ledger, `src/adapters/claude-code/`, `src/pipeline/`
- **Approach:**
  1. Sync: `asd ingest sync --source claude-code --resume`.
  2. Ingest a bounded batch with LLM topic rescue: `asd ingest backfill --source claude-code --limit 10 --resume --llm-topic`.
  3. Run `asd quality audit --limit 50` and capture issue counts.
  4. Inspect a sample of written summaries (`summary.json`) and project learnings (`project-knowledge.json`) for coherence and signal.
- **Tests:** `failed_count: 0`; audit completes.
- **Verification:** Written notes in `docs/research/2026-06-15-harness-ingest-quality-review.md` with claude-code observations.

### U3. Ingest and review pi sessions

- **Goal:** Process the newest pi sessions and review quality.
- **Requirements:** R3, R4
- **Files:** runtime ledger, `src/adapters/pi/`, `src/pipeline/`
- **Approach:** Same as U2 with `--source pi --limit 10`.
- **Tests:** `failed_count: 0`; audit completes.
- **Verification:** pi observations recorded in the same research doc.

### U4. Ingest and review kimi sessions

- **Goal:** Process the newest kimi sessions and review quality.
- **Requirements:** R3, R4
- **Files:** runtime ledger, `src/adapters/kimi/`, `src/pipeline/`
- **Approach:** Same as U2 with `--source kimi --limit 10`.
- **Tests:** `failed_count: 0`; audit completes.
- **Verification:** kimi observations recorded.

### U5. Ingest and review codex-cli sessions

- **Goal:** Process the newest codex-cli sessions and review quality.
- **Requirements:** R3, R4
- **Files:** runtime ledger, `src/adapters/codex-cli/`, `src/pipeline/`
- **Approach:** Same as U2 with `--source codex-cli --limit 10`.
- **Tests:** `failed_count: 0`; audit completes.
- **Verification:** codex-cli observations recorded.

### U6. Ingest and review cursor sessions

- **Goal:** Process the newest cursor sessions and review quality.
- **Requirements:** R3, R4
- **Files:** runtime ledger, `src/adapters/cursor/`, `src/pipeline/`
- **Approach:** Same as U2 with `--source cursor --limit 10`.
- **Tests:** `failed_count: 0`; audit completes.
- **Verification:** cursor observations recorded.

### U7. Cross-harness comparison and findings

- **Goal:** Synthesize per-harness results and identify regressions or harness-specific gaps.
- **Requirements:** R4, R5
- **Files:** `docs/research/2026-06-15-harness-ingest-quality-review.md`
- **Approach:**
  1. Compare issue-count deltas across harnesses.
  2. Note any harness where `summary_low_signal`, `process_chatter`, or `no_project_learnings` is disproportionately high.
  3. Decide whether findings require code fixes, adapter tuning, or just more data.
- **Tests:** N/A — analysis.
- **Verification:** A research doc section with a ranked list of findings and recommended next actions.

### U8. Reset cap and close test window

- **Goal:** Return the environment to the conservative default.
- **Requirements:** R6
- **Files:** shell environment
- **Approach:**
  1. `unset ASD_LLM_MAX_PER` (or close the shell session).
  2. Confirm `asd pipeline gate --skip-ingest` reports `max_per_window: "5/24h"` again.
- **Tests:** N/A — operational cleanup.
- **Verification:** Default cap restored.

## Worktree & concurrency

- **worktree_slug:** `test/harness-ingest-quality-review`
- **spine_owner:** self
- **Active conflicts:** none

## Write surfaces

- U1: shell environment, runtime state (read-only budget check)
- U2–U6: runtime ledger and knowledge artifacts (writes during ingest)
- U7–U8: `docs/research/2026-06-15-harness-ingest-quality-review.md`, shell environment

## Prior learnings applied

- `docs/solutions/tooling/openrouter-byok-effective-cost.md` — the USD sliding-window ceiling is the real guard; the per-call cap only controls burst rate.
- `docs/solutions/performance/openrouter-reasoning-tokens-dominate-trivial-tasks.md` — LLM topic rescue consumes reasoning tokens; keep batches small and bounded.
- `docs/plans/2026-06-15-chore-incremental-session-ingest.md` — source order and bounded `--limit` approach are borrowed from the backlog-drain plan.

## Deferred / out of scope

- Draining the full discovered backlog (covered by `docs/plans/2026-06-15-chore-incremental-session-ingest.md`).
- Code fixes for any regressions found; those become a new plan once findings are documented.
- Running `quality review-learnings` on the new sessions; that is U6 of `docs/plans/2026-06-15-chore-loosen-llm-budget-for-u6-test-plan.md`.
- Permanent changes to the default `ASD_LLM_MAX_PER` value.

## Open questions

- How many new/changed sessions exist per harness after `ingest sync`? (answered in U2–U6)
- Which harness, if any, shows disproportionate extraction noise after the latest changes? (answered in U7)
- Does the raised cap plus `--llm-topic` fit comfortably under the USD ceiling for ~50 sessions? (answered empirically during U2–U6)
