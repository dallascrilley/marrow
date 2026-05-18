---
date: 2026-05-18
status: research-only
launch_criteria_gate: vault-push-research
---

# Vault push source strategy

This note locks the on-disk target shape for the planned `memory push-wiki`
command in `agent-session-distillery` (asd) before any code is written. It
mirrors the structure of `docs/research/background-agent-source-strategy.md`
so the launch-criteria gate has the same shape as the v1 research gate.

Companion plan: `docs/plans/2026-05-18-vault-push-integration.md`. That plan
chose Option A (push from asd directly into `~/vault`) over pull/assisted
options. This note verifies that the chosen subtree exists, has no
collisions, and matches an established vault convention.

## What "push" means here

asd writes `asd.wiki_memory.v1` records as Obsidian-shaped markdown pages
into a scoped subtree the personal vault treats as asd-owned. asd does not
participate in `~/vault/.raw/.manifest.json`, does not touch global vault
indices (`hot.md`, `index.md`, `log.md`), and does not create pages outside
its subtree. The next vault session's normal autolink / lint flow picks up
new asd pages the same way it picks up any other new file under `wiki/`.

## Filesystem probe (2026-05-18)

A direct probe of this machine confirms the chosen subtree is unused.
Single-level subdirectories under `projects/` are an established layout;
the deeper two-level nesting is new but Obsidian-supported (see below).

- `~/vault/wiki/projects/` — 14 flat project pages plus one subdir
  (`@zosmaai/` containing `pi-llm-wiki.md`). The existing hub page
  `agent-session-distillery.md` is already present (970 B, `type: entity`
  / `entity_type: repo`, links to this repo via `canonical_doc` and
  `source_url`).
- `~/vault/wiki/projects/agent-session-distillery/` — does not exist as a
  directory. Obsidian supports `agent-session-distillery.md` (the hub
  page) and `agent-session-distillery/` (a sibling directory) coexisting;
  the directory becomes a folder of children, the markdown file remains
  the canonical page.
- `find ~/vault -type d -name "asd-learnings"` — zero matches anywhere
  under `~/vault/`. No legacy directory blocks the chosen subtree.
- `find ~/vault/wiki -maxdepth 4 -type d -name "*asd*"` — zero matches.
  No existing asd-shaped artifact anywhere under `wiki/`.
- Subdirectory-under-`projects/` precedent: `~/vault/wiki/projects/@zosmaai/`
  (one flat `.md` inside). Subdirectories under `projects/` are therefore an
  established layout. The deeper two-level `<project-key>/asd-learnings/`
  nesting is new but Obsidian-supported; no precedent or counter-precedent
  was found.

## Existing project-page frontmatter (for reconciliation)

Sampled from `~/vault/wiki/projects/agent-session-distillery.md`:

```yaml
---
type: entity
entity_type: repo
title: "agent-session-distillery"
updated: 2026-05-18
tags: [entity, project, repo]
status: current
lifecycle: active
canonical_dir: /Users/operator/Code/agent-session-distillery
canonical_doc: /Users/operator/Code/agent-session-distillery/WIKI.md
source_url: "https://github.com/dallascrilley/agent-session-distillery.git"
related:
  - "[[projects/_index]]"
  - "[[Federated Vaults: Hub + Spokes]]"
---
```

asd-pushed pages will use a smaller, asd-shaped frontmatter (see
companion plan §3) and will add an explicit `source: asd` key plus an
`asd` tag. Together those two fields let `wiki-lint` and any future
vault-side tool identify asd-authored pages unambiguously without relying
on path heuristics.

The asd frontmatter intentionally does **not** reuse `type: entity` / 
`entity_type: repo`, because asd pages are not entities — they are
project-learning records. Reusing the entity schema would make asd pages
appear in entity queries and inflate counts in `wiki/entities/`-style
dashboards. Keeping a distinct schema (`source: asd`, `schema_version:
asd.wiki_memory.v1`) keeps the boundary clean.

## wiki-ingest convention reconciliation

The standard `claude-obsidian:wiki-ingest` flow touches the following on
every ingest:

- Creates / updates `wiki/sources/<title>.md`.
- Creates / updates `wiki/entities/<entity>.md` and
  `wiki/concepts/<concept>.md`.
- Updates the relevant `wiki/<domain>/_index.md`.
- Updates `wiki/index.md`, `wiki/log.md`, and `wiki/hot.md`.
- Records the source under `~/vault/.raw/.manifest.json` with `hash`,
  `ingested_at`, `pages_created`, `pages_updated`.

**asd-pushed pages deliberately stay outside that flow.** asd writes only:

- `~/vault/wiki/projects/<project-key>/asd-learnings/<id>.md` (the page).
- `~/vault/wiki/projects/<project-key>/asd-learnings/_asd-manifest.json`
  (asd-owned, separate from `.raw/.manifest.json`).

asd does not write `wiki/sources/...`, `wiki/entities/...`,
`wiki/concepts/...`, any `_index.md`, `wiki/index.md`, `wiki/log.md`,
`wiki/hot.md`, `wiki/synthesis/...`, `wiki/canvases/...`, or
`.raw/.manifest.json`. The next vault session's normal autolink / lint
pass discovers asd pages through the same mechanism it uses for any new
file under `wiki/` — no special integration is required from the vault
side.

**Forward-looking F2-B requirement: em-dash sanitisation.** The
`claude-obsidian:wiki-ingest` SKILL.md has an explicit "Never" rule:
*"Use em dashes or `--` as punctuation."* asd-pushed pages will include
record `title`, `body`, and `evidence` strings extracted from LLM-generated
session content, which routinely contains em dashes. F2-B's page renderer
must normalise both `—` (U+2014) and the two-hyphen `--` shorthand in
those fields before writing, or asd will silently violate the vault
convention on every push. Frontmatter and structural markdown (headers,
list bullets) are author-controlled in F2-B's renderer and can be written
em-dash-free by construction. Only the variable fields lifted from records
need sanitisation.

## Atomic-write contract

The follow-up `memory push-wiki` command will write each page via
temp-file + rename (`fs.rename` after `fs.writeFile` into a sibling
`.<id>.tmp` file). `_asd-manifest.json` is updated only after a
successful page write. A crash mid-write therefore never leaves a
half-written `.md` for the next vault session to ingest; a crash between
page write and manifest update leaves the page in place with a stale
manifest, which the next push reconciles by recomputing `content_hash`
and accepting the on-disk page as canonical.

## Risk register

| Risk | Mitigation |
|---|---|
| `~/vault` missing on a fresh machine | `push-wiki` exits 0 with a "vault not present" notice. Launchd / cron does not pile up failure noise. |
| Operator manually edits an asd-authored page | **Default behaviour does not detect operator edits.** `push-wiki` compares its newly-rendered output's `content_hash` to the manifest, not to the on-disk page. A re-run with no upstream source change is a no-op (same hash, manifest skip), so plain re-runs do not clobber edits. Any change that alters rendered output — new evidence, title/body revision, schema bump — produces a new hash and overwrites the edited page. F2-B ships a `--no-overwrite` flag which reads the on-disk page, compares its hash to the manifest, and skips when they diverge, preserving manual edits at the cost of suppressing legitimate asd updates. Operators who edit asd pages by hand should run with `--no-overwrite`. Moving the page out of the `asd-learnings/` subtree does not help: the manifest's recovery contract recreates the canonical page at the original path on the next push. |
| Future vault-side tool moves or renames pages | `_asd-manifest.json` tolerates the named page being absent and recreates it on the next push. The manifest is the source of truth for "did I write this id"; the on-disk page is the source of truth for "what does the wiki currently say about this id". No known vault-side tool renames pages today; this row is a forward-looking guarantee, not a response to current behaviour. |
| `project.key` contains `/` or `..` | Sanitiser strips path separators and leading dots; falls back to `unknown` if sanitisation empties the key. asd never writes outside `<vault>/wiki/projects/<sanitised>/asd-learnings/`. |
| Dual writer race with a vault session running `wiki-ingest` | Containment: asd's subtree is disjoint from anything `wiki-ingest` writes. No file path is shared. |
| Operator wants to delete asd pages wholesale | Not a phase-1 concern. asd marks `deleted_at` in the manifest when a source record disappears but leaves the page in place. A vault-side cleanup skill (phase 2) can act on `deleted_at` later. |

## Decision summary

| Item | Value |
|---|---|
| Subtree path | `~/vault/wiki/projects/<sanitised project.key>/asd-learnings/` |
| Page filename | `<id-without-sha256-prefix>.md` |
| Manifest path | `<subtree>/_asd-manifest.json` |
| Manifest schema | `asd.vault_push_manifest.v1` |
| Page frontmatter shape | See companion plan §3. Includes `source: asd`, `schema_version: asd.wiki_memory.v1`, the record's `id`, and the record's `evidence.source_refs[]`. |
| Vault paths asd writes | The two above (page + manifest). |
| Vault paths asd never writes | `wiki/index.md`, `wiki/log.md`, `wiki/hot.md`, `wiki/sources/`, `wiki/entities/`, `wiki/concepts/`, `wiki/synthesis/`, `wiki/canvases/`, any `_index.md`, `.raw/.manifest.json`. |
| Vault-default-missing behaviour | Exit 0 with notice; no error. |
| Atomic-write strategy | Temp-file + rename, then manifest update. |

## Next operator action

Apply the CLAUDE.md amendment drafted in
`docs/claude-md-amendment-draft.md` to `~/.claude/CLAUDE.md`. Once
applied, the next PR (F2-B, `memory push-wiki` command) can land with
its `vault-push-phase-1` gate validated.
