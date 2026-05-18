# CLAUDE.md — agent-session-distillery

Repo-local agent guidance. Reads alongside [`WIKI.md`](WIKI.md), the wiki-hub
pointer, and the global `~/.claude/CLAUDE.md`.

## Vault write surface

This repo's `memory push-wiki` command writes directly into the operator's
personal vault at `~/vault` (or `$ASD_VAULT_ROOT`). The global
`~/.claude/CLAUDE.md` rule "Vault writes happen from `~/vault/` sessions only"
is amended with a **named exception for asd**:

> agent-session-distillery (asd) may write to
> `~/vault/wiki/projects/<project-key>/asd-learnings/` (pages) and the sibling
> `_asd-manifest.json` file from any session. The exception is strictly
> scoped: asd must not touch any other vault path. It is named for asd
> specifically and does not extend by precedent to other tools.

If you are an agent working in this repo:

- You may run `node dist/cli.js memory push-wiki` against the operator's vault
  without asking. It will produce a notice and exit 0 if the vault is missing.
- You may **not** write to any other path under `~/vault`. That includes
  `hot.md`, `index.md`, `log.md`, `wiki/sources/`, `wiki/entities/`,
  `wiki/concepts/`, `wiki/synthesis/`, `wiki/canvases/`, any `_index.md`, and
  `.raw/.manifest.json`. Those remain owned by `~/vault/` sessions.
- The carve-out is keyed to the `asd-learnings/` subtree and to asd's
  `_asd-manifest.json`. New artifacts that don't fit either pattern require
  re-opening the design discussion, not silent expansion of the carve-out.

The amendment draft and its operator-action steps live at
[`docs/claude-md-amendment-draft.md`](docs/claude-md-amendment-draft.md). The
research note backing the design lives at
[`docs/research/vault-push-source-strategy.md`](docs/research/vault-push-source-strategy.md).

## Project conventions

The rest of asd's conventions (build, test, ingestion, lifecycle, retention)
are documented in [`README.md`](README.md) and the plans under
[`docs/plans/`](docs/plans/). This file's only job is to make the vault-write
carve-out impossible to miss on first read.
