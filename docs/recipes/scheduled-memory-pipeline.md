# Scheduled memory pipeline

Run the canonical memory pipeline on a cadence without manual coupling.
Uses the v1 CLI surface today; v2 instinct sync happens inside
`quality apply-learning-review`.

## Pipeline order

```text
ingest sync --resume --source <adapter>
  → check                                  # read-only integrity; exit non-zero on violations
  → pipeline gate --skip-ingest             # after ingest; LLM + budget + integrity rollup
  → quality audit --limit 100
  → [optional] quality review-learnings --if-new --max-total-learnings 100   # emits immutable batch_path
  → quality apply-learning-review --batch <that-batch-path>                 # only when this run generated one
  → memory export-wiki
  → memory push-wiki                      # requires ~/vault or ASD_VAULT_ROOT
```

Repeat `ingest sync` per adapter you care about (`cursor`, `claude-code`,
`codex-cli`, `pi`, `kimi`).

## Operator health snapshot

Use the read-only health summary before a manual run, after a failed scheduled run, or in
a lightweight monitor:

```bash
node dist/cli.js health
node dist/cli.js health --json
```

The human output includes system health, the last recall delivery, blockers, review
freshness, count/USD budget headroom, storage pressure, and one copyable next command.
It does not invoke the OpenRouter provider probe; `Provider: not checked` is intentional.
Run `node dist/cli.js doctor provider` only when provider-specific diagnostics are needed.

`health` exits `0` when healthy, `1` when degraded, and `2` when the model cannot be
read. `--json` emits the typed health model on successful reads and an explicit
`{ "status": "unverifiable", "error": "..." }` report when a reader fails.

## Optional corpus health (weekly or before full resummarize)

After `quality audit`, you can check whether archived sessions still have
low-signal topics before mutating summaries:

```bash
npm run corpus:resummarize:dry-run
```

When the dry-run shows sessions worth upgrading, run the full pass (mutates
summary topics and re-exports the session index; manifests stay immutable):

```bash
npm run corpus:resummarize
```

Uses the same `ASD_LLM_MAX_PER` sliding-window budget file
(`reports/llm-budget.json`) as `quality review-learnings` when `--llm-topic` is
enabled (default unless `resummarize-corpus.mjs --no-llm-topic`).

**Budget accounting differs by command:**

| Command | One budget "use" means |
| --- | --- |
| `quality review-learnings` | One command run that reviewed at least one learning (may include many OpenRouter calls) |
| `quality resummarize --llm-topic` | One successful LLM topic generation (`topic_source: "llm"`) |

When the count budget is exhausted, `review-learnings` exits early with
`skipped: true`. The default count cap is intentionally generous (`50/24h`) and
only smooths bursts; the tighter financial guard is `ASD_LLM_MAX_USD` (default
`1/24h`). Resummarize continues with deterministic topics only when its LLM
topic budget is exhausted.

## Environment

| Variable | Purpose |
| --- | --- |
| `AGENT_SESSION_DISTILLERY_ROOT` | Runtime dir (default `~/.agent-session-distillery`) |
| `ASD_VAULT_ROOT` | Vault root for `memory push-wiki` (default `~/vault`) |
| `OPENROUTER_API_KEY` | Required only when running `quality review-learnings`; source from 1Password **OpenRouter API Credentials - agent-session-distillery** |
| `ASD_LLM_MAX_PER` | Sliding-window LLM count budget shared by review-learnings and corpus resummarize (default `50/24h`; use smaller `--max-per` values for deliberate trials) |
| `ASD_LLM_MAX_USD` | USD ceiling for LLM review spend (default `1/24h`; the real financial guard) |
| `OPENROUTER_MODEL` | Model for `quality review-learnings` (launcher default: `google/gemini-3-flash-preview`) |

Build the CLI once after checkout updates:

```bash
cd /path/to/agent-session-distillery
npm install
npm run build
```

## Cron (Linux / macOS)

```cron
# Every 6 hours — cursor ingest + audit + apply + wiki push
0 */6 * * * /path/to/agent-session-distillery/scripts/scheduled-memory-pipeline.sh >> /tmp/asd-pipeline.log 2>&1
```

## launchd (macOS)

Save as `~/Library/LaunchAgents/com.dallascrilley.asd-memory-pipeline.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.dallascrilley.asd-memory-pipeline</string>
    <key>ProgramArguments</key>
    <array>
      <string>/bin/bash</string>
      <string>/path/to/agent-session-distillery/scripts/scheduled-memory-pipeline.sh</string>
    </array>
    <key>StartInterval</key>
    <integer>21600</integer>
    <key>StandardOutPath</key>
    <string>/tmp/asd-pipeline.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/asd-pipeline.err.log</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>AGENT_SESSION_DISTILLERY_ROOT</key>
      <string>/Users/you/.agent-session-distillery</string>
      <key>ASD_VAULT_ROOT</key>
      <string>/Users/you/vault</string>
    </dict>
  </dict>
</plist>
```

Load:

```bash
launchctl load ~/Library/LaunchAgents/com.dallascrilley.asd-memory-pipeline.plist
```

## Wrapper script

`scripts/scheduled-memory-pipeline.sh` runs the steps above and exits
non-zero on the first failure so cron/launchd can surface regressions.
The wrapper captures the review command's JSON result and passes its exact
`batch_path` to apply. A skipped, budget-blocked, failed, or zero-review run
never falls back to an older batch. Apply retries remain safe because completed
batches are no-ops and incomplete batches converge through the append-only
apply ledger.

Parsed staging retention is independent of review generation and runs before audit/LLM steps.
Every scheduled run applies the safe parsed cleanup with a 30-day age gate and a 1 GB byte
ceiling by default. Override them with `ASD_PARSED_RETENTION_OLDER_THAN_DAYS` and
`ASD_PARSED_MAX_TOTAL_BYTES`. Report compaction remains opt-in via
`ASD_ENABLE_COMPACTION=1` and bound to a newly generated and applied review batch.


## Operator-local launcher (paid tier)

The deployed macOS setup adds one layer the plist example above doesn't show
(verified 2026-07-06): the live plist's `ProgramArguments` points at an
operator-local launcher, **not** at the repo script directly:

```text
launchd (6h) → ~/.agent-session-distillery/run-pipeline.sh   # operator-local, outside the repo
                 → sources ~/.agent-session-distillery/secrets.env  (600; OPENROUTER_API_KEY)
                 → exports OPENROUTER_MODEL (default google/gemini-3-flash-preview)
                 → exports ASD_LLM_MAX_USD (default 0.50/24h)
                 → exec scripts/scheduled-memory-pipeline.sh          # this repo, primary checkout dist/
```

Consequences:

- **No drift risk from copying:** the launcher `exec`s the repo script in
  place, so pipeline-step changes ship by committing to `main` and rebuilding
  the primary checkout's `dist/` (the launcher never snapshots the script).
- **Secrets stay out of the plist and the repo:** the API key lives only in
  the 600-perm `secrets.env`, read at runtime.
- **Paid tier is a file, not a code path:** delete `secrets.env` (or point the
  plist back at `scripts/scheduled-memory-pipeline.sh`) to drop to the free
  tier — `review-learnings` is skipped whenever `OPENROUTER_API_KEY` is unset.
- The launcher itself is operator-owned config; only its existence and
  contract are documented here.

## Failure handling

- **Integrity check fails:** `check` exits non-zero on duplicate/orphan findings; the scheduled wrapper stops before audit/LLM steps. Inspect with `asd check` (human output) or `asd check --json`. `pipeline gate` also surfaces `session_integrity` and sets `recommendations.run_check` when violations exist.
- **Ingest fails:** later steps still see stale data; check adapter paths and `ingest sync` logs.
- **review-learnings skipped or budget-blocked:** no batch is generated, so the scheduled wrapper skips apply and continues with the existing reviewed-memory export.
- **review batch absent:** report compaction is skipped, but safe parsed staging retention has already run.
- **apply interrupted:** rerun the explicit `quality apply-learning-review --batch <batch-path>` command shown in the prior pipeline log; the apply ledger records `applying`/`failed`/`applied` transitions and the retry merges by learning id.
- **credentials absent:** the wrapper skips both review and apply; it never applies a previous batch implicitly.
- **Vault missing:** `memory push-wiki` exits 0 with a notice; export JSONL still updates under the runtime root.
- **Partial adapter failure:** run adapters independently; one bad source should not block others.

## Smoke verification

Before enabling a schedule, run:

```bash
npm run proof:smoke
```

Or v2-only:

```bash
node scripts/proof-smoke.mjs --suite v2
```

To revalidate the immutable-batch and transaction-ledger guarantees, run the
bounded proof separately. It uses an isolated runtime; `--live` reviews at most
one fixture learning with a `1/24h` count cap and `$0.05/24h` spend cap.

```bash
OPENROUTER_API_KEY=<secret> node scripts/proof-review-apply-exactly-once.mjs --live
```

The latest checked-in receipt is
[`docs/ops/proofs/2026-07-09-review-apply-exactly-once.md`](../ops/proofs/2026-07-09-review-apply-exactly-once.md).
