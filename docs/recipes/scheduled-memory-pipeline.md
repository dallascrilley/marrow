# Scheduled memory pipeline

Run the canonical memory pipeline on a cadence without manual coupling.
Uses the v1 CLI surface today; v2 instinct sync happens inside
`quality apply-learning-review`.

## Pipeline order

```text
ingest sync --resume --source <adapter>
  → pipeline gate --max-per 5/24h
  → quality audit --limit 100
  → [optional] quality review-learnings --if-new --max-per 5/24h   # requires OPENROUTER_API_KEY
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

Run this on a weekly or monthly cadence — not on the same 6-hour ingest cron.
Full resummarize may invoke `--llm-topic` when `OPENROUTER_API_KEY` is set.

## Environment

| Variable | Purpose |
| --- | --- |
| `AGENT_SESSION_DISTILLERY_ROOT` | Runtime dir (default `~/.agent-session-distillery`) |
| `ASD_VAULT_ROOT` | Vault root for `memory push-wiki` (default `~/vault`) |
| `OPENROUTER_API_KEY` | Required only when running `quality review-learnings` |
| `ASD_LLM_MAX_PER` | Sliding-window LLM budget for review-learnings (default `5/24h`) |

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

## Failure handling

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
