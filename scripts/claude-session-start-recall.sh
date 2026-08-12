#!/usr/bin/env bash
# Claude Code SessionStart hook — inject the current project's curated marrow memory.
# Fail open: never block session start on recall errors; print nothing on failure.
set -euo pipefail

# SessionStart delivers JSON on stdin; drain it so the hook protocol completes.
if ! [ -t 0 ]; then
  cat >/dev/null || true
fi

project_dir="${CLAUDE_PROJECT_DIR:-$PWD}"

emit_recall() {
  if command -v marrow >/dev/null 2>&1; then
    marrow recall --cwd "$project_dir" 2>/dev/null || true
    return 0
  fi

  if [[ -f "${project_dir}/dist/cli.js" ]]; then
    node "${project_dir}/dist/cli.js" recall --cwd "$project_dir" 2>/dev/null || true
  fi
}

emit_recall
exit 0
