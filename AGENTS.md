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

> **CI only runs on pull requests and pushes to `main`.** A feature branch that
> is committed but never pushed (or has no open PR) gets **zero CI**. Local
> `npm test` builds + runs the suite but does **not** lint; only `script/cibuild`
> lints. A `pre-push` hook (`script/hooks/pre-push`, installed by `script/setup`
> via `core.hooksPath`) runs lint + test before every push so broken work cannot
> reach `origin`. Escape hatch: `ASD_SKIP_PREPUSH=1 git push` / `--no-verify`.

## Stack

Node.js / TypeScript (npm)

## Git & PR standards (universal)

- **Branches:** never commit directly to `main`; branch as `type/short-slug`.
- **Commits:** [Conventional Commits](https://www.conventionalcommits.org) —
  `type(scope): summary`. Types: `feat, fix, refactor, docs, test, chore, perf, ci`.
- **PRs:** fill `.github/PULL_REQUEST_TEMPLATE.md`; keep them small and focused;
  `script/cibuild` must pass before requesting review.
- **Definition of done:** a task is not reviewable until its commits are pushed
  to `origin` **and** CI is green on the PR. "Passes on my machine" is not done —
  unpushed work has never touched CI. Verify with `git log origin/<branch>..HEAD`
  (must be empty) and check the PR's CI status.
- **Secrets:** never commit secrets. Use env vars / a secret manager. `.env` is gitignored. For OpenRouter, use the 1Password item **OpenRouter API Credentials - agent-session-distillery** (`op read 'op://Private/OpenRouter API Credentials - agent-session-distillery/credential'`).

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
- **Hooks:** `asd hooks install` registers Claude Code SessionEnd → ingest sync
  ([`docs/recipes/session-end-ingest-hook.md`](docs/recipes/session-end-ingest-hook.md)).
- **Skill evidence:** `asd skill evidence <id>` scans indexed summaries for skill mentions
  (v1 of td-02cfd4 adherence analysis).
- **Skill report:** `asd skill report <id>` scores checklist adherence and suggests SKILL.md
  improvements ([`docs/recipes/skill-adherence-report.md`](docs/recipes/skill-adherence-report.md)).

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
