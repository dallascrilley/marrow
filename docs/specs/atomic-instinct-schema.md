# Atomic Instinct Schema

- Date: 2026-05-19
- Status: accepted (ADR-0001, 2026-05-19)
- Related: [ADR-0001](../decisions/0001-storage-unit.md)

This is the concrete schema proposal for v2's atomic storage unit.
Field shapes, validation rules, and migration story. No
implementation here; implementation lands separately in the v2
instinct store.

## File layout

Per-project storage at `~/.marrow/instincts/<project-id>/`:

```
<project-id>/
├── instincts/
│   ├── <instinct-id>.yaml      # one instinct per file
│   └── …
├── sessions/
│   ├── <session-id>.yaml       # bundle: which instincts came from this session
│   └── …
├── manifest.json                # tracks ingest state per source
└── promote-queue.json           # ADR-0006: pending promotions
```

Global tier (after promotion):

```
~/.marrow/instincts-global/
└── <instinct-id>.yaml
```

The vault renderers (curated MEMORY.md, marrow-learnings/) write to
`~/vault/` and are pure functions of the instinct store. Audit trail
preserved by the immutable session bundle files.

## Instinct record

```yaml
# ~/.marrow/instincts/<project-id>/<instinct-id>.yaml
schema_version: 1
id: trust-pnpm-over-npm-in-this-project
trigger: |
  When installing or running packages in this project.
finding: |
  Use pnpm. npm lockfile produces drift with the rest of the team's
  pnpm-workspace setup; CI fails on `npm install`.
confidence: 0.85
domain: tooling
maturity: established
scope: project
project_id: a3f9c1b2d4e5
source:
  first_session: ses_2026-05-12-a3f9
  first_observed_at: 2026-05-12T14:23:01Z
  source_refs:
    - kind: file
      path: package.json
      session: ses_2026-05-12-a3f9
    - kind: file
      path: pnpm-workspace.yaml
      session: ses_2026-05-12-a3f9
  observations:
    - session: ses_2026-05-12-a3f9
      reinforcing: true
      at: 2026-05-12T14:23:01Z
    - session: ses_2026-05-14-b8d2
      reinforcing: true
      at: 2026-05-14T09:11:44Z
    - session: ses_2026-05-16-c7e1
      reinforcing: false
      correction: |
        Tried npm — CI failed. Switched to pnpm.
      at: 2026-05-16T16:02:18Z
related:
  - prefer-corepack-pin
created_at: 2026-05-12T14:23:01Z
updated_at: 2026-05-16T16:02:18Z
last_promoted_at: null
```

### Field reference

| Field | Required | Type | Rationale |
|---|---|---|---|
| `schema_version` | yes | int | Forward-compat. Bump on breaking changes. |
| `id` | yes | string (kebab) | Stable across machines. Derived from content hash + slug. See "ID generation" below. |
| `trigger` | yes | string | When this matters. Phrased as a situation, not a rule. |
| `finding` | yes | string | The lesson. Phrased as a recommendation. |
| `confidence` | yes | float `[0.3, 0.9]` | ECC v2 range. 0.3 = tentative, 0.9 = near-certain. |
| `domain` | yes | enum | `code-style \| testing \| git \| debugging \| workflow \| tooling \| security \| performance \| product`. Constrained for the curated MEMORY.md grouping (ADR-0003). |
| `maturity` | yes | enum | `candidate \| established \| proven \| deprecated` (lamarck lifecycle). |
| `scope` | yes | enum | `project \| global`. Determines storage location. |
| `project_id` | yes | string | Per ADR-0002 chain. Empty string when `scope: global` and promoted. |
| `source.first_session` | yes | string | First session that produced this instinct. |
| `source.first_observed_at` | yes | ISO 8601 | Source of truth for age. |
| `source.source_refs[]` | yes | list | File / function / command refs. Existing marrow shape. |
| `source.observations[]` | yes | list | Append-only event log. Drives decay/confidence math. |
| `related[]` | no | list of ids | Soft links between instincts. |
| `created_at` | yes | ISO 8601 | Record creation. |
| `updated_at` | yes | ISO 8601 | Last write. |
| `last_promoted_at` | no | ISO 8601 | Set when promoted to global. |

### ID generation

```
slug   = kebab(first 8 words of finding, deduped)
hash   = sha256(trigger + "|" + finding).hex[:8]
id     = slug + "-" + hash  →  trust-pnpm-over-npm-in-this-project-a3f9c1b2
```

Truncate to 80 chars total. The hash suffix lets us detect "near
duplicates" (same slug, different hash) and prompt for merge.

## Session bundle

```yaml
# ~/.marrow/instincts/<project-id>/sessions/<session-id>.yaml
schema_version: 1
session_id: ses_2026-05-19-d8f1
project_id: a3f9c1b2d4e5
source_adapter: cursor
source_transcript: /Users/.../agent-transcripts/2026-05-19-d8f1.jsonl
ingested_at: 2026-05-19T22:15:08Z
reviewed_at: 2026-05-19T22:18:42Z
reviewer: openrouter:claude-haiku-4-5
diary: |
  This session focused on the v2 ADR set. Operator asked to ground
  the design in the prior-art landscape report. Key tension surfaced:
  whether to adopt ECC's auto-promotion or keep a manual queue. We
  landed on auto-suggest + manual approve.
deltas:
  - op: reinforce
    instinct_id: trust-pnpm-over-npm-in-this-project-a3f9c1b2
    delta: { confidence: +0.05 }
  - op: create
    instinct_id: write-adrs-before-schema-refactor-9c2f8b04
    initial_confidence: 0.6
    domain: workflow
  - op: deprecate
    instinct_id: review-state-binary-pending-approved-1a0b8e72
    reason: superseded by maturity ladder
extraction_cost:
  model: anthropic/claude-haiku-4-5
  input_tokens: 18402
  output_tokens: 1284
  usd: 0.012
```

The bundle is **immutable once `reviewed_at` is set.** It is the audit
trail demanded by ADR-0001's recommendation. The instinct store is a
fold of the bundle stream.

## Maturity transitions

```
candidate     (just created, confidence ≥ 0.3 < 0.6)
   ↓
established   (confidence ≥ 0.6, age ≥ 7 days, ≥2 reinforcements)
   ↓
proven        (confidence ≥ 0.8, age ≥ 30 days, ≥5 reinforcements,
               surviving ≥1 contradicting observation that was
               re-confirmed)
   ↓
deprecated    (confidence < 0.3 after decay, OR explicit deprecate op)
```

Decay function: exponential, **90-day half-life**. Each observation
contributes a weighted delta:

- `reinforcing: true` → `+0.04 * decay_factor(age_days)`
- `reinforcing: false` (i.e., a correction) → `-0.16 * decay_factor(age_days)`
  (lamarck's 4× harmful multiplier)
- No observations in 90 days → confidence decays toward 0.3 floor.

`confidence` is recomputed at every ingest from the observation log,
not stored as a writable field. The YAML's `confidence` is the
cached value; the observation log is canonical.

## Validation rules

1. `id` must match `^[a-z0-9-]{8,80}$` and end in 8 hex chars.
2. `confidence` clamped to `[0.3, 0.9]`.
3. `domain` must be in the enum.
4. `maturity: deprecated` blocks all observations from changing
   confidence (manual `revive` op required).
5. `scope: global` requires `last_promoted_at` set; project_id empty.
6. `source.observations` is append-only; existing entries cannot
   be edited.
7. `related[]` must reference existing instinct IDs (project or
   global).
8. Bundle deltas must reference instincts that exist before the
   bundle is replayed (except `op: create`).

## Migration from session-learning blobs

One-shot migration script `marrow migrate v1-to-v2`:

1. Walk `~/vault/wiki/projects/<old-key>/marrow-learnings/*.md`.
2. For each markdown file, parse frontmatter + body.
3. Use the LLM review path (Haiku) to decompose each blob into
   atomic instinct candidates. Output as a bundle file with all
   `op: create` deltas, no reinforcements.
4. Set `source.first_session` from frontmatter, `first_observed_at`
   from the original ingest timestamp.
5. Initial maturity: `candidate`. Initial confidence: `0.5` (above
   floor, below establishing threshold).
6. Write to `instincts/<new-project-id>/` per ADR-0002 ID resolution.
7. Leave the original blobs in place (audit trail).
8. Emit `_v1-to-v2-migration.json` mapping report at the project
   root for the operator to audit.

Migration is idempotent: re-running checks for already-migrated blobs
via a `_migrated_from_blob_id` field stored on each instinct.

## Open items

- **Diary format.** Free-text per session is fine for v1. If we
  later want diaries searchable, normalize to a short structured
  format. Deferring.
- **Cross-instinct merge ops.** When the LLM proposes two instincts
  with near-identical findings, what's the merge ceremony? Probably
  a `op: merge` delta with `into:` field. Stub now, design later.
- **Garbage collection.** `deprecated` instincts: keep forever for
  audit, or compact after N months? Compaction would write a
  `_tombstone.yaml` per removed instinct.
- **Conflict resolution** when the operator's two machines write
  divergent `confidence` values to the same global instinct. Likely:
  pick the higher `updated_at`, log a warning. Defer until sync
  becomes real.

## Test surface

Schema v1 acceptance tests required before the v2 instinct store merges:

1. Round-trip: emit YAML, parse YAML, compare.
2. Validation rule coverage (one negative test per rule above).
3. Maturity transition state machine (every legal transition + a
   sampling of illegal ones).
4. Decay math: known observation log → expected confidence at known
   replay time.
5. Bundle replay produces deterministic instinct store from a fresh
   start.
6. Migration: golden v1 blob set → expected v2 instinct set.

Test fixtures live at `test/fixtures/v2/`; see fixture README.
