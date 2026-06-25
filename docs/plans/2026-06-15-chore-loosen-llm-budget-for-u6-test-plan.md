---
date: 2026-06-15
origin: direct brief (follow-up to quality-improvements U6)
td_epic: td-85e202
---

# Loosen LLM per-call cap for controlled U6 `review-learnings` test

**Summary:** The default `5/24h` sliding-window cap is blocking U6 (`quality review-learnings` on 770 low-signal / 9,203 pending learnings). The USD budget is healthy and the code already supports explicit per-run override via `--max-per` and `ASD_LLM_MAX_PER`. This plan uses those existing controls to run a small trial, measure real cost per learning, then do a bounded sweep while keeping the hard USD ceiling in place.

## Requirements

- **R1.** Use the existing per-call budget override (`--max-per` / `ASD_LLM_MAX_PER`) instead of changing the hardcoded default.
- **R2.** Keep the USD ceiling (`ASD_LLM_MAX_USD`, default `1/24h`) as the hard spend guard for the test key.
- **R3.** Start with a small trial to measure actual cost per learning and verdict distribution before scaling up.
- **R4.** Capture cost, verdict, and audit-impact results in `docs/research/` so the default can stay conservative.
- **R5.** After the test, leave the default cap at `5/24h`; any future loosening must be explicit per-run.

## Key technical decisions

- **Explicit per-run override.** Pass `--max-per` on the CLI for each test run (e.g., `25/24h` for the trial) rather than exporting `ASD_LLM_MAX_PER`. This leaves an audit trail in shell history and avoids silently widening the scheduled pipeline.
- **USD ceiling remains the real guard.** The per-call cap only limits *how fast* we spend; the USD cap limits *how much*. Per `docs/solutions/tooling/openrouter-byok-effective-cost.md`, telemetry budgets on effective upstream cost, so BYOK spend is still captured.
- **Bounded batches.** Use `--max-total-learnings` to cap each run. Trial at 25 learnings, then scale based on measured cost.
- **Per-call means per session.** One `review-learnings` command run reviews one session per HTTP call (batched internally), so `--max-per` limits sessions per window, not individual learnings.
- **Check headroom first.** Run `asd pipeline gate --max-per ... --skip-ingest` before each spend to confirm both count and USD budgets allow the run.

## Implementation units

### U1. Regression-test the override path

- **Goal:** Ensure the existing `--max-per` CLI override and `ASD_LLM_MAX_PER` env default work and are not accidentally broken later.
- **Requirements:** R1
- **Files:** `test/llm-budget.test.mjs`, `test/pipeline-gate.test.mjs`
- **Approach:**
  1. Add a test that `getDefaultMaxPerWindow()` reads `ASD_LLM_MAX_PER` and falls back to `5/24h`.
  2. Add a test that `pipeline gate --max-per 10/24h --skip-ingest` reports `max_per_window: "10/24h"` and allows the run when no recent uses exist.
- **Tests:**
  - Env override changes the reported default.
  - CLI `--max-per` overrides the env default.
  - Invalid spec throws the expected error message.
- **Verification:** `script/test` passes.

### U2. Run a small cost-measurement trial

- **Goal:** Spend a few calls to get real telemetry for cost per learning, batch size, and verdict distribution.
- **Requirements:** R1, R2, R3
- **Files:** `docs/research/2026-06-15-review-learnings-budget-check.md` (append results)
- **Approach:**
  1. Confirm headroom: `asd pipeline gate --max-per 25/24h --skip-ingest`.
  2. Run review on a bounded set: `asd quality review-learnings --if-new --max-per 25/24h --max-total-learnings 25`.
  3. Record `llm-learning-review.jsonl`, `llm-telemetry.jsonl`, and gate output.
- **Tests:** N/A — operational step.
- **Verification:** Trial completes, telemetry shows cost per learning, no USD-budget exhaustion.

### U3. Analyze trial telemetry and choose scaled batch size

- **Goal:** Decide how many learnings can safely be reviewed per window given the USD cap.
- **Requirements:** R2, R3
- **Files:** `docs/research/2026-06-15-review-learnings-budget-check.md`
- **Approach:**
  1. Compute mean/p90 cost per learning from `llm-telemetry.jsonl`.
  2. Estimate how many learnings fit under the `$1/24h` cap with headroom.
  3. Choose `--max-total-learnings` for the sweep (e.g., 100–300) and decide whether to keep `--max-per` at 25/24h or raise it further (e.g., to `50/24h`).
- **Tests:** N/A — analysis step.
- **Verification:** A written decision in the research doc: chosen cap, batch size, expected spend, and stop conditions.

### U4. Run scaled U6 sweep

- **Goal:** Make material progress on the 9,203 pending learnings within the test budget.
- **Requirements:** R1, R2, R4
- **Files:** `docs/research/2026-06-15-review-learnings-budget-check.md`
- **Approach:**
  1. Run `asd quality review-learnings --if-new --max-per <chosen> --max-total-learnings <chosen>` one or more times as the window refreshes.
  2. Stop if USD budget remaining drops below a safe threshold (e.g., $0.25) or if verdict quality degrades.
- **Tests:** N/A — operational step.
- **Verification:** Sidecar JSONL exists, telemetry shows spend under the USD cap, and the run completed without an unexpected budget block.

### U5. Apply reviews and measure audit impact

- **Goal:** Turn reviewed sidecars into promoted/updated learnings and verify the quality audit improves.
- **Requirements:** R4
- **Files:** N/A
- **Approach:**
  1. `asd quality apply-learning-review` to write `projects-reviewed` and v2 instincts.
  2. Re-run `asd quality audit --limit 200` and compare counts against the baselines in `docs/research/2026-06-15-review-learnings-budget-check.md` (`summary_low_signal: 770`) and `docs/research/2026-06-15-no-project-learnings-findings.md` (`no_project_learnings: 1,906`).
- **Tests:** N/A — operational step.
- **Verification:** Audit output captured and compared; at minimum, `summary_low_signal` should not increase (ideally it decreases). Changes to `total_project_learnings` and `no_project_learnings` are recorded but are not hard gates, because review may reject low-quality candidates.

### U6. Document findings and keep default tight

- **Goal:** Make the test repeatable and justify keeping the conservative default.
- **Requirements:** R4, R5
- **Files:** `docs/research/2026-06-15-review-learnings-budget-check.md`, `docs/recipes/scheduled-memory-pipeline.md` (optional note)
- **Approach:**
  1. Append final numbers: cap used, total learnings reviewed, cost, verdict breakdown, audit impact.
  2. Add a one-line recipe: “To run a temporary larger sweep, use `--max-per N/24h --max-total-learnings M` while keeping `--max-usd` as the hard ceiling.”
- **Tests:** N/A — docs step.
- **Verification:** Research doc reads as a complete post-mortem; default remains `5/24h`.

## Prior learnings applied

- `docs/solutions/tooling/openrouter-byok-effective-cost.md` — the USD budget must guard on *effective* upstream cost, not OpenRouter’s pass-through `usage.cost`. We keep `ASD_LLM_MAX_USD` unchanged and rely on telemetry that already captures effective cost.

## Deferred / out of scope

- Changing the hardcoded `defaultMaxPer = "5/24h"` in `src/pipeline/llm-budget.ts`.
- Adding a `--dry-run` mode to `quality review-learnings`.
- Automating the raised cap in `scripts/scheduled-memory-pipeline.sh`.
- Backfilling all 9,203 learnings in one window if the USD cap prevents it.

## Open questions

- What is the actual cost per learning at the current model/batch size? (answered in U2/U3)
- Does raising `--max-per` above 25/24h provide enough throughput without hitting the USD cap? (answered in U3)
- How many low-signal sessions are rescuable by review vs. still noise after review? (answered in U5)
