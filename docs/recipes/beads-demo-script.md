# Beads multi-tracker demo script (ASD)

Timed demo (~20–30 min). Capture output under `.agents-state/tracker-migration/demo-transcript-YYYYMMDD.md`.

## Preconditions

- `bd version` works; prefix `asd`
- Epics exist in beads; Linear project has epics only (not full task dump)
- Optional: one open public GH issue linked

## Steps

| # | Action | Expected |
|---|--------|----------|
| 1 | `bd ready --json` | Unblocked only; blocked children absent |
| 2 | `bd update <ready-id> --claim --json` | `in_progress` |
| 3 | `bd create "Demo discovery …" -t task -p 3 --deps discovered-from:<id> --json` | Child linked; beads-local |
| 4 | `bd linear sync --push --type epic --dry-run` | Discovery task **not** listed |
| 5 | Promote a feature: label + `bd linear push <id>` | Linear shows it; `external_ref` set |
| 6 | `bd show <gh-linked> --json` | `external_ref` like `gh-N` if public issue linked |
| 7 | Block claim with notes; `bd ready` | Blocked not ready |
| 8 | `bd close <discovery-id> --reason "demo complete"` | Closed |
| 9 | Session end: epic-only Linear push | Board still readable |

## Pass criteria

- No `td` writes during demo
- Linear not flooded with micro-tasks
- Discovery stayed local until promote
- Ready queue respected blocked work
