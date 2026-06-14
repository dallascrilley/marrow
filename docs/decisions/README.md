# Architecture Decision Records

Each ADR captures one significant choice. Status flow:
`proposed` → `accepted` or `rejected` → `superseded` (by ADR-N).

Format adapted from Michael Nygard. Sections:

- **Context** — what's true, what's at stake, what forces the decision.
- **Options** — at least two real alternatives.
- **Tradeoffs** — what each option buys and costs.
- **Recommendation** — author's call with reasoning.
- **Decision** — operator-filled. Authoritative.
- **Consequences** — what changes, what to revisit, when.

ADRs are immutable once accepted. Superseding requires a new ADR.

## Index

- [0001-storage-unit](0001-storage-unit.md) — atomic instinct vs session learning as primary unit
- [0002-project-id](0002-project-id.md) — project ID strategy
- [0003-primary-render](0003-primary-render.md) — MEMORY.md vs asd-learnings/ as primary render
- [0004-carve-out-boundary](0004-carve-out-boundary.md) — vault carve-out scope for MEMORY.md
- [0005-mcp-surface](0005-mcp-surface.md) — MCP tool surface cap
- [0006-promotion-thresholds](0006-promotion-thresholds.md) — cross-project promotion thresholds
- [0007-daemon-llm-separation](0007-daemon-llm-separation.md) — cheap pipeline gate before LLM passes
