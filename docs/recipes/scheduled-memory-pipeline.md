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
  → [optional] quality review-learnings --if-new --max-total-learnings 100   # requires OPENROUTER_API_KEY
  → quality apply-learning-review         # writes projects-reviewed + v2 instincts
  → memory export-wiki
  → memory push-wiki                      # requires ~/vault or ASD_VAULT_ROOT
```

Repeat `ingest sync` per adapter you care about (`cursor`, `claude-code`,
`codex-cli`, `pi`, `kimi`).

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
- **review-learnings skipped:** `apply-learning-review` only promotes rows already in `reports/llm-learning-review.jsonl` or existing reviewed sidecars.
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
