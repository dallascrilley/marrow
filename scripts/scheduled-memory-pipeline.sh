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
  echo "[marrow] ingest sync --source $adapter"
  "${CLI[@]}" ingest sync --resume --source "$adapter"
done

echo "[marrow] check (session integrity; fails fast before audit/LLM steps)"
"${CLI[@]}" check

echo "[marrow] pipeline gate (--skip-ingest; ingest already ran above)"
"${CLI[@]}" pipeline gate --skip-ingest --max-per "${ASD_LLM_MAX_PER:-5/24h}"

PARSED_RETENTION_AGE_DAYS="${ASD_PARSED_RETENTION_OLDER_THAN_DAYS:-30}"
PARSED_MAX_TOTAL_BYTES="${ASD_PARSED_MAX_TOTAL_BYTES:-1073741824}"
echo "[marrow] storage cleanup-parsed --apply --older-than-days ${PARSED_RETENTION_AGE_DAYS} --max-total-bytes ${PARSED_MAX_TOTAL_BYTES}"
PARSED_RETENTION="$("${CLI[@]}" storage cleanup-parsed --apply --older-than-days "$PARSED_RETENTION_AGE_DAYS" --max-total-bytes "$PARSED_MAX_TOTAL_BYTES")"
printf '%s\n' "$PARSED_RETENTION"

echo "[marrow] quality audit"
"${CLI[@]}" quality audit --limit 100

if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
  echo "[marrow] quality review-learnings (--if-new --max-per ${ASD_LLM_MAX_PER:-5/24h})"
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
    echo "[marrow] quality apply-learning-review --batch '$BATCH_PATH'"
    "${CLI[@]}" quality apply-learning-review --batch "$BATCH_PATH"
  else
    echo "[marrow] no batch generated; skipping apply-learning-review"
  fi
else
  echo "[marrow] skipping review-learnings and apply-learning-review (no OPENROUTER_API_KEY)"
fi

echo "[marrow] memory export-wiki"
"${CLI[@]}" memory export-wiki

echo "[marrow] memory push-wiki"

"${CLI[@]}" memory push-wiki

if [[ "${ASD_ENABLE_COMPACTION:-0}" == "1" ]]; then
  COMPACTION_AGE_DAYS="${ASD_COMPACTION_OLDER_THAN_DAYS:-30}"
  if [[ -z "${BATCH_PATH:-}" ]]; then
    echo "[marrow] skipping report compaction (review did not generate and apply a new batch)"
  else
    echo "[marrow] storage retain-reports --apply --older-than-days ${COMPACTION_AGE_DAYS}"
    REPORT_COMPACTION="$("${CLI[@]}" storage retain-reports --apply --older-than-days "$COMPACTION_AGE_DAYS")"
    printf '%s\n' "$REPORT_COMPACTION"
  fi
fi

echo "[marrow] pipeline complete"
