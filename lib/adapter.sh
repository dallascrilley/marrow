#!/usr/bin/env bash

if [[ -n "${BASH_SOURCE[0]+x}" ]]; then
  adapter_root_source="${BASH_SOURCE[0]}"
elif [[ -n "${ZSH_VERSION:-}" ]]; then
  adapter_root_source="${(%):-%x}"
else
  adapter_root_source="$0"
fi
while [[ -L "$adapter_root_source" ]]; do
  adapter_root_target="$(readlink "$adapter_root_source")"
  if [[ "$adapter_root_target" == /* ]]; then adapter_root_source="$adapter_root_target"; else adapter_root_source="$(dirname "$adapter_root_source")/$adapter_root_target"; fi
done
adapter_lib_root="$(CDPATH='' cd -P -- "$(dirname "$adapter_root_source")" && pwd)"
# shellcheck disable=SC1091
source "$adapter_lib_root/runtime-trust.sh"

adapter_sha256() { integrity_sha256 "$1"; }

adapter_stat() { integrity_stat "$1"; }

adapter_read_pin() {
  local pin_file="$ADAPTER_ROOT/organization/harness-release.json"
  [[ -f "$pin_file" ]] || { ADAPTER_FAILURE=missing; return 6; }
  local jq_bin paths_json filter
  jq_bin="$(integrity_resolve_tool jq)" || { ADAPTER_FAILURE=missing; return 6; }
  paths_json="$(printf '%s\n' "${RUNTIME_TRUST_PATHS[@]}" | "$jq_bin" -R . | "$jq_bin" -s .)"
  filter="$(runtime_trust_pin_jq_filter)"
  "$jq_bin" -e --arg runtimePathPattern "$runtime_trust_path_pattern" --argjson runtimePaths "$paths_json" "$filter" "$pin_file" >/dev/null 2>&1 || { ADAPTER_FAILURE=unverified; return 4; }
  IFS=$'\t' read -r ADAPTER_VERSION ADAPTER_CONTRACT ADAPTER_INSTALL_ROOT < <(
    "$jq_bin" -er '[.releaseVersion,.contractVersion,.installRoot] | @tsv' "$pin_file"
  ) || { ADAPTER_FAILURE=unverified; return 4; }
  ADAPTER_FILES_JSON="$("$jq_bin" -c '.files' "$pin_file")"
  ADAPTER_JQ_BIN="$jq_bin"
  ADAPTER_INSTALL_ROOT="${WORKSPACE_HARNESS_INSTALL_ROOT:-$ADAPTER_INSTALL_ROOT}"
}

adapter_resolve() {
  local candidate physical expected expected_uid uid mode version_output current path relative expected_mode expected_digest release_file
  ADAPTER_FAILURE=missing
  integrity_require_tools jq shasum || { ADAPTER_FAILURE=missing; return 6; }
  adapter_read_pin || return $?
  if [[ -n "${WORKSPACE_HARNESS_COMMAND:-}" ]]; then
    candidate="$WORKSPACE_HARNESS_COMMAND"
  else
    candidate="$ADAPTER_INSTALL_ROOT/current/bin/workspace-harness"
    [[ -x "$candidate" && ! -L "$candidate" ]] || candidate=""
    if [[ -z "$candidate" ]]; then
      local bin_dir="${WORKSPACE_HARNESS_BIN_DIR:-}"
      if [[ -n "$bin_dir" && -L "$bin_dir/workspace-harness" ]]; then
        candidate="$(readlink "$bin_dir/workspace-harness")"
      fi
    fi
  fi
  [[ -n "$candidate" && -x "$candidate" && ! -L "$ADAPTER_INSTALL_ROOT" ]] || { ADAPTER_FAILURE=missing; return 6; }
  physical="$(integrity_realpath "$candidate" 2>/dev/null || true)"
  expected="$ADAPTER_INSTALL_ROOT/releases/$ADAPTER_VERSION/bin/workspace-harness"
  expected_uid="$(id -u)"
  [[ "$physical" == "$expected" && -f "$physical" && ! -L "$physical" ]] || { ADAPTER_FAILURE=unverified; return 4; }
  for path in "$ADAPTER_INSTALL_ROOT" "$ADAPTER_INSTALL_ROOT/releases" "$ADAPTER_INSTALL_ROOT/releases/$ADAPTER_VERSION" \
    "$ADAPTER_INSTALL_ROOT/releases/$ADAPTER_VERSION/bin" "$ADAPTER_INSTALL_ROOT/releases/$ADAPTER_VERSION/lib" \
    "$ADAPTER_INSTALL_ROOT/releases/$ADAPTER_VERSION/schemas"; do
    [[ -d "$path" && ! -L "$path" ]] || { ADAPTER_FAILURE=unverified; return 4; }
    read -r uid mode < <(adapter_stat "$path")
    [[ "$uid" == "$expected_uid" && $((8#$mode & 8#022)) == 0 ]] || { ADAPTER_FAILURE=unverified; return 4; }
  done
  [[ -L "$ADAPTER_INSTALL_ROOT/current" ]] || { ADAPTER_FAILURE=unverified; return 4; }
  current="$(integrity_realpath "$ADAPTER_INSTALL_ROOT/current" 2>/dev/null || true)"
  [[ "$current" == "$ADAPTER_INSTALL_ROOT/releases/$ADAPTER_VERSION" ]] || { ADAPTER_FAILURE=incompatible; return 4; }
  while IFS=$'\t' read -r relative expected_mode expected_digest; do
    release_file="$ADAPTER_INSTALL_ROOT/releases/$ADAPTER_VERSION/$relative"
    [[ -f "$release_file" && ! -L "$release_file" && "$(integrity_realpath "$release_file" 2>/dev/null || true)" == "$release_file" ]] || { ADAPTER_FAILURE=unverified; return 4; }
    read -r uid mode < <(adapter_stat "$release_file")
    [[ "$uid" == "$expected_uid" && "$mode" == "${expected_mode#0}" ]] || { ADAPTER_FAILURE=unverified; return 4; }
    [[ "$(adapter_sha256 "$release_file")" == "$expected_digest" ]] || { ADAPTER_FAILURE=unverified; return 4; }
  done < <("$ADAPTER_JQ_BIN" -r '.[] | [.path,.mode,.sha256] | @tsv' <<<"$ADAPTER_FILES_JSON")
  version_output="$($physical --version 2>/dev/null || true)"
  [[ "$version_output" == "workspace-harness $ADAPTER_VERSION contract=$ADAPTER_CONTRACT previous=$((ADAPTER_CONTRACT - 1))" ]] || {
    ADAPTER_FAILURE=incompatible
    return 4
  }
  HARNESS_EXEC="$physical"
  export HARNESS_EXEC
}

adapter_repair_guidance() {
  case "${ADAPTER_FAILURE:-missing}" in
    missing) printf 'Verified workspace-harness release is missing.\n' ;;
    *) printf 'Installed workspace-harness release is incompatible or unverified.\n' ;;
  esac
  printf 'Repair: install the pinned release from a verified manifest, or roll back to that release.\n'
}
