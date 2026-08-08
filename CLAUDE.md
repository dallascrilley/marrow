# CLAUDE.md — agent-session-distillery

Repo-local agent guidance. Reads alongside [`WIKI.md`](WIKI.md), the wiki-hub
pointer, and the global `~/.claude/CLAUDE.md`.

## Vault write surface (v2 — accepted 2026-05-19)

This repo writes directly into the operator's personal vault at
`~/vault` (or `$ASD_VAULT_ROOT`). The global `~/.claude/CLAUDE.md`
rule "Vault writes happen from `~/vault/` sessions only" is amended
with a **named exception for asd v2**:

> agent-session-distillery (asd) may write to the following paths
> under `~/vault/wiki/projects/<project-id>/`:
>
> 1. `asd-learnings/**` — append-only audit trail of per-session
>    distilled learnings.
> 2. `_asd-manifest.json` — adapter-state manifest.
> 3. `MEMORY.md` — curated rollup of high-confidence instincts.
> 4. `workflow.md`, `tooling.md`, `preferences.md`, `pitfalls.md`,
>    `debugging.md` — topic files (overflow targets of `MEMORY.md`).
>
> asd must not touch any other vault path. The exception is strictly
> scoped and named for asd v2 specifically; new artifact types
> require re-opening this discussion, not silent expansion.

If you are an agent working in this repo:

- You may run asd's vault-write commands (`memory push-wiki` and the
  forthcoming v2 renderers) against the operator's vault without
  asking. They produce a notice and exit 0 if the vault is missing.
- You may **not** write to any other path under `~/vault`. That
  includes `hot.md`, `index.md`, `log.md`, `wiki/sources/`,
  `wiki/entities/`, `wiki/concepts/`, `wiki/synthesis/`,
  `wiki/canvases/`, any `_index.md`, and `.raw/.manifest.json`.
  Those remain owned by `~/vault/` sessions.
- The carve-out is keyed to the eight named paths above. The
  enforcement is **structural + code-enforced**: `src/config/vault-paths.ts`
  owns the allowlist, and every vault write routes through
  `vaultProjectPath`, which throws before creating a file outside the
  carve-out. There is no generic vault writer that can reach other
  `~/vault` locations.
- `<project-id>` is resolved per ADR-0002 (git-remote-hash with
  fallback chain).

The accepted decisions are at [`docs/decisions/`](docs/decisions/);
the schema spec is at
[`docs/specs/atomic-instinct-schema.md`](docs/specs/atomic-instinct-schema.md);
the landscape report behind the v2 direction is at
[`docs/research/agent-learning-systems-landscape-report.md`](docs/research/agent-learning-systems-landscape-report.md);
the v1 vault-push amendment is at
[`docs/claude-md-amendment-draft.md`](docs/claude-md-amendment-draft.md)
(superseded by [`docs/claude-md-v2-carve-out-amendment-draft.md`](docs/claude-md-v2-carve-out-amendment-draft.md)).

## Project conventions

The rest of asd's conventions (build, test, ingestion, lifecycle, retention)
are documented in [`README.md`](README.md) and the plans under
[`docs/plans/`](docs/plans/). This file's only job is to make the vault-write
carve-out impossible to miss on first read.

<!-- IJFW-MEMORY-START (managed -- do not edit manually) -->
<ijfw-memory>
Project memory at .ijfw/memory/. Call `ijfw_memory_prelude` for full context.
</ijfw-memory>

<ijfw-profile>
Your portable working profile (derived from what you've said/edited; style + expertise only):
style.formality: casual
style.energy: measured
style.terseness: expansive
style.emoji_use: rare
</ijfw-profile>

<ijfw-routing>
IJFW is installed alongside a peer brainstorming skill. For project-level tasks (build, create, design, plan, brainstorm, landing page, app, website, dashboard, campaign, book, launch), prefer the ijfw:ijfw-workflow skill -- the user opted into IJFW via install, and ijfw-workflow is its configured workflow entry point. IJFW orchestrates think-build-ship end to end and dispatches peer specialist skills (frontend-design, TDD, code-review) as subagent tools when the workflow needs them.
</ijfw-routing>
<!-- IJFW-MEMORY-END -->

## Issue tracking

Use **beads** (`bd`), not `td`. See AGENTS.md § Issue Tracking and `docs/recipes/beads-linear-github-workflow.md`.


<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:6cd5cc61 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->
