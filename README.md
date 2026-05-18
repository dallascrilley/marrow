# agent-session-distillery

Standalone CLI for ingesting local Cursor agent transcripts into a durable runtime with summaries, learnings, manifests, review state, and deletion receipts.

Launch proof: [`docs/launch-proof-index.md`](docs/launch-proof-index.md)

## Requirements

- Node `22.x`
- npm
- Local Cursor transcript files on disk
- Optional: `OPENROUTER_API_KEY` for LLM-gated project-learning review commands
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
- `knowledge/projects/<project-key>/` — deterministic project-learning candidate JSONL
- `knowledge/projects-reviewed/<project-key>/` — LLM-reviewed project learnings applied as a non-mutating sidecar
- `knowledge/user/operator/` — user learning JSONL
- `sources/manifests/` — immutable provenance manifests
- `reviews/` — review queue runtime path
- `archives/` — archive runtime path
- `deletes/receipts/` — per-session retention receipts
- `deletes/tombstones/` — explicit deletion apply tombstones
- `reports/` — retention, audit, and LLM learning-review reports
## Real Regression Fixtures

The repo also carries a small real-session regression corpus under
`test/fixtures/cursor/live-regression/`. These fixtures are copied from actual
local Cursor transcript files so parser and summary regressions can be judged
against production-shaped data instead of synthetic-only fixtures.

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

`delete candidates` includes the raw ledger candidates plus an operator-facing
`decisions` array with ready/blocked status, required artifact presence, missing
required artifacts, manifest and retention receipt paths, and the next action for
each session.

Explicit deletion apply:

```bash
node dist/cli.js delete apply --apply
```

High-level runtime stats:

```bash
node dist/cli.js stats
```

Audit summary and deletion-readiness quality across already-ingested sessions:

```bash
node dist/cli.js quality audit
node dist/cli.js quality audit --limit 100
```

The audit reports deletion-readiness counts, blocked reasons, issue counts,
recommendations, deterministic project-learning distribution metrics, knowledge
artifact presence, and the worst sessions by deterministic output-quality checks.

Review deterministic project learnings with an OpenRouter memory-lint sidecar:

```bash
OPENROUTER_API_KEY=... node dist/cli.js quality review-learnings --model openai/gpt-5-nano
OPENROUTER_API_KEY=... node dist/cli.js quality review-learnings --limit 25 --max-total-learnings 100
OPENROUTER_API_KEY=... node dist/cli.js quality review-learnings --cache-dir /tmp/asd-review-cache
OPENROUTER_API_KEY=... node dist/cli.js quality review-learnings --refresh-llm
```

This writes `reports/llm-learning-review.jsonl`. LLM reviews are cached by exact learning/model/prompt/validator input under `cache/llm-learning-review/` by default; pass `--refresh-llm` to overwrite cached entries or `--no-cache` to bypass cache reads and writes. Individual session failures are recorded as rejected review entries so a batch can continue.

Apply the LLM review into a separate reviewed namespace:

```bash
node dist/cli.js quality apply-learning-review
```

This writes `knowledge/projects-reviewed/` and `reports/llm-learning-review-apply.json` without mutating `knowledge/projects/`. The apply step keeps only durable keep/rewrite verdicts that pass strict post-validation.

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
