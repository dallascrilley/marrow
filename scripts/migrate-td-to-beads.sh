#!/usr/bin/env bash
# migrate-td-to-beads.sh — one-way import of td issues into beads (idempotent).
# Usage:
#   ./migrate-td-to-beads.sh --dry-run
#   ./migrate-td-to-beads.sh
#   ./migrate-td-to-beads.sh --snapshot path/to/td-export.json
#   ./migrate-td-to-beads.sh --include-closed
#
# Requires: bd, jq, td (only if snapshot not provided)
# Writes: .agents-state/tracker-migration/id-map.json
#         .agents-state/tracker-migration/td-export-*.json (if exporting)
set -euo pipefail

DRY_RUN=0
INCLUDE_CLOSED=0
SNAPSHOT=""
OUT_DIR=".agents-state/tracker-migration"
ID_MAP="${OUT_DIR}/id-map.json"

usage() {
  sed -n '2,12p' "$0" | sed 's/^# //' | sed 's/^#//'
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --include-closed) INCLUDE_CLOSED=1; shift ;;
    --snapshot) SNAPSHOT="${2:-}"; shift 2 ;;
    -h|--help) usage 0 ;;
    *) echo "Unknown arg: $1" >&2; usage 1 ;;
  esac
done

command -v bd >/dev/null || { echo "bd not on PATH" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq not on PATH" >&2; exit 1; }

mkdir -p "$OUT_DIR"

if [[ -z "$SNAPSHOT" ]]; then
  command -v td >/dev/null || { echo "td not on PATH (or pass --snapshot)" >&2; exit 1; }
  STAMP=$(date -u +%Y%m%dT%H%M%SZ)
  SNAPSHOT="${OUT_DIR}/td-export-${STAMP}.json"
  echo "Exporting td → ${SNAPSHOT}"
  td ls --json >"$SNAPSHOT"
fi

[[ -f "$SNAPSHOT" ]] || { echo "snapshot missing: $SNAPSHOT" >&2; exit 1; }

if [[ ! -f "$ID_MAP" ]]; then
  echo '{}' >"$ID_MAP"
fi

STAMP=$(date -u +%Y%m%dT%H%M%SZ)

# Build set of already-migrated td ids from map + beads labels
mapfile -t EXISTING_LEGACY < <(
  {
    jq -r 'keys[]' "$ID_MAP" 2>/dev/null || true
    bd list --json 2>/dev/null | jq -r '
      .[]?
      | (.labels // [])
      | .[]?
      | if type == "string" then .
        elif type == "object" then (.name // .label // empty)
        else empty end
      | select(startswith("legacy:td-") or startswith("legacy:"))
      | sub("^legacy:"; "")
    ' || true
  } | sort -u
)

is_migrated() {
  local tid="$1"
  local x
  for x in "${EXISTING_LEGACY[@]:-}"; do
    [[ "$x" == "$tid" ]] && return 0
  done
  return 1
}

map_priority() {
  # P1 / p1 / 1 → 1
  local p="${1:-2}"
  p="${p#P}"; p="${p#p}"
  case "$p" in
    0|1|2|3|4) echo "$p" ;;
    *) echo 2 ;;
  esac
}

map_status() {
  case "${1:-open}" in
    open) echo open ;;
    in_progress) echo in_progress ;;
    blocked) echo blocked ;;
    closed) echo closed ;;
    in_review) echo open ;; # label in_review applied separately
    *) echo open ;;
  esac
}

map_type() {
  case "${1:-task}" in
    epic|feature|task|bug|chore) echo "$1" ;;
    *) echo task ;;
  esac
}

create_one() {
  local tid title type priority status parent desc accept labels points
  tid=$(jq -r '.id // empty' <<<"$1")
  title=$(jq -r '.title // "untitled"' <<<"$1")
  type=$(map_type "$(jq -r '.type // "task"' <<<"$1")")
  priority=$(map_priority "$(jq -r '.priority // "P2"' <<<"$1")")
  status=$(jq -r '.status // "open"' <<<"$1")
  parent=$(jq -r '.parent_id // empty' <<<"$1")
  desc=$(jq -r '.description // ""' <<<"$1")
  accept=$(jq -r '.acceptance // ""' <<<"$1")
  points=$(jq -r '.points // empty' <<<"$1")
  labels=$(jq -r '[.labels // [] | .[]? | if type=="string" then . else (.name // empty) end] | join(",")' <<<"$1")

  if [[ -z "$tid" || -z "$title" ]]; then
    echo "skip row missing id/title" >&2
    return 0
  fi

  if [[ "$INCLUDE_CLOSED" -eq 0 && "$status" == "closed" ]]; then
    echo "skip closed $tid"
    return 0
  fi

  if is_migrated "$tid"; then
    echo "skip already migrated $tid → $(jq -r --arg t "$tid" '.[$t] // "map-miss"' "$ID_MAP")"
    return 0
  fi

  local footer mapped_status new_id create_args=()
  footer=$(printf '\n\n---\nMigrated from %s on %s' "$tid" "$STAMP")
  [[ -n "$points" && "$points" != "null" ]] && footer+=$(printf '\npoints: %s' "$points")
  mapped_status=$(map_status "$status")

  create_args=(create "$title" -t "$type" -p "$priority" --json)
  # description: prefer flag forms that exist across versions
  if bd create --help 2>&1 | grep -q -- '--description'; then
    create_args+=(--description "${desc}${footer}")
  fi
  if [[ -n "$accept" && "$accept" != "null" ]] && bd create --help 2>&1 | grep -q -- '--acceptance'; then
    create_args+=(--acceptance "$accept")
  fi

  echo "CREATE $tid  type=$type p=$priority status=$status→$mapped_status parent=${parent:-none}  $title"

  if [[ "$DRY_RUN" -eq 1 ]]; then
    return 0
  fi

  local out
  if ! out=$(bd "${create_args[@]}" 2>&1); then
    echo "bd create failed for $tid: $out" >&2
    return 1
  fi

  new_id=$(echo "$out" | jq -r '
    if type=="array" then .[0].id
    elif type=="object" then (.id // .issue.id // empty)
    else empty end
  ' 2>/dev/null || true)

  if [[ -z "$new_id" || "$new_id" == "null" ]]; then
    # fallback: last created line patterns
    new_id=$(echo "$out" | grep -oE '[a-z0-9]+-[a-z0-9]{3,}' | tail -1 || true)
  fi

  if [[ -z "$new_id" ]]; then
    echo "could not parse new id for $tid; raw: $out" >&2
    return 1
  fi

  # status
  if [[ "$mapped_status" != "open" ]]; then
    bd update "$new_id" --status "$mapped_status" --json >/dev/null || true
  fi

  # labels
  if bd update --help 2>&1 | grep -q -- '--add-label'; then
    bd update "$new_id" --add-label "migrated-from-td" --json >/dev/null || true
    bd update "$new_id" --add-label "legacy:${tid}" --json >/dev/null || true
    if [[ "$status" == "in_review" ]]; then
      bd update "$new_id" --add-label "in_review" --json >/dev/null || true
    fi
    if [[ -n "$labels" ]]; then
      IFS=',' read -ra LARR <<<"$labels"
      for L in "${LARR[@]}"; do
        [[ -n "$L" ]] && bd update "$new_id" --add-label "$L" --json >/dev/null || true
      done
    fi
  fi

  # parent — try common flags (ignore failures)
  if [[ -n "$parent" && "$parent" != "null" ]]; then
    local parent_bead
    parent_bead=$(jq -r --arg p "$parent" '.[$p] // empty' "$ID_MAP")
    if [[ -n "$parent_bead" ]]; then
      if bd update --help 2>&1 | grep -q -- '--parent'; then
        bd update "$new_id" --parent "$parent_bead" --json >/dev/null || true
      elif bd dep --help 2>&1 | grep -q parent; then
        bd dep add "$new_id" "$parent_bead" --type parent-child 2>/dev/null || true
      fi
    else
      echo "warn: parent $parent not in id-map yet for $tid → $new_id" >&2
    fi
  fi

  # update map
  jq --arg t "$tid" --arg b "$new_id" '. + {($t): $b}' "$ID_MAP" >"${ID_MAP}.tmp"
  mv -f "${ID_MAP}.tmp" "$ID_MAP"
  EXISTING_LEGACY+=("$tid")
  echo "  → $new_id"
}

# Topological-ish: parents first, then children (max 5 passes)
PASS=0
REMAINING=$(jq -c --argjson inc "$INCLUDE_CLOSED" '
  [.[] | select($inc == 1 or .status != "closed")]
' "$SNAPSHOT")

COUNT=$(echo "$REMAINING" | jq 'length')
echo "Issues to consider: $COUNT (include_closed=$INCLUDE_CLOSED dry_run=$DRY_RUN)"

while [[ $PASS -lt 8 ]]; do
  PASS=$((PASS + 1))
  PROGRESS=0
  while IFS= read -r row; do
    [[ -z "$row" || "$row" == "null" ]] && continue
    tid=$(jq -r '.id' <<<"$row")
    is_migrated "$tid" && continue
    parent=$(jq -r '.parent_id // empty' <<<"$row")
    if [[ -n "$parent" && "$parent" != "null" ]]; then
      # wait until parent mapped unless parent not in snapshot
      if echo "$REMAINING" | jq -e --arg p "$parent" 'any(.[]; .id == $p)' >/dev/null 2>&1; then
        is_migrated "$parent" || continue
      fi
    fi
    create_one "$row" || true
    PROGRESS=1
  done < <(echo "$REMAINING" | jq -c '.[]')

  # exit if all migrated or no progress
  left=0
  while IFS= read -r row; do
    tid=$(jq -r '.id' <<<"$row")
    is_migrated "$tid" || left=$((left + 1))
  done < <(echo "$REMAINING" | jq -c '.[]')
  echo "pass $PASS done; remaining unmigrated≈$left"
  [[ $left -eq 0 ]] && break
  [[ $PROGRESS -eq 0 && $DRY_RUN -eq 0 ]] && break
  [[ $DRY_RUN -eq 1 && $PASS -ge 2 ]] && break
done

echo "id-map → $ID_MAP ($(jq 'length' "$ID_MAP") entries)"
if [[ "$DRY_RUN" -eq 0 ]]; then
  echo "Verify: bd list --json | jq length; bd ready --json"
fi
