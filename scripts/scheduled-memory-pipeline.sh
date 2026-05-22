#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI=(node "$ROOT/dist/cli.js")
ADAPTERS=(cursor claude-code codex-cli pi)

if [[ ! -f "$ROOT/dist/cli.js" ]]; then
  echo "missing dist/cli.js — run npm run build in $ROOT" >&2
  exit 1
fi

for adapter in "${ADAPTERS[@]}"; do
  echo "[asd] ingest sync --source $adapter"
  "${CLI[@]}" ingest sync --resume --source "$adapter"
done

echo "[asd] quality audit"
"${CLI[@]}" quality audit --limit 100

REVIEW_INPUT="${AGENT_SESSION_DISTILLERY_ROOT:-$HOME/.agent-session-distillery}/reports/llm-learning-review.jsonl"
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
  echo "[asd] quality review-learnings"
  "${CLI[@]}" quality review-learnings
elif [[ -f "$REVIEW_INPUT" ]]; then
  echo "[asd] skipping review-learnings (no OPENROUTER_API_KEY; sidecar present)"
else
  echo "[asd] skipping review-learnings (no OPENROUTER_API_KEY; no sidecar)"
fi

echo "[asd] quality apply-learning-review"
"${CLI[@]}" quality apply-learning-review

echo "[asd] memory export-wiki"
"${CLI[@]}" memory export-wiki

echo "[asd] memory push-wiki"
"${CLI[@]}" memory push-wiki

echo "[asd] pipeline complete"
