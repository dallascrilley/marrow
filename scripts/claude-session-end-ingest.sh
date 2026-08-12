#!/usr/bin/env bash
# Claude Code SessionEnd hook — run marrow ingest sync for the closing session's harness.
# Fail open: never block session termination on ingest errors.
set -euo pipefail

# SessionEnd delivers JSON on stdin; drain it so the hook protocol completes.
if ! [ -t 0 ]; then
  cat >/dev/null || true
fi

run_ingest() {
  local source="$1"
  if command -v marrow >/dev/null 2>&1; then
    marrow ingest sync --resume --source "$source" >/dev/null 2>&1 || true
    return 0
  fi

  if [[ -n "${CLAUDE_PROJECT_DIR:-}" && -f "${CLAUDE_PROJECT_DIR}/dist/cli.js" ]]; then
    node "${CLAUDE_PROJECT_DIR}/dist/cli.js" ingest sync --resume --source "$source" >/dev/null 2>&1 || true
  fi
}

run_ingest claude-code
exit 0
