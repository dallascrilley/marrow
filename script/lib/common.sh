#!/usr/bin/env bash
#
# common.sh — sourced by every script/* entrypoint.
#
# Resolves the repo root, loads the language profile (script/lib/profile.sh),
# and guarantees every run_* command exists so the agnostic core stays runnable
# even before a profile is filled in.
#
# This file is UNIVERSAL — identical in every project. Language specifics live
# only in script/lib/profile.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarn:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# Load the language profile if present.
if [ -f "$ROOT/script/lib/profile.sh" ]; then
  # shellcheck source=/dev/null
  . "$ROOT/script/lib/profile.sh"
fi

# Default every command to a clear, falsifiable TODO so an unconfigured core
# fails loudly instead of silently doing nothing.
for _fn in run_bootstrap run_setup run_update run_server run_test run_cibuild run_console; do
  if ! declare -F "$_fn" >/dev/null 2>&1; then
    eval "${_fn}() { die \"${_fn} is not configured — edit script/lib/profile.sh\"; }"
  fi
done
unset _fn
