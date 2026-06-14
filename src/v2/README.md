# src/v2 — atomic instinct model

Implementation of ADR-0001 (storage), ADR-0002 (project id), and ADR-0003
(curated MEMORY.md). v1 pipeline code imports these modules at integration
points (discover, learning-review apply, memory push-wiki).

## Layout

- `project/resolve.ts` — ADR-0002 project id resolution
- `instinct/` — atomic instinct store, bundles, YAML I/O, learning bridge
- `vault/render-memory.ts` — curated MEMORY.md + topic spill files
- `learning/sync-reviewed.ts` — hook from quality apply → bundles + replay
- `math/decay.ts` — confidence decay and maturity proposals
- `mcp/types.ts` — forward-declared MCP tool shapes (ADR-0005, not wired)

## Status

Accepted: ADR-0001–0004 (storage, project id, MEMORY render, vault carve-out).
`memory push-wiki` writes v1 pages via `pipeline/vault-push.ts` and v2 rollup
via `vault/render-memory.ts` — both hardcode carve-out paths only.

Deferred: MCP server (0005), promotion queue (0006).
