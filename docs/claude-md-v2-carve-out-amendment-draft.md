---
date: 2026-05-19
status: applied (2026-05-19)
supersedes: docs/claude-md-amendment-draft.md (the v1 vault-push amendment)
related:
  - docs/decisions/0003-primary-render.md
  - docs/decisions/0004-carve-out-boundary.md
  - docs/specs/atomic-instinct-schema.md
---

# v2 carve-out amendment (draft)

This is a **draft** amendment to the personal-vault carve-out rule
currently published at `~/.claude/CLAUDE.md` (Personal Hub Vault
section) and reflected in this project's `CLAUDE.md` (Vault write
surface section).

It is **not yet applied.** Operator must paste the new block into the
two files when ADR-0003 + ADR-0004 are accepted.

## Why an amendment

asd v2 introduces a curated `MEMORY.md` plus four topic files at the
project root inside the vault (per ADR-0003). The current carve-out
is named "asd-learnings/" only; the new paths are outside that scope.
Per the existing rule, new artifacts that don't fit the named pattern
require re-opening the design discussion. This is that discussion.

## Current carve-out (verbatim, both files agree)

> **Named exception — agent-session-distillery (asd).** The
> `agent-session-distillery` CLI may write to
> `~/vault/wiki/projects/<project-key>/asd-learnings/` (pages) and
> the sibling `_asd-manifest.json` file from any session. The
> exception is strictly scoped: asd must not touch any other vault
> path (`hot.md`, `index.md`, `log.md`, `wiki/sources/`,
> `wiki/entities/`, `wiki/concepts/`, `wiki/synthesis/`,
> `wiki/canvases/`, any `_index.md`, or `.raw/.manifest.json`). It
> is named for asd specifically and does not extend by precedent to
> other tools.

## Proposed v2 carve-out (replacement block)

> **Named exception — agent-session-distillery (asd) v2.** The
> `agent-session-distillery` CLI may write to the following paths
> under `~/vault/wiki/projects/<project-id>/`:
>
> 1. `asd-learnings/**` — append-only audit trail of per-session
>    distilled learnings.
> 2. `_asd-manifest.json` — adapter-state manifest.
> 3. `MEMORY.md` — curated rollup of high-confidence instincts.
> 4. `workflow.md`, `tooling.md`, `preferences.md`, `pitfalls.md`,
>    `debugging.md` — topic files (overflow targets of `MEMORY.md`).
>
> asd must not touch any other vault path, including (but not
> limited to) `hot.md`, `index.md`, `log.md`, `wiki/sources/`,
> `wiki/entities/`, `wiki/concepts/`, `wiki/synthesis/`,
> `wiki/canvases/`, any `_index.md`, or `.raw/.manifest.json`. The
> exception is strictly scoped and named for asd v2; new artifacts
> outside the seven patterns above require re-opening this
> discussion, not silent expansion. It does not extend by precedent
> to other tools.
>
> Note: `<project-id>` is resolved per ADR-0002 (git-remote-hash
> with fallback chain). Pre-v2 path-based keys remain valid for
> read; new writes use the v2 ID.

## Operator action checklist

- [ ] ADR-0003 marked `accepted` (primary render = curated MEMORY.md).
- [ ] ADR-0004 marked `accepted` (carve-out scope expansion).
- [ ] ADR-0002 marked `accepted` (project ID strategy).
- [ ] Paste the v2 carve-out block into `~/.claude/CLAUDE.md`
      "Personal Hub Vault" section, replacing the current named
      exception paragraph for asd.
- [ ] Paste the v2 carve-out block into this project's `CLAUDE.md`
      "Vault write surface" section, replacing the current carve-out
      paragraph.
- [ ] Update the v1 amendment file (`docs/claude-md-amendment-draft.md`)
      to point at this v2 amendment as its successor.
- [ ] Land the technical guardrail: asd code asserts every vault
      write matches the seven-pattern allowlist; tests cover both
      allowed and forbidden write attempts (per ADR-0004
      Consequences).

## Why this is safe

The expansion is **named and bounded**, not pattern-based. The
expansion is from one pattern (`asd-learnings/`) to seven specific
patterns. Every other vault path remains off-limits. The expansion
does not enable other tools — the exception remains named for asd
v2 specifically.

The technical guardrail (path allowlist enforced in code) is the
key safety improvement over the v1 carve-out, which is currently
enforced only by social contract.
