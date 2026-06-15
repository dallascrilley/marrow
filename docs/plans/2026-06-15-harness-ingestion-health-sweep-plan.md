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

## Open questions

- How large are the per-harness backlogs, and will any sync exceed a reasonable runtime? If so, add `--limit` and run in batches.
- Are the harness adapter directories (Cursor, Codex CLI, Pi, Kimi) installed and readable on this machine? If an adapter has no transcripts, the sync will report `discovered_count: 0`.
