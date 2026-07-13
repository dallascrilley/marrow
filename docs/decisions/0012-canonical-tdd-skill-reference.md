# 0012. Canonical TDD skill reference

- **Status:** accepted
- **Date:** 2026-07-13

## Context

Extraction attributed test commands to `tdd-guide`, an agent definition rather than a
Hub-installed skill. The resulting high-volume `skill_ref` could not be resolved by
`asd skill report`, so adherence evidence was not actionable.

## Decision

Map deterministic test-command evidence to the Hub skill id `tdd`. `tdd` is the
installed Test-Driven Development skill; it owns test-first guidance and is the
reportable runtime surface. Do not create a duplicate `tdd-guide` skill or modify
the separate agent definition.

## Consequences

New and re-extracted learnings carry `skill_ref: ["tdd"]`, making `asd skill report tdd`
resolvable. Existing historical `tdd-guide` records remain provenance and can be
migrated only through an explicit re-extraction or backfill operation.
