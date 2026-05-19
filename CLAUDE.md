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
  enforcement is **code-level**: asd's vault writer asserts every
  output path against the allowlist and refuses any write that does
  not match.
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
