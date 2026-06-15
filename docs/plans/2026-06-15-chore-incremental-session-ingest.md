---
date: 2026-06-15
origin: direct brief — audit per-agent ingestion, spot-check quality, plan incremental backlog drain
td_epic: td-b0079c
---

# Incremental ingestion of remaining agent sessions

**Summary:** Drain the 5,145 discovered-but-unprocessed sessions across five sources in batched, source-ordered runs, sync any new/changed files first, then repair the 3 error-state sessions and resummarize low-signal outputs.

## Audit findings

Per-source ledger counts and latest dates (from `~/.agent-session-distillery/ledger/sessions.sqlite`):

| Source | Ledger sessions | Discovered (unprocessed) | Latest ingest | Latest session | Files on disk | Likely new files |
|--------|-----------------|--------------------------|---------------|----------------|---------------|------------------|
| claude-code | 710 | 6 + 5 stale | 2026-06-14T23:15:43Z | 2026-06-14T23:15:36Z | 1,159 | ~94 |
| cursor | 3,183 | 3,173 | 2026-06-14T23:15:37Z | 2026-06-14T23:14:48Z | 3,205 | ~58 |
| codex-cli | 973 | 963 | 2026-06-14T23:15:53Z | 2026-06-14T23:15:36Z | 879 | ~54* |
| kimi | 491 | 491 | 2026-06-14T23:16:02Z | 2026-06-12T04:17:01Z | 616 | 0 |
| pi | 522 | 512 | 2026-06-14T23:16:11Z | 2026-06-14T23:09:49Z | 564 | ~3 |
| **Total** | **5,879** | **5,145** | — | — | — | **~209** |

\* codex-cli ledger count exceeds file count, likely due to rotated archived sessions; `ingest sync` will reconcile.

Quality spot-check (`quality audit --limit 50`):
- 48 of 50 audited sessions had issues.
- Dominant issues: `summary_missing` (40 sessions), `blocked_deletion` (6), `summary_low_signal` (3).
- 3 sessions are in `error` state: 2 cursor, 1 codex-cli.
- Topic-distribution mode shows many projects with 100% low-signal topics because summaries have not been generated yet; this is expected to improve as the backlog drains.

## Requirements

- R1. Establish an accurate baseline of sessions already ingested per agent/source with counts and latest ingest/session dates.
- R2. Spot-check ingestion quality and identify the dominant failure modes.
- R3. Incrementally process the remaining discovered sessions through parse → reduce → summarize → extract → archive.
- R4. Repair error-state sessions and remediate quality issues (missing summaries, low-signal summaries, blocked deletion candidates).
- R5. Verify after each batch that lifecycle state counts shift toward `deletion_candidate`/`archived` and quality metrics improve.

## Key technical decisions

- **Sync before drain.** Run `ingest sync --resume --source <x>` for every adapter first so the backlog numbers include any files that have appeared on disk since the last run. This matches the existing `scripts/scheduled-memory-pipeline.sh` flow.
- **Source order by backlog size (smallest first).** Processing the smallest remaining backlogs first (claude-code → pi → kimi → codex-cli → cursor) gives early validation and makes regressions cheaper to catch.
- **Batch with `--limit` and `--resume`.** Each unit uses `ingest backfill --source <x> --limit N --resume` to keep individual runs bounded and resumable. `--resume` skips already-completed phase artifacts, so re-running the same command after a failure is safe.
- **Keep summarization deterministic by default.** The default `summarize-phase` is deterministic; LLM topic rescue is intentionally left out of the drain because the backlog is large and the existing `ASD_LLM_MAX_PER` budget is narrow.
- **Quality remediation after the backlog is down.** Re-summarization (`quality resummarize --low-signal-only`) and error repair are deferred until the bulk of sessions have completed the pipeline, so remediation runs against a stable corpus.
- **Rebuild before code changes.** If U7 requires an adapter fix, run `npm run build` before the next `ingest backfill`; the CLI is invoked from `dist/cli.js`.

## Implementation units

### U1. Sync new/changed sessions from all sources
- **Goal:** Update the ledger with any transcript files newer than the last recorded session for each source.
- **Requirements:** R1, R3
- **Files:** `scripts/scheduled-memory-pipeline.sh`, runtime ledger (`~/.agent-session-distillery/ledger/sessions.sqlite`)
- **Approach:**
  1. Run `node dist/cli.js ingest sync --resume --source claude-code`.
  2. Run `node dist/cli.js ingest sync --resume --source cursor`.
  3. Run `node dist/cli.js ingest sync --resume --source codex-cli`.
  4. Run `node dist/cli.js ingest sync --resume --source kimi`.
  5. Run `node dist/cli.js ingest sync --resume --source pi`.
  6. Capture the per-source `discovered_count` and `selected_count` from each JSON output.
- **Tests:** Each command exits 0; `selected_count` reflects sessions selected for processing, which should include the new/changed files on disk (cursor +58, claude-code +94, codex-cli +54, pi +3, kimi +0 expected based on file mtimes).
- **Verification:**
  ```bash
  sqlite3 ~/.agent-session-distillery/ledger/sessions.sqlite \
    "SELECT source_tool, COUNT(*) AS sessions, MAX(last_ingested_at) AS latest_ingest, MAX(started_at) AS latest_session FROM source_sessions GROUP BY source_tool;"
  ```

### U2. Ingest remaining claude-code sessions
- **Goal:** Drive the smallest backlog (≈6 discovered plus 5 stale) through the pipeline.
- **Requirements:** R3, R5
- **Files:** runtime ledger, `src/commands/ingest-backfill.ts`, `src/pipeline/`
- **Approach:** Run `node dist/cli.js ingest backfill --source claude-code --limit 50 --resume`. Because claude-code is already mostly processed, a single bounded run should clear it.
- **Tests:** Command exits 0 with `failed_count: 0`; `sessionsByLifecycle.discovered` drops by the prior discovered count.
- **Verification:**
  ```bash
  node dist/cli.js stats
  sqlite3 ~/.agent-session-distillery/ledger/sessions.sqlite \
    "SELECT source_tool, current_lifecycle_state, COUNT(*) FROM source_sessions WHERE source_tool = 'claude-code' GROUP BY current_lifecycle_state;"
  ```

### U3. Ingest remaining pi sessions
- **Goal:** Process the ≈512 discovered pi sessions in two batches of 300.
- **Requirements:** R3, R5
- **Files:** `src/adapters/pi/`, runtime ledger
- **Approach:**
  1. Run `node dist/cli.js ingest backfill --source pi --limit 300 --resume`.
  2. Re-run the same command until `selected_count` reaches 0.
- **Tests:** Each batch exits 0; total discovered pi sessions trends to 0.
- **Verification:** Same SQL pattern as U2 filtered by `source_tool = 'pi'`.

### U4. Ingest remaining kimi sessions
- **Goal:** Process the ≈491 discovered kimi sessions.
- **Requirements:** R3, R5
- **Files:** `src/adapters/kimi/`, runtime ledger
- **Approach:** Run `node dist/cli.js ingest backfill --source kimi --limit 500 --resume` (or split into 250-session batches if runtime is slow).
- **Tests:** Command exits 0; `failed_count: 0`; no new files are expected, so `discovered_count` should equal the prior ledger count of discovered kimi sessions.
- **Verification:** Same SQL pattern as U2 filtered by `source_tool = 'kimi'`.

### U5. Ingest remaining codex-cli sessions
- **Goal:** Process the ≈963 discovered codex-cli sessions.
- **Requirements:** R3, R5
- **Files:** `src/adapters/codex-cli/`, runtime ledger
- **Approach:** Run `node dist/cli.js ingest backfill --source codex-cli --limit 500 --resume` twice, then re-run until `selected_count` is 0.
- **Tests:** Each batch exits 0; failures are logged per session and do not block the batch.
- **Verification:** Same SQL pattern as U2 filtered by `source_tool = 'codex-cli'`.

### U6. Ingest remaining cursor sessions
- **Goal:** Process the ≈3,173 discovered cursor sessions, the largest backlog.
- **Requirements:** R3, R5
- **Files:** `src/adapters/cursor/`, runtime ledger
- **Approach:** Run `node dist/cli.js ingest backfill --source cursor --limit 500 --resume` repeatedly until `selected_count` reaches 0. Expect ~7 runs.
- **Tests:** Each run exits 0; track `failed_count` per run.
- **Verification:** Same SQL pattern as U2 filtered by `source_tool = 'cursor'`.

### U7. Repair error-state sessions
- **Goal:** Resolve the 3 sessions currently in `error` state (2 cursor, 1 codex-cli).
- **Requirements:** R4, R5
- **Files:** `src/pipeline/parse.ts`, `src/pipeline/reduce.ts`, `src/pipeline/summarize-phase.ts`, runtime ledger and staging paths
- **Approach:**
  1. Query the error sessions: `SELECT session_id, source_path, source_tool FROM source_sessions WHERE current_lifecycle_state = 'error';`.
  2. For each, inspect the most recent `run_history` row to identify the failing phase and error message.
  3. If the failure is transient (e.g., partial file, lock contention), rerun `ingest backfill --source <tool> --limit small --resume=false` for the source to rebuild derived artifacts for the sessions that fail resume checks. (The CLI does not currently support targeting a single session id.)
  4. If the failure is a parser bug, fix the adapter, then rerun the source-specific backfill with a tight `--limit` and `--resume=false` for the affected source.
- **Tests:** After repair, `stats` reports `sessionsByLifecycle.error: 0`.
- **Verification:**
  ```bash
  node dist/cli.js stats
  sqlite3 ~/.agent-session-distillery/ledger/sessions.sqlite \
    "SELECT session_id, source_tool, current_lifecycle_state FROM source_sessions WHERE current_lifecycle_state = 'error';"
  ```

### U8. Quality remediation: resummarize low-signal sessions
- **Goal:** Improve summaries that captured no durable signal and reduce blocked deletion candidates.
- **Requirements:** R2, R4, R5
- **Files:** `src/commands/quality-resummarize.ts`, `src/pipeline/topic-distribution.ts`, `scripts/resummarize-corpus.mjs`
- **Approach:**
  1. Run `node dist/cli.js quality resummarize --low-signal-only --dry-run` to estimate affected sessions.
  2. If the dry-run count is reasonable, run `npm run corpus:resummarize:dry-run` for a wider view.
  3. Run `npm run corpus:resummarize` (LLM topic by default; pass `--no-llm-topic` if the LLM budget is exhausted or the dry-run does not justify the cost).
  4. Re-run `node dist/cli.js quality audit --limit 100` and confirm `issue_counts.summary_low_signal` and `blocked_deletion` drop.
- **Tests:** Dry-run produces finite counts; full run completes; re-audit shows fewer low-signal issues.
- **Verification:**
  ```bash
  node dist/cli.js quality audit --limit 100
  node dist/cli.js stats
  ```

## Prior learnings applied

- `docs/solutions/performance/openrouter-reasoning-tokens-dominate-trivial-tasks.md` — keeping the drain deterministic avoids burning the narrow `ASD_LLM_MAX_PER` budget on large batches of trivial summarization work.
- `docs/solutions/tooling/openrouter-byok-effective-cost.md` — the `ASD_LLM_MAX_USD` sliding-window ceiling is respected by the existing `quality review-learnings` path; do not bypass it by running unbounded LLM topic rescue during the backlog drain.

## Deferred / out of scope

- New CLI subcommand for per-source audit report. The audit was performed with ad-hoc SQL; a first-class command can be added later if this becomes a recurring need.
- LLM topic rescue for the entire corpus. Too expensive for a single drain; use the existing `corpus:resummarize` recipe when budget and value align.
- Automatic scheduling/heartbeats. The `scheduled-memory-pipeline.sh` already exists; this plan drains the existing backlog so the schedule can maintain a low watermark going forward.
- Deletion apply (`delete apply --apply`). Deciding which ready sessions to delete is a separate retention decision, not part of ingestion.

## Open questions

- What is the root cause of the 3 error-state sessions? Need to inspect run history before deciding between re-run and code fix.
- What is a practical `--limit` for cursor in this environment? Start with 500 and adjust if runs exceed acceptable wall-clock time.
- Does `ingest sync` process all discovered sessions in one invocation, or will it need to be repeated? The current filter logic selects discovered sessions, but empirical `selected_count` will confirm.
