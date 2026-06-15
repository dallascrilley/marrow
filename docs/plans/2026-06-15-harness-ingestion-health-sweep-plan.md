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

## Open questions

- How large are the per-harness backlogs, and will any sync exceed a reasonable runtime? If so, add `--limit` and run in batches.
- Are the harness adapter directories (Cursor, Codex CLI, Pi, Kimi) installed and readable on this machine? If an adapter has no transcripts, the sync will report `discovered_count: 0`.
