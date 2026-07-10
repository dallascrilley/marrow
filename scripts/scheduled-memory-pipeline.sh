#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI=(node "$ROOT/dist/cli.js")
ADAPTERS=(cursor claude-code codex-cli pi kimi)

if [[ ! -f "$ROOT/dist/cli.js" ]]; then
  echo "missing dist/cli.js — run npm run build in $ROOT" >&2
  exit 1
fi

for adapter in "${ADAPTERS[@]}"; do
  echo "[asd] ingest sync --source $adapter"
  "${CLI[@]}" ingest sync --resume --source "$adapter"
done

echo "[asd] check (session integrity; fails fast before audit/LLM steps)"
"${CLI[@]}" check

echo "[asd] pipeline gate (--skip-ingest; ingest already ran above)"
"${CLI[@]}" pipeline gate --skip-ingest --max-per "${ASD_LLM_MAX_PER:-5/24h}"

echo "[asd] quality audit"
"${CLI[@]}" quality audit --limit 100

if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
  echo "[asd] quality review-learnings (--if-new --max-per ${ASD_LLM_MAX_PER:-5/24h})"
  REVIEW_OUTPUT="$("${CLI[@]}" quality review-learnings --if-new --max-per "${ASD_LLM_MAX_PER:-5/24h}")"
  printf '%s\n' "$REVIEW_OUTPUT"
  BATCH_PATH="$(node -e '
const fs = require("node:fs");
const payload = JSON.parse(fs.readFileSync(0, "utf8"));
if (payload.generated_batch === true && typeof payload.batch_path === "string") {
  process.stdout.write(payload.batch_path);
}
' <<<"$REVIEW_OUTPUT")"
  if [[ -n "$BATCH_PATH" ]]; then
    echo "[asd] quality apply-learning-review --batch '$BATCH_PATH'"
    "${CLI[@]}" quality apply-learning-review --batch "$BATCH_PATH"
  else
    echo "[asd] no batch generated; skipping apply-learning-review"
  fi
else
  echo "[asd] skipping review-learnings and apply-learning-review (no OPENROUTER_API_KEY)"
fi

echo "[asd] memory export-wiki"
"${CLI[@]}" memory export-wiki

echo "[asd] memory push-wiki"
"${CLI[@]}" memory push-wiki

echo "[asd] pipeline complete"
