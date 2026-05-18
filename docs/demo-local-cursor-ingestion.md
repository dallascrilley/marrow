# 5-Minute Demo: Local Cursor Transcript Ingestion

This demo starts from a clean sandbox, ingests the bundled Cursor fixture,
inspects review and retention state, then runs the memory export dry run.

Prerequisites:

- Node 22
- `npm install`
- `npm run build`

## Run

```bash
export ASD_DEMO=/tmp/asd-local-cursor-demo
export ASD_NODE="${ASD_NODE:-node}"
export ASD_ORIGINAL_HOME="$HOME"
export HOME="$ASD_DEMO/home"
export AGENT_SESSION_DISTILLERY_ROOT="$ASD_DEMO/runtime"

rm -rf "$ASD_DEMO"
mkdir -p "$HOME/.cursor/projects/agent-session-distillery/agent-transcripts"
cp test/fixtures/cursor/transcripts/session-e2e.jsonl \
  "$HOME/.cursor/projects/agent-session-distillery/agent-transcripts/session-e2e.jsonl"

"$ASD_NODE" dist/cli.js ingest backfill --source cursor
"$ASD_NODE" dist/cli.js review queue
"$ASD_NODE" dist/cli.js review show session-e2e
"$ASD_NODE" dist/cli.js explain session-e2e
"$ASD_NODE" dist/cli.js delete candidates
"$ASD_NODE" scripts/memory-pipeline-dry-run.mjs --root "$AGENT_SESSION_DISTILLERY_ROOT" --limit 100
```

## Expected Outputs

- `ingest backfill` reports `discovered_count: 1`, `processed_count: 1`, and
  `session_id: session-e2e`.
- `review queue` includes the completed summary review entry.
- `review show session-e2e` shows the generated review payload.
- `explain session-e2e` includes the source session, phase checkpoints, run
  history, review queue state, deletion candidate, and summary preview.
- `delete candidates` includes a raw `candidates` array and a `decisions` array.
  The fixture should be `ready`, with no missing required artifacts.
- `memory:pipeline:dry-run` prints JSON with `success: true`, audit and export
  steps, and `export_path`.

## Generated Paths

With the variables above, useful artifacts land under:

- `$AGENT_SESSION_DISTILLERY_ROOT/summaries/by-session/session-e2e/summary.md`
- `$AGENT_SESSION_DISTILLERY_ROOT/knowledge/projects/agent-session-distillery/session-e2e.jsonl`
- `$AGENT_SESSION_DISTILLERY_ROOT/sources/manifests/session-e2e.json`
- `$AGENT_SESSION_DISTILLERY_ROOT/deletes/receipts/session-e2e.json`
- `$AGENT_SESSION_DISTILLERY_ROOT/exports/wiki-memory/reviewed-memory.jsonl`

## Cleanup

```bash
rm -rf "$ASD_DEMO"
export HOME="$ASD_ORIGINAL_HOME"
unset ASD_DEMO ASD_NODE ASD_ORIGINAL_HOME AGENT_SESSION_DISTILLERY_ROOT
```

If your shell resolves `node` through a version-manager shim that does not work
with a fake `HOME`, set `ASD_NODE` to the absolute Node binary path before
running the demo.

## Current Proof

The broader launch proof index is in
[`docs/launch-proof-index.md`](launch-proof-index.md). It includes first-run,
retention, quality audit, reviewed-memory export, and CI evidence from the
current launch proof pass.
