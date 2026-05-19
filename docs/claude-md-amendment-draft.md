---
date: 2026-05-18
status: superseded
superseded_by: docs/claude-md-v2-carve-out-amendment-draft.md
superseded_on: 2026-05-19
original_status: operator-action-required
purpose: Draft wording for a named exception in the global CLAUDE.md before F2-B lands.
---

> **Superseded 2026-05-19** by the v2 carve-out amendment, which
> was applied to `~/.claude/CLAUDE.md` and the project `CLAUDE.md`
> on the same day. See
> [`docs/claude-md-v2-carve-out-amendment-draft.md`](claude-md-v2-carve-out-amendment-draft.md)
> and ADR-0004. Content below preserved for history.

# Global CLAUDE.md amendment draft

This document is the operator-actionable draft for amending the global
`~/.claude/CLAUDE.md` to permit `agent-session-distillery` (asd) to write
to a scoped subtree of `~/vault/`. It is not applied automatically; the
operator pastes the proposed wording manually after reviewing it here.

The rule being amended originates outside this repo (it lives in the
operator's global Claude Code config) and must be applied there. Landing
this draft in the repo without applying the corresponding amendment in
`~/.claude/CLAUDE.md` leaves the F2-B implementation in conflict with the
operator's stated rule. F2-B's `vault-push-phase-1` gate requires the
amendment to be applied before it can be marked validated.

## Target

- **File:** `~/.claude/CLAUDE.md`
- **Section:** `### Personal Hub Vault` (currently begins at line 247
  as of 2026-05-18; verify with
  `grep -n "### Personal Hub Vault" ~/.claude/CLAUDE.md` before editing).

## Current text to replace

Locate this exact sentence inside the `### Personal Hub Vault` block:

> Do not write to `~/vault/` from a project session unless the user
> explicitly asks. Vault writes happen from `~/vault/` sessions only,
> to keep a single source of truth.

Anchor command for the operator:

```
grep -n "Vault writes happen from" ~/.claude/CLAUDE.md
```

Expected output is a single line. If `grep` returns zero or more than one
match, stop and reconcile manually — the global file has drifted since
this draft was written.

**Paste preservation note.** Both the anchor sentence above and the
proposed replacement below contain em-dash characters (`—`, U+2014). Some
sources (an autocorrecting note app, a "smart punctuation" terminal) will
normalise them to two-hyphens (`--`) at copy time, after which the
verification greps below return zero matches. The safest path is to open
this draft file directly in the same editor as `~/.claude/CLAUDE.md` and
copy the block across — that way no intermediate transform touches the
text. If the paste produced `--` instead of `—`, search for "Named
exception" without the em dash to confirm and fix in place.

## Proposed replacement

Replace the one sentence above with the same sentence plus an explicit
named exception:

> Do not write to `~/vault/` from a project session unless the user
> explicitly asks. Vault writes happen from `~/vault/` sessions only,
> to keep a single source of truth.
>
> **Named exception — agent-session-distillery (asd).** The
> `agent-session-distillery` CLI may write to
> `~/vault/wiki/projects/<project-key>/asd-learnings/` (pages) and the
> sibling `_asd-manifest.json` file from any session. The exception is
> strictly scoped: asd must not touch any other vault path
> (`hot.md`, `index.md`, `log.md`, `wiki/sources/`, `wiki/entities/`,
> `wiki/concepts/`, `wiki/synthesis/`, `wiki/canvases/`, any
> `_index.md`, or `.raw/.manifest.json`). It is named for asd
> specifically and does not extend by precedent to other tools.

## Rationale (for the operator's change log or audit trail)

The exception is safe because the write surface is contained and the
vault-session-owned indices stay vault-session-owned:

1. asd's subtree (`wiki/projects/<key>/asd-learnings/`) is disjoint from
   anything the existing `claude-obsidian:wiki-ingest` skill writes. No
   file path is shared.
2. asd does not touch the global indices (`hot.md`, `index.md`,
   `log.md`) or `.raw/.manifest.json`. The next vault session's normal
   autolink / lint flow discovers new asd pages through the same
   mechanism it uses for any other new file under `wiki/`.
3. asd's per-project manifest (`_asd-manifest.json`) is a separate file
   from `.raw/.manifest.json`. Two writers, two manifests, no shared
   state.
4. The exception is named for asd specifically. If a second tool ever
   needs a similar carve-out, the operator adds a second named entry —
   the precedent does not silently expand.

Companion artifacts in this repo:

- `docs/research/vault-push-source-strategy.md` — the filesystem probe
  and decision summary backing this amendment.
- `docs/plans/2026-05-18-vault-push-integration.md` — the design plan
  for the `memory push-wiki` command.

## Operator verification

After pasting the amendment into `~/.claude/CLAUDE.md`:

```
grep -n "Named exception — agent-session-distillery" ~/.claude/CLAUDE.md
```

Should return exactly one match. If it returns zero, the paste did not
land. If it returns more than one, the paste was applied more than once
and the duplicate should be removed.

## When this can be applied

Any time before F2-B (the `memory push-wiki` command PR) is merged. The
amendment is independent of any in-repo code change and can land before,
during, or alongside F2-B's review. F2-B's `vault-push-phase-1`
LAUNCH_CRITERIA gate cannot be marked validated until this amendment is
applied.
