---
date: 2026-06-15
origin: direct brief
td_epic: td-db91c2
---

# Harness ingestion health sweep

**Summary:** Run incremental ingest sync across every harness, read the output/results for each, and audit quality deltas. Triage failures or regressions into fixes or follow-up tasks.

## Requirements

- **R1.** Run incremental sync (`asd ingest sync --resume --source <harness>`) for each adapter, starting with `claude-code`.
- **R2.** Capture and actually read each sync result: `discovered_count`, `selected_count`, `processed_count`, `failed_count`, `failures`.
- **R3.** After each sync, run `asd quality audit` and read the delta in issue counts and learning distribution.
- **R4.** Identify harness-specific failures, parse errors, or quality regressions.
- **R5.** File concrete issues in `td` or fix them immediately if trivial/reversible.
- **R6.** Capture non-obvious findings in `docs/solutions/`.

## Key technical decisions

- Use `ingest sync --resume` (not full backfill) to stay incremental and avoid reprocessing already-ingested sessions.
- Do **not** enable `--llm-topic` by default to avoid consuming the OpenRouter budget during a diagnostic sweep.
- Run `quality audit` after each harness so deltas are attributable to a single source.
- Use the existing `AGENT_SESSION_DISTILLERY_ROOT` runtime; do not create an isolated worktree because this is an operational check against live operator data.
- When `ingest sync --resume` reprocesses sessions that already have archived manifests, allow the archive phase to overwrite stale manifests and skip up-to-date archived sessions. This prevents "Immutable manifest already exists with different contents" failures on resumed incremental ingests.

## Implementation units

### U1. Sync and audit claude-code
- **Goal:** Ingest the latest Claude Code sessions and verify they process cleanly.
- **Requirements:** R1–R3
- **Commands:**
  ```bash
  npm run build
  node dist/cli.js ingest sync --resume --source claude-code
  node dist/cli.js quality audit
  ```
- **Read carefully:** `failed_count`, `failures`, `issue_counts`, `learning_distribution`.
- **Acceptance:** Output captured; any failures/regressions noted.

### U2. Sync and audit cursor
- **Goal:** Ingest the latest Cursor sessions and verify they process cleanly.
- **Requirements:** R1–R3
- **Commands:**
  ```bash
  node dist/cli.js ingest sync --resume --source cursor
  node dist/cli.js quality audit
  ```
- **Read carefully:** Same as U1. Cursor has the largest unprocessed backlog (3,215 discovered), so watch for `limit`/`timeout` and parse errors.
- **Acceptance:** Output captured; backlog size and any failures noted.

### U3. Sync and audit codex-cli
- **Goal:** Ingest the latest Codex CLI sessions and verify they process cleanly.
- **Requirements:** R1–R3
- **Commands:**
  ```bash
  node dist/cli.js ingest sync --resume --source codex-cli
  node dist/cli.js quality audit
  ```
- **Read carefully:** Same as U1.
- **Acceptance:** Output captured; any failures/regressions noted.

### U4. Sync and audit pi
- **Goal:** Ingest the latest Pi sessions and verify they process cleanly.
- **Requirements:** R1–R3
- **Commands:**
  ```bash
  node dist/cli.js ingest sync --resume --source pi
  node dist/cli.js quality audit
  ```
- **Read carefully:** Same as U1.
- **Acceptance:** Output captured; any failures/regressions noted.

### U5. Sync and audit kimi
- **Goal:** Ingest the latest Kimi sessions and verify they process cleanly.
- **Requirements:** R1–R3
- **Commands:**
  ```bash
  node dist/cli.js ingest sync --resume --source kimi
  node dist/cli.js quality audit
  ```
- **Read carefully:** Same as U1. Kimi has 0% processed history, so this may reveal adapter-specific issues.
- **Acceptance:** Output captured; any failures/regressions noted.

### U6. Synthesize findings and remediate
- **Goal:** Compare cross-harness results, triage issues, and apply fixes or create follow-up tasks.
- **Requirements:** R4–R6
- **Approach:**
  1. Build a side-by-side summary of per-harness sync results and audit deltas.
  2. For each failure, determine if it is transient, operational, or a code bug.
  3. Fix trivial/reversible bugs in this branch; file `td` tasks for larger work.
  4. If a non-obvious failure pattern emerges, write a `docs/solutions/` entry.
- **Verification:** `npm test` and `npm run lint` pass after any code changes; `td tree td-db91c2` shows clean status.

## Prior learnings applied

- `docs/recipes/scheduled-memory-pipeline.md` — canonical order is `ingest sync --resume --source <adapter>` followed by `quality audit`. This sweep follows that order without the LLM-bound steps.
- `docs/recipes/session-end-ingest-hook.md` — claude-code has an auto-ingest hook; U1 may produce fewer new sessions than expected because the hook already syncs incrementally.

## Deferred / out of scope

- Full historical backfill (`ingest backfill`) for any harness.
- LLM topic rescue or `quality review-learnings` (budgeted separately).
- `memory export-wiki` / `memory push-wiki`.

## Results

### U1. claude-code

```bash
node dist/cli.js ingest sync --resume --source claude-code
```

- `discovered_count`: 635
- `selected_count`: 51
- `processed_count`: 51
- `failed_count`: 0
- `failures`: []

`quality audit` delta after U1:

| Metric | Before U1 | After U1 | Delta |
|---|---|---|---|
| `issue_counts.summary_missing` | 5,237 | 5,225 | −12 |
| `issue_counts.process_chatter` | 402 | 436 | +34 |
| `issue_counts.summary_low_signal` | 133 | 135 | +2 |
| `issue_counts.no_project_learnings` | 125 | 130 | +5 |
| `learning_distribution.sessions_with_project_learnings` | 435 | 479 | +44 |
| `learning_distribution.total_project_learnings` | 2,288 | 2,441 | +153 |
| `learning_distribution.max_project_learnings` | 12 | 12 | 0 |
| `learning_distribution.percentiles.p99` | 12 | 12 | 0 |
| `deletion_readiness.ready` | 562 | 610 | +48 |
| `deletion_readiness.missing_candidate` | 5,237 | 5,225 | −12 |

No failures. New sessions enriched cleanly; cap held at 12.

### U2. cursor

```bash
node dist/cli.js ingest sync --resume --source cursor
```

- `discovered_count`: 3,244
- `selected_count`: 1,030
- `processed_count`: 1,030
- `failed_count`: 0
- `failures`: []

**Bug found and fixed during U2:** `ingest sync --resume` was failing on sessions that already had archived manifests with `Immutable manifest already exists with different contents`. The fix in `src/commands/ingest-backfill.ts`:

- Skip the archive phase when `resume` is true and the existing `archived` checkpoint is completed with the same source hash.
- Allow manifest overwrite during archive when `resume` is true and the checkpoint is missing or stale.

`quality audit` delta after U2:

| Metric | After U1 | After U2 | Delta |
|---|---|---|---|
| `issue_counts.summary_missing` | 5,225 | 2,029 | −3,196 |
| `issue_counts.process_chatter` | 436 | 787 | +351 |
| `issue_counts.summary_low_signal` | 135 | 553 | +418 |
| `issue_counts.no_project_learnings` | 130 | 1,256 | +1,126 |
| `learning_distribution.sessions_with_project_learnings` | 479 | 2,111 | +1,632 |
| `learning_distribution.total_project_learnings` | 2,441 | 5,545 | +3,104 |
| `learning_distribution.max_project_learnings` | 12 | 12 | 0 |
| `learning_distribution.percentiles.p99` | 12 | 12 | 0 |
| `deletion_readiness.ready` | 610 | 2,452 | +1,842 |
| `deletion_readiness.missing_candidate` | 5,225 | 2,029 | −3,196 |

No failures after the manifest-overwrite fix. Cursor added the bulk of the corpus; many new sessions are low-signal or have no durable learnings, which is expected for a first-time sync.

### U3. codex-cli

```bash
node dist/cli.js ingest sync --resume --source codex-cli
```

- `discovered_count`: 895
- `selected_count`: 880
- `processed_count`: 880
- `failed_count`: 0
- `failures`: []

`quality audit` delta after U3:

| Metric | After U2 | After U3 | Delta |
|---|---|---|---|
| `issue_counts.summary_missing` | 2,029 | 1,150 | −879 |
| `issue_counts.process_chatter` | 787 | 1,156 | +369 |
| `issue_counts.summary_low_signal` | 553 | 594 | +41 |
| `issue_counts.no_project_learnings` | 1,256 | 1,640 | +384 |
| `learning_distribution.sessions_with_project_learnings` | 2,111 | 2,565 | +454 |
| `learning_distribution.total_project_learnings` | 5,545 | 6,807 | +1,262 |
| `learning_distribution.max_project_learnings` | 12 | 12 | 0 |
| `learning_distribution.percentiles.p99` | 12 | 12 | 0 |
| `deletion_readiness.ready` | 2,452 | 2,980 | +528 |
| `deletion_readiness.missing_candidate` | 2,029 | 1,150 | −879 |

No failures. Codex CLI sessions enriched cleanly.

### U4. pi

```bash
node dist/cli.js ingest sync --resume --source pi
```

- `discovered_count`: 537
- `selected_count`: 529
- `processed_count`: 529
- `failed_count`: 0
- `failures`: []

`quality audit` delta after U4:

| Metric | After U3 | After U4 | Delta |
|---|---|---|---|
| `issue_counts.summary_missing` | 1,150 | 638 | −512 |
| `issue_counts.process_chatter` | 1,156 | 1,203 | +47 |
| `issue_counts.summary_low_signal` | 594 | 735 | +141 |
| `issue_counts.no_project_learnings` | 1,640 | 1,785 | +145 |
| `learning_distribution.sessions_with_project_learnings` | 2,565 | 2,807 | +242 |
| `learning_distribution.total_project_learnings` | 6,807 | 7,798 | +991 |
| `learning_distribution.max_project_learnings` | 12 | 12 | 0 |
| `learning_distribution.percentiles.p99` | 12 | 12 | 0 |
| `deletion_readiness.ready` | 2,980 | 3,236 | +256 |
| `deletion_readiness.missing_candidate` | 1,150 | 638 | −512 |

No failures. Pi sessions enriched cleanly.

### U5. kimi

```bash
node dist/cli.js ingest sync --resume --source kimi
```

- `discovered_count`: 491
- `selected_count`: 0 (already processed by earlier run)
- `processed_count`: 0
- `failed_count`: 0
- `failures`: []

The re-run was idempotent: all 491 kimi sessions were already ingested. Initial U5 processing had `selected_count: 491` and `processed_count: 491` with `failed_count: 0`.

`quality audit` delta after U5 (final state):

| Metric | After U4 | After U5 | Delta |
|---|---|---|---|
| `issue_counts.summary_missing` | 638 | 147 | −491 |
| `issue_counts.process_chatter` | 1,203 | 1,548 | +345 |
| `issue_counts.summary_low_signal` | 735 | 770 | +35 |
| `issue_counts.no_project_learnings` | 1,785 | 1,906 | +121 |
| `learning_distribution.sessions_with_project_learnings` | 2,807 | 3,142 | +335 |
| `learning_distribution.total_project_learnings` | 7,798 | 9,202 | +1,404 |
| `learning_distribution.max_project_learnings` | 12 | 12 | 0 |
| `learning_distribution.percentiles.p99` | 12 | 12 | 0 |
| `deletion_readiness.ready` | 3,236 | 3,577 | +341 |
| `deletion_readiness.missing_candidate` | 638 | 147 | −491 |

No failures. Kimi sessions enriched cleanly and the 12-learning cap held.

## U6. Synthesize findings and remediate

### Cross-harness summary

| Harness | Discovered | Selected | Processed | Failed | summary_missing Δ | process_chatter Δ | no_project_learnings Δ | sessions_with_project_learnings Δ | total_project_learnings Δ | ready Δ |
|---|---|---|---|---|---|---|---|---|---|---|
| claude-code | 635 | 51 | 51 | 0 | −12 | +34 | +5 | +44 | +153 | +48 |
| cursor | 3,244 | 1,030 | 1,030 | 0 | −3,196 | +351 | +1,126 | +1,632 | +3,104 | +1,842 |
| codex-cli | 895 | 880 | 880 | 0 | −879 | +369 | +384 | +454 | +1,262 | +528 |
| pi | 537 | 529 | 529 | 0 | −512 | +47 | +145 | +242 | +991 | +256 |
| kimi | 491 | 491* | 491* | 0 | −491 | +345 | +121 | +335 | +1,404 | +341 |

\* Initial U5 values; re-run was idempotent with 0 selected/processed.

### Final corpus state

| Metric | Value |
|---|---|
| `totals.audited` | 6,050 |
| `totals.with_issues` | 4,670 |
| `issue_counts.blocked_deletion` | 2,132 |
| `issue_counts.summary_missing` | 147 |
| `issue_counts.summary_low_signal` | 770 |
| `issue_counts.process_chatter` | 1,548 |
| `issue_counts.no_project_learnings` | 1,906 |
| `issue_counts.no_useful_commands` | 874 |
| `issue_counts.no_files_of_interest` | 1,200 |
| `learning_distribution.max_project_learnings` | 12 |
| `learning_distribution.percentiles.p99` | 12 |
| `learning_distribution.sessions_with_project_learnings` | 3,142 |
| `learning_distribution.total_project_learnings` | 9,202 |
| `deletion_readiness.ready` | 3,577 |
| `deletion_readiness.blocked` | 2,132 |

### Findings

1. **No ingest failures across any harness.** Every `ingest sync --resume --source <harness>` completed with `failed_count: 0` after the U2 manifest-overwrite fix.
2. **The learning cap is holding.** `max_project_learnings` and `p99` stayed at 12 across all audits, confirming the per-session cap from the earlier refactor is effective.
3. **Cursor is the dominant backlog.** Cursor contributed ~56% of discovered sessions (3,244 / 5,802) and ~45% of total project learnings added during the sweep.
4. **Low-signal/no-learning sessions dominate new ingest.** The largest issue categories are `blocked_deletion` (2,132), `no_project_learnings` (1,906), and `process_chatter` (1,548). These are content-quality issues, not code failures.
5. **Process chatter and no-project-learnings rise with every new harness.** Each first-time sync added hundreds of `process_chatter` and `no_project_learnings` issues. This is expected because the chatter filter and learning promotion heuristics were tuned on the claude-code corpus and generalize imperfectly to other harness transcript styles.
6. **No harness-specific parse errors observed.** All transcript parsers accepted the discovered sessions; failures were blocked only by quality gates.

### Remediation applied

- **Code fix in U2:** `src/commands/ingest-backfill.ts` now skips the archive phase when a resumed session has an up-to-date archived checkpoint, and allows manifest overwrite when the checkpoint is stale. This fixed the only code bug surfaced by the sweep.
- **Documentation:** `docs/solutions/tooling/resume-manifest-overwrite.md` captures the resume + immutable-manifest pattern so future harness adapters do not repeat it.

### Follow-up tasks filed

See `td tree td-db91c2` for child tasks:

- **td-4ea028** Reduce `process_chatter` false positives for cursor/codex/pi/kimi transcripts.
- **td-243ae5** Improve project-learning promotion for non-claude-code harnesses.
- **td-6d462b** Investigate 147 remaining `summary_missing` candidates (mostly kimi adapter transcripts).
- **td-4783df** Run `quality review-learnings` on the 770 `summary_low_signal` sessions once budget is allocated.

### Open questions

- How large are the per-harness backlogs, and will any sync exceed a reasonable runtime? If so, add `--limit` and run in batches.
- Are the harness adapter directories (Cursor, Codex CLI, Pi, Kimi) installed and readable on this machine? If an adapter has no transcripts, the sync will report `discovered_count: 0`.
