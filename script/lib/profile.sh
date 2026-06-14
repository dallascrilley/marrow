#!/usr/bin/env bash
#
# Language profile: Node.js / TypeScript (npm).
# Sourced by script/lib/common.sh. Define each run_* command here; the universal
# script/* entrypoints call them. This is the ONLY file that varies by language.
#
# This repo uses npm (see README and package-lock.json). Lockfile is law — do not
# switch package managers as a side effect of bootstrap.

run_bootstrap() {
  command -v node >/dev/null 2>&1 || die "node not found — need Node 22.x (see README)"
  local major
  major="$(node -p "process.versions.node.split('.')[0]")"
  [[ "$major" == "22" ]] || die "Node 22.x required (package.json engines); got $(node -v)"
}

run_setup()  { run_bootstrap; npm install; }
run_update() { npm install; }

run_server() {
  if [[ -f dist/cli.js ]]; then
    node dist/cli.js --help
  else
    die "No built CLI — run script/setup && npm run build first"
  fi
}

run_test()   { npm test "$@"; }

run_cibuild() {
  npm ci
  npm run lint
  npm test
  npm run build
}

run_console() { node; }
