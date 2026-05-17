# agent-session-distillery

Standalone CLI for ingesting local Cursor agent transcripts into a durable runtime with summaries, learnings, manifests, review state, and deletion receipts.

## Requirements

- Node `22.x`
- npm
- Local Cursor transcript files on disk

## Install

```bash
npm install
npm run build
```

Run the CLI directly:

```bash
node dist/cli.js --help
```

Or link the package-local `asd` binary into your shell:

```bash
npm link
asd --help
```

By default the runtime lives at `~/.agent-session-distillery`. Override it with `AGENT_SESSION_DISTILLERY_ROOT` when you want an isolated sandbox or a scheduled-job-specific path.

```bash
AGENT_SESSION_DISTILLERY_ROOT=/tmp/asd-demo node dist/cli.js stats
```

## Supported Cursor Sources

v1 supports only local Cursor data that is present on disk.

Transcript inputs:

- `~/.cursor/projects/<workspace-slug>/agent-transcripts/*.jsonl`
- `~/.cursor/projects/<workspace-slug>/agent-transcripts/*.txt`

Workspace mapping hints used to recover the real workspace path:

- `~/.cursor/projects/<workspace-slug>/workspace.json`
- `~/.cursor/projects/<workspace-slug>/workspace-path.txt`
- `~/.cursor/projects/<workspace-slug>/workspace.txt`
- `~/.cursor/projects/<workspace-slug>/project.json`
- `~/.cursor/projects/<workspace-slug>/metadata.json`

Optional Cursor support databases that improve attribution but are not required for transcript discovery:

- `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`
- `~/Library/Application Support/Cursor/User/workspaceStorage/*/state.vscdb`

Out of scope for v1:

- Background-agent chats. Cursor stores those remotely rather than in the local transcript tree this tool ingests, so they are not part of the supported source surface yet.

## Runtime Layout

The CLI writes a local runtime under `~/.agent-session-distillery` or the path set in `AGENT_SESSION_DISTILLERY_ROOT`.

Important directories:

- `ledger/` — SQLite lifecycle state and operational history
- `staging/<session-id>/` — parsed and reduced intermediates
- `summaries/by-session/<session-id>/` — `summary.json` and `summary.md`
- `knowledge/projects/<project-key>/` — project learning JSONL
- `knowledge/user/operator/` — user learning JSONL
- `sources/manifests/` — immutable provenance manifests
- `reviews/` — review queue runtime path
- `archives/` — archive runtime path
- `deletes/receipts/` — per-session retention receipts
- `deletes/tombstones/` — explicit deletion apply tombstones
- `reports/` — retention readiness reports

## Command Examples

Initial backfill of all local Cursor transcripts:

```bash
node dist/cli.js ingest backfill --source cursor
```

Initial backfill with a cutoff date and session cap:

```bash
node dist/cli.js ingest backfill --source cursor --since 2026-05-01T00:00:00Z --limit 100
```

Twice-daily incremental sync:

```bash
node dist/cli.js ingest sync --source cursor --resume
```

Review queue triage:

```bash
node dist/cli.js review queue
node dist/cli.js review show <session-id>
node dist/cli.js explain <session-id>
```

Archive run for sessions currently sitting in the extracted phase:

```bash
node dist/cli.js archive run
```

Inspect deletion readiness:

```bash
node dist/cli.js delete candidates
node dist/cli.js delete apply
```

Explicit deletion apply:

```bash
node dist/cli.js delete apply --apply
```

High-level runtime stats:

```bash
node dist/cli.js stats
```

## Retention Model

The current lifecycle is:

1. `discovered`
2. `parsed`
3. `reduced`
4. `summarized`
5. `extracted`
6. `archived`
7. `deletion_candidate`
8. `deleted`

`ingest backfill` and `ingest sync` drive a discovered session through parse, reduce, summarize, extract, and archive. During summarization the tool creates a pending review entry. During archive it writes the immutable manifest, retention receipt, and batch report, then updates deletion-candidate state.

A session is only marked safe to delete when all of the following exist:

- `summary.json`
- `summary.md`
- at least one knowledge artifact: project learnings or user learnings
- the immutable provenance manifest
- the retention receipt

If any of those artifacts are missing, the session remains blocked with a concrete reason in the retention receipt and deletion-candidate record. `delete apply` is a dry run by default; only `delete apply --apply` records an applied deletion tombstone and advances the lifecycle to `deleted`.

## Troubleshooting

### Missing transcript paths

If `ingest backfill --source cursor` finds nothing, verify that Cursor has written local transcript files under:

- `~/.cursor/projects/*/agent-transcripts/*.jsonl`
- `~/.cursor/projects/*/agent-transcripts/*.txt`

This tool ignores non-transcript files and cannot ingest remote-only chat state.

### Workspace rename drift

Project attribution comes from the workspace slug plus any local workspace hint files. If a workspace was renamed or moved after Cursor created the slug, the tool may fall back to the slug-derived project key when the old path no longer exists. Check the hint files in the project directory, especially `workspace.json`, and confirm they point at a live absolute path.

### Parser-version invalidation

`--resume` reuses completed phase artifacts only when the stored `source_hash` still matches the current transcript. If parsing behavior changes or the transcript contents change, rerun without `--resume` so parsed and reduced artifacts are regenerated from the current source. If you use an isolated runtime root for testing parser changes, point `AGENT_SESSION_DISTILLERY_ROOT` at a fresh directory.
