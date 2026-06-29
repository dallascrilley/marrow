#!/usr/bin/env bash
# Launcher for asd's MCP query server (`asd mcp serve`).
#
# Why this exists instead of `{ "command": "node", "args": ["dist/cli.js", ...] }`:
# GUI/IDE-launched MCP clients (Claude Code desktop app, IDE extensions) spawn
# servers with a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin) that does NOT
# include a mise/nvm-managed node. `/bin/bash` IS always on that PATH, so the
# committed .mcp.json points `command` at bash + this script, which resolves a
# usable node at spawn time. Portable (relative invocation, no machine-specific
# absolute paths in version control) AND robust (works headless or GUI-launched).
set -euo pipefail

# Resolve the repo's built CLI relative to THIS script, not the caller's cwd —
# so the server starts correctly regardless of where the client spawns it.
script_dir="$(cd "$(dirname "$0")" && pwd)"
cli_path="${script_dir}/../dist/cli.js"

resolve_node() {
  # 1) node already on PATH (terminal/CLI launches in a mise-activated shell).
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  # 2) mise shim — present in GUI minimal-PATH spawns, stable across node bumps.
  if [[ -x "${HOME}/.local/share/mise/shims/node" ]]; then
    printf '%s\n' "${HOME}/.local/share/mise/shims/node"
    return 0
  fi
  # 3) Last resort: newest mise-installed node binary.
  local candidate
  candidate="$(ls -1 "${HOME}"/.local/share/mise/installs/node/*/bin/node 2>/dev/null | sort -V | tail -1)"
  if [[ -n "${candidate}" && -x "${candidate}" ]]; then
    printf '%s\n' "${candidate}"
    return 0
  fi
  return 1
}

node_bin="$(resolve_node)" || {
  echo "asd mcp-serve: could not locate a node binary (PATH, mise shim, or mise install)" >&2
  exit 1
}

exec "${node_bin}" "${cli_path}" mcp serve
