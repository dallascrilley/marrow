# 0007. Daemon-LLM separation for scheduled pipeline

- **Status:** accepted
- **Date:** 2026-06-14

## Context

The scheduled memory pipeline runs ingest, audit, optional LLM learning review,
apply, and vault export. Prior art (claude-heartbeat) separates a cheap
file-scan / manifest-diff watcher from LLM-gated distillation passes. asd
already uses cheap deterministic ingest (`ingest sync --resume` with
`onlyNewOrChanged`) but `quality review-learnings` could still invoke
OpenRouter on every cron tick even when no new learnings exist.

Operators running a 6-hour cron need:

1. A cheap pre-check that answers "is there work?" before LLM calls.
2. A sliding-window budget (`max_per: N/24h`) so backlog spikes do not
   exhaust API quota in one run.

## Options

### Option A — Shell-only gates in `scheduled-memory-pipeline.sh`

Parse filesystem mtime and sidecar presence in bash. No new CLI surface.

- **Pros:** Zero TypeScript churn.
- **Cons:** Duplicates ingest/discover logic; brittle; hard to test.

### Option B — `asd pipeline gate` + flags on LLM commands (chosen)

Add a JSON gate command that reuses discover + filesystem checks, plus
`--if-new` and `--max-per` on `quality review-learnings`. Wire the
scheduled shell script to call both.

- **Pros:** Testable; reuses ledger/discover; operator can run gate manually.
- **Cons:** Discover phase still touches ledger upserts (cheap vs LLM).

### Option C — Long-running daemon with internal queue

Separate OS service watching transcript dirs continuously.

- **Pros:** Lowest latency.
- **Cons:** Scope creep; launchd/cron recipe already documented; not needed
  for v1 post-ship automation.

## Decision

Ship **Option B**:

- `asd pipeline gate` reports pending ingest sessions (per adapter),
  unreviewed project learnings, and LLM budget headroom.
- `quality review-learnings` accepts `--if-new` and `--max-per N/Tu`
  (default from `ASD_LLM_MAX_PER`, fallback `5/24h`).
- Budget uses persist file `reports/llm-budget.json` under the runtime root.
- `scripts/scheduled-memory-pipeline.sh` calls gate before audit and passes
  gate flags to review-learnings.

No new daemon process. Full daemon remains out of scope.

## Consequences

- Scheduled runs skip OpenRouter when learnings are already reviewed or
  budget is exhausted (exit 0 with `skipped: true` JSON).
- Operators can inspect gate output without API keys.
- Future work: extend gate to corpus resummarize `--llm-topic` budget;
  tiered warn/pause thresholds (80/90/100%) from prior-art notes.
