# AGENTS.md — agent-session-distillery

Agent-facing contract for this repo. Human docs live in `README.md`; project
facts live in `PROJECT_CONTEXT.md`.

## Commands (use these, not raw tooling)

This project follows **Scripts to Rule Them All** — `script/*` are the canonical
entrypoints, and `just <recipe>` is a thin alias for each.

| Task | Command | `just` |
|------|---------|--------|
| Install toolchain | `script/bootstrap` | `just bootstrap` |
| Get runnable | `script/setup` | `just setup` |
| Refresh after pull | `script/update` | `just update` |
| CLI help (after build) | `script/server` | `just server` |
| Run tests | `script/test` | `just test` |
| What CI runs | `script/cibuild` | `just cibuild` |
| REPL / console | `script/console` | `just console` |

`script/cibuild` is the single source of truth for CI — if it passes locally, CI passes.

## Stack

Node.js / TypeScript (npm)

## Git & PR standards (universal)

- **Branches:** never commit directly to `main`; branch as `type/short-slug`.
- **Commits:** [Conventional Commits](https://www.conventionalcommits.org) —
  `type(scope): summary`. Types: `feat, fix, refactor, docs, test, chore, perf, ci`.
- **PRs:** fill `.github/PULL_REQUEST_TEMPLATE.md`; keep them small and focused;
  `script/cibuild` must pass before requesting review.
- **Secrets:** never commit secrets. Use env vars / a secret manager. `.env` is gitignored.

## Working agreement

- Make the smallest maintainable change that satisfies the task; match existing patterns.
- Validate before claiming done: run `script/test` (or `script/cibuild`) and read the result.
- Update `docs/` (ADR in `docs/decisions/`, learnings in `docs/lessons.md` and
  `docs/solutions/`) when behavior or architecture changes.

## Task Tracking (td)

Applies when this repo is td-initialized (`.todos/` present). Bootstrap runs
`td init` when missing.

- **Session start:** `td usage --new-session`
- **Capture first:** record tasks, bugs, and ideas in td before editing — the
  tracker, not chat, is the source of truth.
- **While working:** `td start` before edits; `td log --decision` for choices;
  `td block --reason` when stuck.
- **Before exit:** hand off in-progress items and run `td check-handoff`.
- **Full workflow:** `td-task-management` skill.

## Knowledge routing

- Search `docs/solutions/` before debugging recurring issues:
  `grep -ril "<terms>" docs/solutions/`
- Capture non-obvious fixes via `ce-compound` → `docs/solutions/<category>/`
- Maintain stale solution docs via `ce-compound-refresh`

## Recommended agents & skills

These live in the shared agent hub and are referenced (not vendored) by default.
Run `project-bootstrap --vendor` to copy local snapshots into `.claude/` for a
self-contained repo.

- **Agents:** `code-reviewer`, `architect`, `tdd-guide`, `e2e-runner`, `doc-updater`
- **Skills:** `prime`, `library`, `handoff`, `git` (commit / PR / PR-comments),
  `td-task-management`, `subagent-driven-development`, `secrets-management`,
  `prompt-optimizer`, `docs-lifecycle` (generate/audit project docs)

Use `/library load <id>` for on-demand hub skills. **Project-relevant skills**
discovered during bootstrap are appended below this baseline as a
`### Project-relevant skills` subsection (structured entries with path and load command).

## Repo-specific guidance

- **Vault writes:** [`CLAUDE.md`](CLAUDE.md) defines the v2 carve-out — only the eight
  named paths under `~/vault/wiki/projects/<project-id>/`. Do not expand silently.
- **Launch state:** check [`LAUNCH_CRITERIA.md`](LAUNCH_CRITERIA.md) before treating
  features as ship-ready.
- **Legacy scripts:** `scripts/` holds proof and dry-run utilities; prefer `script/*`
  and `npm run` for bootstrap/CI parity.

### Project-relevant skills

- **`continuous-learning-systems`** — Design and configure capture → instinct → evolution pipelines.
  - **Why this project:** asd is the ingestion/distillation layer for exactly these pipelines; v2 instincts and vault export depend on this mental model.
  - **Path:** `~/.claude/skills/continuous-learning-systems/SKILL.md`
  - **Load:** `/library load continuous-learning-systems`

- **`ce-compound`** — Capture non-obvious fixes into `docs/solutions/`.
  - **Why this project:** adapter/parser edge cases and retention bugs belong in `docs/solutions/` for the next ingest/debug session.
  - **Path:** `~/.claude/skills/ce-compound/SKILL.md`
  - **Load:** `/library load ce-compound`

- **`vault`** — Read/recall/capture in `~/vault` with correct write boundaries.
  - **Why this project:** `memory push-wiki` and v2 renderers touch vault project pages; agents must respect carve-out vs vault-owned paths.
  - **Path:** `~/.claude/skills/vault/SKILL.md`
  - **Load:** `/library load vault`
