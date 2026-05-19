# src/v2 — forward-declared v2 surface

Staging area for the v2 refactor (td-839bd1 and downstream). Files
here are pure types and reference math. They are not yet imported
by any v1 code path. Their job is to make the v2 work a translation
problem instead of a design problem.

## Contents

- `instinct/schema.ts` — Zod schemas + TS types for the atomic
  instinct, observation, session bundle, and delta records described
  in `docs/specs/atomic-instinct-schema.md`.
- `mcp/types.ts` — Input/output type signatures for the three MCP
  tools capped by ADR-0005.
- `math/decay.ts` — Pure functions for the confidence decay /
  maturity transition logic described in the schema spec. Unit-
  testable in isolation.

## Why staged

The v2 epic touches the storage unit (foundational). Landing types
and pure math first lets us:

1. Catch schema disagreements before they become migration bugs.
2. Unit-test the decay math without any I/O or runtime root.
3. Have a stable target the eventual implementation imports from
   instead of inventing on the fly.

When the implementation lands, `src/v2/` becomes the source of truth
for the new model. v1 code is migrated in place.

## Status

Pending ADR-0001 acceptance. Do not import from production code.
