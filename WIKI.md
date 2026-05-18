---
canonical_dir: /Users/operator/vault
canonical_doc: /Users/operator/vault/wiki/meta/federated.md
hot_cache: /Users/operator/vault/wiki/hot.md
index: /Users/operator/vault/wiki/index.md
hub_project_page: /Users/operator/vault/wiki/projects/agent-session-distillery.md
skills:
  - wiki
  - wiki-query
  - wiki-ingest
  - wiki-lint
  - save
---

# Wiki Hub Pointer

This project is a spoke of the canonical knowledge hub at `/Users/operator/vault`.

Hub project page: `/Users/operator/vault/wiki/projects/agent-session-distillery.md`

Project: agent-session-distillery

## Vault writes (scoped)

asd is a named exception to the global "vault writes from vault sessions only"
rule. It may write **only** to the per-project subtree
`<vault>/wiki/projects/<project-key>/asd-learnings/` and the sibling
`_asd-manifest.json` file. Every other path under `<vault>` (`hot.md`,
`index.md`, `log.md`, `wiki/sources/`, `wiki/entities/`, `wiki/concepts/`,
`wiki/synthesis/`, `wiki/canvases/`, any `_index.md`, `.raw/.manifest.json`)
remains vault-session-owned and is never touched by asd.

Authoritative documents:

- [`CLAUDE.md`](CLAUDE.md) — repo-local restatement of the carve-out.
- [`docs/claude-md-amendment-draft.md`](docs/claude-md-amendment-draft.md) — the global `~/.claude/CLAUDE.md` amendment.
- [`docs/research/vault-push-source-strategy.md`](docs/research/vault-push-source-strategy.md) — the design.
