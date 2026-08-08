# Recipe: Beads + Linear + GitHub (hub-and-spoke)

Operator runbook for **agent-session-distillery** multi-tracker workflow.

## Roles

| System | Role |
|--------|------|
| **beads** (`bd`) | Agent source of truth — ready, claim, deps, close, gates |
| **Linear** | Human product board — epics / promoted features |
| **GitHub Issues** | Public intake only |
| **GitHub PR/CI** | Code review + beads gates (`gh:pr`, `gh:run`) |
| **td** (`.todos/`) | Frozen archive after cutover — do not write |

## Session start (agent)

```bash
bd linear sync --pull-if-stale --prefer-local 2>/dev/null || true
bd github sync --pull-only 2>/dev/null || true
bd ready --json
bd update <id> --claim --json
```

## During work

```bash
bd create "Found X" -t task -p 2 --deps discovered-from:<parent> --json
bd update <id> --status blocked --notes "…" --json
bd close <id> --reason "…" --json
# Never: free Linear/GH issue create; never td create/update
```

## Session end

```bash
# Only if promoted epic/feature changed:
bd linear sync --push --type epic,feature --exclude-type wisp --prefer-local
# Public only when intentional:
# bd github push <id>
```

## Promote

**→ Linear** when type is epic/feature **or** label `promote:linear`, and operator intent:

```bash
bd update <id> --add-label promote:linear --json
bd linear push <id> --dry-run
bd linear push <id>
```

**→ GitHub Issues** when label `promote:github` or public bug + operator intent:

```bash
bd github push <id>
```

Bulk epic push:

```bash
bd linear sync --push --type epic --prefer-local --dry-run
bd linear sync --push --type epic --prefer-local
```

## Conflict policy

| Situation | Flag |
|-----------|------|
| Agent execution state | `--prefer-local` |
| Absorb Linear plan intentionally | `--prefer-linear` on pull |
| Public GH body on pull | `--prefer-github` |
| Default | newer wins |

## Config (local secrets — never commit)

```bash
bd config set github.repository "dallascrilley/agent-session-distillery"
bd config set linear.api_key "$LINEAR_API_KEY"
bd config set linear.team_id "8b799053-907f-4ddf-a416-95a29140b475"   # Agents
bd config set linear.project_id "2c363bff-5dda-448f-9c4c-eac5161be42a" # ASD project
bd linear status
bd github status
```

Linear project URL: https://linear.app/dallascrilley/project/agent-session-distillery-cc5ba82b08da

## Recovery

- Bad Linear flood: delete mistaken Linear issues; clear wrong `external_ref` if needed; re-push selective.
- Re-import leftover `td` work: skill `beads-multi-tracker` Mode E / `scripts/migrate-td-to-beads.sh` with delta snapshot.
- Rollback (≤14 days): see `.todos/FROZEN.md` and plan rollback section.

## Related

- ADR: `docs/decisions/0010-multi-tracker-hub-spoke.md`
- Demo: `docs/recipes/beads-demo-script.md`
- Plan: `docs/plans/2026-08-07-chore-beads-linear-github-workflow-demo-plan.md`
- Skill: `beads-multi-tracker`


## Linear state maps (Agents team)

Custom started states (Verify, Learn, Human Review, Blocked, In Progress) require:

```bash
bd config set linear.outbound_state_map.open "Todo"
bd config set linear.outbound_state_map.in_progress "In Progress"
bd config set linear.outbound_state_map.blocked "Blocked"
bd config set linear.outbound_state_map.closed "Done"
```

On `bd` 1.1.2, push may still fail; create Linear issues via API/UI and `bd update <id> --external-ref <url>`.
