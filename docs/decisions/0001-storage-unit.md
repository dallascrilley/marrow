# ADR-0001: Primary storage unit — atomic instinct vs session learning

- Date: 2026-05-19
- Status: accepted (2026-05-19)
- Deciders: operator

## Context

marrow today stores one "learning" per reviewed session. The output of the
ingest+review pipeline is a markdown blob per session, filed to the
vault under `marrow-learnings/`. Manifests track session IDs; review state
is binary (pending/approved).

The landscape survey (ECC continuous-learning-v2, lamarck) converges
on a finer unit. ECC stores **atomic "instincts"** (one observation =
one YAML record, scored 0.3–0.9). Lamarck stores **bullets** in
`playbook.yaml` with lifecycle states (candidate → established →
proven → deprecated). Both treat a session as a *bundle* of atomic
units, not a unit.

Atomic units unlock dedup, promotion across sessions/projects, decay,
clustering, and a meaningful confidence model. Session blobs do not.

This choice is foundational: it touches the schema, manifests, review
flow, vault push, the MCP server's primary query target, and the
cross-project promotion feature. It must be settled before the
atomic-instinct schema work (see `docs/specs/atomic-instinct-schema.md`).

## Options

### Option A — Atomic instinct as primary unit (recommended)

Storage is one YAML record per observation. Schema:

```yaml
id: <slug>           # stable, derived from content hash
trigger: <text>      # what situation this applies to
finding: <text>      # the lesson
confidence: 0.3..0.9
domain: <enum>       # code-style|testing|git|debugging|workflow|…
source:
  session_id: <id>
  source_refs: [...]
scope: project|global
project_id: <id>
maturity: candidate|established|proven|deprecated
created_at, updated_at
```

Session learnings exist as *bundles* (a list of instinct IDs +
narrative diary). They are an audit trail, not the primary store.

### Option B — Session learning blob as primary unit (status quo)

Keep the current model. Add fields to the blob (confidence at the
blob level, file refs, etc.) but no atomic decomposition.

### Option C — Hybrid: blob is canonical, atomic view derived

Keep blobs as the canonical store. Run a derivation pass that
extracts atomic records into a *secondary* index for MCP / promotion.
Blob remains the source of truth.

## Tradeoffs

| Aspect | A (atomic) | B (blob) | C (hybrid) |
|---|---|---|---|
| Dedup across sessions | Natural | Hard | OK in derived index |
| Cross-project promotion | Natural | Hard | OK in derived index |
| Decay / confidence math | Per record | Coarse | Per record in index |
| MCP search granularity | High | Low | High |
| Migration cost | High | Zero | Medium |
| Current code reuse | Low | Full | High |
| Authoring complexity in review pass | Higher | Same | Higher (must emit both) |
| Auditability of LLM outputs | Worse (atomized) | Best | Best (blob preserved) |

The argument for A is strong on every downstream feature (MCP,
promotion, decay, evolution). The argument for B is "we already
have it." Argument for C is "preserve LLM-output auditability while
gaining the indexing benefits."

## Recommendation

**Option A.** The downstream features in the v2 epic (MCP server,
cross-project promotion, maturity ladder, skill-adherence analysis)
all assume an atomic primary unit. Building B and then bolting C on
afterwards is the worst of the three paths: migration cost paid twice.

If LLM-output auditability is the concern that pushes toward C, the
review-pass output format from lamarck (diary + deltas) gives us
the same auditability inside the atomic model. The diary lives as a
session-level artifact; the deltas are how the atomic store is updated.

## Decision

**Accepted: Option A — atomic instinct as primary unit.**

Every downstream v2 feature (MCP server, cross-project promotion,
maturity ladder, skill-adherence analysis) assumes an atomic primary
unit. Building the blob model first and bolting atomicity on later
pays the migration cost twice. LLM-output auditability — the strongest
argument for keeping blobs canonical — is preserved by the diary +
deltas review pass output format described in the schema spec: the
diary is the human-readable session-level artifact, the deltas are
how the atomic store is updated, and the immutable session bundle
file is the audit trail.

Implementation lands per `docs/specs/atomic-instinct-schema.md` and
the type sketches at `src/v2/instinct/schema.ts`.

## Consequences

If A:

- The atomic-instinct schema work designs the atomic record.
- Migration: write a one-shot pass that parses existing
  marrow-learnings markdown into atomic records. Acceptable to leave
  pre-v2 sessions as blob-only with no atomic decomposition.
- Review pass output format becomes diary + deltas (ADR-adjacent
  decision; not blocking but related).
- Vault renderers (curated `MEMORY.md`, individual learnings)
  become *views* on the atomic store.

If B or C:

- Several downstream tasks in the v2 epic need rescoping.
- Reopen this ADR when promotion or MCP search precision becomes
  the bottleneck.
