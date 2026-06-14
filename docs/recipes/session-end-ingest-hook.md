# SessionEnd auto-ingest hook (Claude Code)

Trigger `asd ingest sync --source claude-code` when a Claude Code session ends,
so the operator runtime stays fresh without relying on cron alone.

## Install (project scope)

From the repo you want to ingest after each session:

```bash
npm run build
asd hooks install
```

This writes:

- `.claude/hooks/asd-session-end-ingest.sh` — hook script (fail-open)
- `.claude/settings.json` — merges a `SessionEnd` hook entry (idempotent)

Commit `.claude/settings.json` and `.claude/hooks/` if you want the hook
shared with the team.

## Install (global scope)

Registers the hook in `~/.claude/settings.json` using an absolute path to this
repo's hook script:

```bash
asd hooks install --global
```

Run from the asd checkout so the hook script path resolves correctly.

## Dry run

```bash
asd hooks install --dry-run
```

## Behavior

- Drains SessionEnd stdin (Claude Code protocol)
- Runs `asd ingest sync --resume --source claude-code`
- Falls back to `node dist/cli.js` when `asd` is not on PATH but
  `CLAUDE_PROJECT_DIR/dist/cli.js` exists
- **Fail open** — ingest errors never block session termination

## See also

- [`scheduled-memory-pipeline.md`](scheduled-memory-pipeline.md) — cron/launchd batch pipeline
- [`../research/prior-art-deep-reads.md`](../research/prior-art-deep-reads.md) — SessionEnd design notes
