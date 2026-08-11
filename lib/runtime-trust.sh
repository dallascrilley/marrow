#!/usr/bin/env bash

# Canonical runtime file inventory and integrity-tool resolution shared by the
# installer and consumer adapter. Resolution never trusts PATH shims.

readonly RUNTIME_TRUST_FILE_COUNT=6
readonly -a RUNTIME_TRUST_PATHS=(
  bin/workspace-harness
  lib/contract.sh
  lib/ledger.sh
  lib/receipts.sh
  schemas/command-result.schema.json
  schemas/project-contract.schema.json
)

integrity_search_dirs() {
  if [[ -n "${INTEGRITY_TOOL_SEARCH_OVERRIDE:-}" ]]; then
    printf '%s\n' "$INTEGRITY_TOOL_SEARCH_OVERRIDE"
    return 0
  fi
  printf '%s\n' /usr/bin /bin /usr/sbin /sbin
  [[ -d /opt/homebrew/bin ]] && printf '%s\n' /opt/homebrew/bin
  [[ -d /opt/local/bin ]] && printf '%s\n' /opt/local/bin
}

integrity_trusted_dir() {
  local dir="$1"
  case "$dir" in
    /usr/bin|/bin|/usr/sbin|/sbin|/opt/homebrew/bin|/opt/local/bin) return 0 ;;
  esac
  return 1
}

integrity_tool_cache_var() {
  printf 'INTEGRITY_TOOL_%s' "$(printf '%s' "$1" | tr -c 'A-Za-z0-9_' '_')"
}

integrity_tool_cache_get() {
  local cache_var="$1" cached
  eval "cached=\${$cache_var-}"
  [[ -n "$cached" ]]
}

integrity_tool_cache_set() {
  local cache_var="$1" value="$2"
  eval "$cache_var=\$value"
}

integrity_resolve_tool() {
  local name="$1" cache_var dir candidate resolved resolved_dir cached
  cache_var="$(integrity_tool_cache_var "$name")"
  if integrity_tool_cache_get "$cache_var"; then
    eval "printf '%s\\n' \"\${$cache_var}\""
    return 0
  fi
  while IFS= read -r dir; do
    [[ -n "$dir" ]] || continue
    candidate="$dir/$name"
    [[ -e "$candidate" ]] || continue
    resolved_dir="$(CDPATH='' cd -P -- "$(dirname "$candidate")" 2>/dev/null && pwd -P)" || continue
    resolved="$resolved_dir/$(basename "$candidate")"
    [[ -x "$resolved" ]] || continue
    integrity_trusted_dir "$resolved_dir" || continue
    integrity_tool_cache_set "$cache_var" "$resolved"
    printf '%s\n' "$resolved"
    return 0
  done < <(integrity_search_dirs)
  return 1
}

integrity_require_tools() {
  local tool
  for tool in "$@"; do
    integrity_resolve_tool "$tool" >/dev/null || return 1
  done
}

integrity_sha256() {
  local file="$1" shasum
  shasum="$(integrity_resolve_tool shasum)" || return 1
  "$shasum" -a 256 "$file" | awk '{print $1}'
}

integrity_stat() {
  local file="$1" stat_bin output
  stat_bin="$(integrity_resolve_tool stat)" || return 1
  if output="$("$stat_bin" -f '%u %Lp' "$file" 2>/dev/null)"; then
    printf '%s\n' "$output"
  else
    "$stat_bin" -c '%u %a' "$file"
  fi
}

integrity_realpath_fallback() {
  local path="$1" target
  [[ -e "$path" || -L "$path" ]] || return 1
  while [[ -L "$path" ]]; do
    target="$(readlink "$path")"
    if [[ "$target" == /* ]]; then
      path="$target"
    else
      path="$(dirname "$path")/$target"
    fi
  done
  if [[ -d "$path" ]]; then
    CDPATH='' cd -P -- "$path" && pwd -P
  else
    printf '%s/%s\n' "$(CDPATH='' cd -P -- "$(dirname "$path")" && pwd -P)" "$(basename "$path")"
  fi
}

integrity_realpath() {
  local path="$1" realpath_bin
  if realpath_bin="$(integrity_resolve_tool realpath 2>/dev/null)"; then
    "$realpath_bin" "$path"
    return $?
  fi
  integrity_realpath_fallback "$path"
}

integrity_mode_is_writable() {
  local mode="$1"
  (( (8#$mode & 8#022) != 0 ))
}

runtime_trust_path_pattern='^(bin|lib|schemas)/[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$'

runtime_trust_path_valid() {
  local path="$1" part
  [[ "$path" =~ $runtime_trust_path_pattern ]] || return 1
  [[ "$path" != *'..'* ]] || return 1
  IFS='/' read -r -a parts <<<"$path"
  for part in "${parts[@]}"; do
    [[ -n "$part" && "$part" != '.' && "$part" != '..' ]] || return 1
  done
}

runtime_trust_mode_for_path() {
  local path="$1"
  [[ "$path" == bin/workspace-harness ]] && printf '0755\n' || printf '0644\n'
}

runtime_trust_manifest_jq_filter() {
  cat <<'JQ'
    . as $manifest |
    type == "object" and
    (keys | sort) == (["archive","contractVersions","entrypoint","files","releaseVersion","schemaVersion"] | sort) and
    .schemaVersion == 1 and
    (.releaseVersion | type == "string" and test("^[0-9]+\\.[0-9]+\\.[0-9]+$")) and
    (.contractVersions | type == "array" and length == 2 and (unique | length) == 2) and
    (.contractVersions | all(.[]; type == "number")) and
    .entrypoint == "bin/workspace-harness" and
    (.archive | type == "object" and (keys | sort) == (["file","sha256"] | sort) and
      .file == ("workspace-harness-" + $manifest.releaseVersion + ".tar") and
      (.sha256 | type == "string" and test("^[0-9a-f]{64}$"))) and
    (.files | type == "array" and length == 6 and
      (map(.path) | unique | length) == 6 and
      (map(.path) | sort) == $runtimePaths and
      all(.[];
        type == "object" and (keys | sort) == (["mode","path","sha256"] | sort) and
        (.path | type == "string" and test($runtimePathPattern) and (contains("..") | not) and
          (split("/") | all(. != "" and . != "." and . != ".."))) and
        .mode == (if .path == "bin/workspace-harness" then "0755" else "0644" end) and
        (.sha256 | type == "string" and test("^[0-9a-f]{64}$"))))
JQ
}

runtime_trust_pin_jq_filter() {
  cat <<'JQ'
    type == "object" and
    (keys | sort) == (["contractVersion","files","installRoot","releaseVersion","schemaVersion"] | sort) and
    .schemaVersion == 1 and
    (.releaseVersion | type == "string" and test("^[0-9]+\\.[0-9]+\\.[0-9]+$")) and
    (.contractVersion | type == "number" and . >= 2) and
    (.installRoot | type == "string" and startswith("/")) and
    (.files | type == "array" and length == 6) and
    ([.files[].path] | sort) == $runtimePaths and
    (all(.files[];
      type == "object" and (keys | sort) == (["mode","path","sha256"] | sort) and
      (.path | type == "string" and test($runtimePathPattern) and (contains("..") | not) and
        (split("/") | all(. != "" and . != "." and . != ".."))) and
      (.mode == "0755" or .mode == "0644") and
      (.sha256 | type == "string" and test("^[0-9a-f]{64}$"))))
JQ
}

integrity_reject_symlink_components() {
  local path="$1" current='' part
  [[ "$path" == /* ]] || return 1
  IFS='/' read -r -a parts <<<"${path#/}"
  for part in "${parts[@]}"; do
    [[ -n "$part" ]] || continue
    current="$current/$part"
    [[ ! -L "$current" ]] || return 1
  done
}

integrity_atomic_link() {
  local target="$1" link="${2:-}" temporary rm_bin ln_bin mv_bin
  [[ -n "$target" && -n "$link" ]] || return 1
  rm_bin="$(integrity_resolve_tool rm)" || return 1
  ln_bin="$(integrity_resolve_tool ln)" || return 1
  mv_bin="$(integrity_resolve_tool mv)" || return 1
  temporary="${link}.new.$$"
  "$rm_bin" -f -- "$temporary"
  "$ln_bin" -s "$target" "$temporary"
  "$rm_bin" -f -- "$link"
  "$mv_bin" -f -- "$temporary" "$link"
}
