---
date: 2026-05-18
status: design-only
authors: dallascrilley
related:
  - docs/wiki-memory-export-contract.md
  - docs/plans/2026-05-18-multi-adapter-expansion.md
  - WIKI.md
  - LAUNCH_CRITERIA.md
launch_criteria_gates_proposed:
  - vault-push-research
  - vault-push-phase-1
---

# Vault push integration

Push `asd.wiki_memory.v1` records from asd directly into the personal vault at
`~/vault` as Obsidian-shaped markdown pages. Zero manual import step between
an asd ingest run and a vault page.

This is a design pass only. No TypeScript is changed in this round. The
existing wiki-memory export contract (`docs/wiki-memory-export-contract.md`,
schema `asd.wiki_memory.v1`) is the authoritative producer-side handoff and
is referenced, not duplicated. Phase 1 introduces no schema changes.

Companion plan: [multi-adapter expansion](2026-05-18-multi-adapter-expansion.md).
The two plans are independent — vault push works against today's Cursor-only
data and silently grows in volume as new adapters land.

---

## Open Decisions (resolved before drafting)

| # | Question | Operator answer | Why |
|---|----------|-----------------|-----|
| 1 | Direction: push / pull / assisted? | **Push from asd (Option A).** Operator preference: "more useful and exciting" — zero manual step between an asd ingest run and a vault page. | Overrides the original recommendation of pull. Accepted with two guardrails: scoped write surface and a named CLAUDE.md carve-out. See §2. |
| 2 | Should this repo write to `~/vault` directly? | **Yes, scoped.** asd may write only under `~/vault/wiki/projects/<project-key>/asd-learnings/<id>.md` and the per-project `_asd-manifest.json` next to it. asd does **not** touch `hot.md`, `index.md`, `log.md`, `wiki/concepts/`, `wiki/entities/`, or `.raw/.manifest.json`. Those remain vault-session-owned. | Narrowing the write surface to a per-project subtree contains the dual-writer risk to files asd is the sole author of. Vault sessions still own the global indices and pick up new asd files through their existing autolink/log flow on the next session. |

The multi-adapter plan resolves its own decision (Pi as a transcript source)
independently. It does not affect this plan.

---

## §1 Background

Anchor: the existing `asd.wiki_memory.v1` JSONL contract documented in
`docs/wiki-memory-export-contract.md`. asd already writes
`<runtime-root>/exports/wiki-memory/reviewed-memory.jsonl` deterministically,
with a sha256 `id` per record. **No new schema is proposed for phase 1.**

The vault side already has a consumer pattern: `claude-obsidian:wiki-ingest`
maintains `~/vault/.raw/.manifest.json` keyed by file hash, and writes
source/entity/concept pages with delta tracking. asd does **not** participate
in `.raw/.manifest.json`; it owns its own per-project manifest in a
non-overlapping subtree.

---

## §2 Decision and rationale

**Chosen: Option A (push from asd), scoped.** The operator wants the
"transcript → wiki page" path to be automatic with no manual import step.
Push delivers that; pull and assisted both require a separate trigger.

The "violates the global CLAUDE.md vault-writes-from-vault-sessions rule"
objection is resolved by two guardrails, both of which ship with the phase-1
PR:

1. **Write-surface containment.** asd writes only inside
   `~/vault/wiki/projects/<project-key>/asd-learnings/` and its sibling
   `_asd-manifest.json`. asd never touches `hot.md`, `index.md`, `log.md`,
   `wiki/concepts/`, `wiki/entities/`, `wiki/synthesis/`, `wiki/sources/`,
   `wiki/canvases/`, or `.raw/.manifest.json`. The next vault session picks
   up new files through its existing autolink/log flow — the same way it
   already picks up any new file under `wiki/`.
2. **Documented exception.** The global CLAUDE.md "vault writes from vault
   sessions only" rule is amended in the same PR with an explicit, narrowly
   worded carve-out:
   > "agent-session-distillery (asd) may write to
   > `~/vault/wiki/projects/<project-key>/asd-learnings/` from any session.
   > This exception is named for asd specifically and does not extend by
   > precedent to other tools."

### Other options evaluated

| Option | Trigger model | Conflict / idempotency | Failure modes | Why not chosen |
|---|---|---|---|---|
| **B — Pull from vault** | Vault-side skill (`wiki-import-asd-memory`) reads the JSONL on demand. | Vault is single writer; uses `.raw/.manifest.json`. | Pull is on-demand; can lag. Requires operator to remember to run the import. | Adds a manual step the operator explicitly wants to remove. JSONL export remains a stable surface, so a puller can be added later by a vault-side operator without asd changes. |
| **C — Assisted in-project** | Interactive triage surface; writes go over MCP/IPC to a vault-side writer. | Vault single writer; `id` is dedup key. | Requires operator to triage every record; lower throughput. | Useful as a future per-record gate (see §4), not as the default path. |

Push and pull are not mutually exclusive — both consume the same JSONL.
Phase 1 ships push only; a pull-side companion can be added later by anyone
working in `~/vault`.

---

## §3 Phase-1 minimum slice

What ships:

1. **asd command: `memory push-wiki`.**
   - Default vault path: `~/vault` (override with `--vault` or
     `ASD_VAULT_ROOT` env).
   - Reads `<runtime-root>/exports/wiki-memory/reviewed-memory.jsonl` (the
     existing `asd.wiki_memory.v1` export). Re-runs `memory export-wiki`
     first if `--refresh` is passed.
   - For each record:
     - Compute target dir:
       `<vault>/wiki/projects/<sanitised project.key>/asd-learnings/`.
       Sanitiser strips `/`, `..`, leading dots; falls back to `unknown` if
       sanitisation empties the key.
     - Compute target file: `<id-without-sha256-prefix>.md`.
     - Compute `content_hash` over the rendered markdown body (frontmatter
       excluded). Skip write if `_asd-manifest.json` already records the
       same `content_hash` for this `id`.
     - Otherwise write the page (atomic write: temp file + rename) and
       update `_asd-manifest.json`.
   - Exits 0 with a "vault not present" notice if the vault path does not
     exist; exits non-zero only on partial writes (so launchd retries).
2. **Page frontmatter convention** (co-designed with `claude-obsidian:wiki-ingest`
   shape so the next vault session's autolink/log flow recognises asd pages
   as first-class wiki content):
   ```yaml
   ---
   id: sha256:...
   source: asd
   schema_version: asd.wiki_memory.v1
   project: <project.key>
   learning_id: <evidence.learning_id>
   promotion_basis: <evidence.promotion_basis>
   confidence: <review.confidence>
   review_source: <review.source>     # reviewed-export | deterministic-export
   created_at: <created_at>
   tags:
     - asd
     - asd/<project.key>
   source_refs:
     - source_path: ...
       source_hash: ...
       session_id: ...
       turn_id: ...
       line: ...
   ---
   ```
   Page body: the record's `title` as an H1, the record's `body` as the
   opening paragraph, then a "Source evidence" section rendering
   `evidence.evidence[]` as a bullet list. No backlinks to concepts/entities
   in phase 1 — vault sessions add those during their normal lint/autolink
   pass.
3. **Per-project manifest:** `_asd-manifest.json` next to the pages.
   ```json
   {
     "schema_version": "asd.vault_push_manifest.v1",
     "written_by": "asd",
     "last_push_at": "<iso>",
     "records": {
       "sha256:...": {
         "page": "<id>.md",
         "content_hash": "sha256:...",
         "written_at": "<iso>",
         "schema_version": "asd.wiki_memory.v1"
       }
     }
   }
   ```
   Strictly asd-owned. Vault sessions should treat it as read-only.
4. **CLAUDE.md amendment.** This repo's CLAUDE.md (and an op-note linking
   to the global CLAUDE.md update) carve out the named exception above.
5. **README + WIKI.md update.** README gains a "Push to vault" section
   pointing at `memory push-wiki`; WIKI.md notes the scoped write surface so
   anyone reading vault docs understands where asd-authored pages live.
6. **Smoke fixture.** `test/integration/push-wiki/` with a tiny JSONL input,
   an empty fixture vault dir under `/tmp`, and expected page + manifest
   output.

What does **not** ship in phase 1:

- No edits to `hot.md`, `index.md`, `log.md`, `.raw/.manifest.json`, or any
  vault path outside `wiki/projects/<key>/asd-learnings/`.
- No automatic launchd / cron job. The operator runs `memory push-wiki`
  manually or wires it into their own scheduler.
- No vault → asd backflow (no `superseded`/`rejected` reads).
- No per-record approval gate. Phase-2 hook (see §4).
- No deletion of vault pages whose source record disappeared. Phase 1 marks
  `deleted_at` in the manifest only; vault-session cleanup is a phase-2
  decision.

---

## §4 Phase-2 candidates (not in scope, listed so they don't accidentally creep into phase 1)

- **Schedule.** Launchd plist or operator cron wrapping
  `memory export-wiki && memory push-wiki`. Requires no asd code changes.
- **Per-record gate.** New `review.push_to_vault: boolean` on the export
  record; respected by `push-wiki`. Small addition to the export contract;
  bumps schema to `asd.wiki_memory.v1.1` (additive, backward-compatible).
  Unlocks Option C's per-record triage UX without building the IPC surface.
- **Vault-session cleanup of deleted records.** A vault-side skill that scans
  `_asd-manifest.json` entries with `deleted_at` and removes the corresponding
  page after a grace period.
- **Pull-side companion (Option B).** A vault-side `wiki-import-asd-memory`
  skill for operators who prefer pull on machines where `memory push-wiki`
  doesn't run. Push and pull can coexist.

---

## §5 Phasing and gates

| PR | Title | LAUNCH_CRITERIA gate | Depends on |
|---|---|---|---|
| **F2-A** | Vault push design note. Confirms the chosen frontmatter shape against `claude-obsidian:wiki-ingest`, locks the carve-out wording for CLAUDE.md, and probes `~/vault/wiki/projects/` for any existing collisions under the `asd-learnings/` subtree (read-only). | `vault-push-research` — proof: short note in `docs/research/` plus a CLAUDE.md amendment draft. | none. |
| **F2-B** | `memory push-wiki` command in asd. New module `src/pipeline/vault-push.ts` (no changes to `src/adapters/cursor/`, no changes to existing pipeline stages). README + WIKI.md updates. CLAUDE.md amendment landed (both repo-local and global). Smoke fixture under `test/integration/push-wiki/`. | `vault-push-phase-1` — proof: against a fixture vault dir under `/tmp`, `memory push-wiki` produces N pages where N == unique `id`s in the JSONL; rerun is a no-op (manifest skip); manifest co-validated against the page set; vault dir untouched outside `wiki/projects/<key>/asd-learnings/`. | F2-A. |

Both PRs land **in this repo**. No out-of-repo dependency for phase 1.

---

## What this plan deliberately does **not** do

- No changes to `asd.wiki_memory.v1` in phase 1. The contract in
  `docs/wiki-memory-export-contract.md` stays authoritative. The optional
  `review.push_to_vault` field is a phase-2 addition (would bump to v1.1
  additively).
- No re-opening of the four closed `td` review items.
- No writes to `~/vault` or `pi-llm-wiki-custom` from this design session;
  both were inspected read-only. Writes to `~/vault` only begin in PR F2-B,
  scoped to `wiki/projects/<project-key>/asd-learnings/`.
- No writes to `hot.md`, `index.md`, `log.md`, `.raw/.manifest.json`, or any
  vault path outside the scoped `asd-learnings/` subtree.
- No automatic scheduling (cron/launchd) in phase 1. `memory push-wiki` is
  operator-invoked.
- No dependency on the multi-adapter plan. Push works against today's
  Cursor-only data; new adapters silently grow pushed-page volume.

## Recommended model routing

- **PR F2-A:** Opus 4.7 — careful design + getting the CLAUDE.md amendment
  wording right.
- **PR F2-B:** Sonnet 4.6 — straightforward implementation against a known
  contract. Drop to Haiku for the smoke fixture.
