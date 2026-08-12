# Changelog

All notable changes to `marrow` are documented here.
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-05-18

First launch-ready release for local Cursor transcript ingestion.

### Launch proof

All P0 and P1 launch gates in `LAUNCH_CRITERIA.md` are validated. The
operator-facing index is at [`docs/launch-proof-index.md`](docs/launch-proof-index.md).

### Capabilities

- Discover local Cursor transcripts from `~/.cursor/projects/<workspace>/agent-transcripts/`
  with workspace-hint based attribution.
- Drive each discovered transcript through `parsed`, `reduced`, `summarized`,
  `extracted`, `archived`, and `deletion_candidate` lifecycle phases.
- Generate `summary.json`, `summary.md`, deterministic project-learning JSONL,
  user-learning JSONL, immutable provenance manifests, and retention receipts.
- Audit summary, learning, and deletion-readiness quality with
  `quality audit`.
- Optional OpenRouter-gated LLM review of deterministic project learnings with
  `quality review-learnings`, idempotent against a content-keyed cache.
- Apply reviewed learnings as a non-mutating `knowledge/projects-reviewed/`
  sidecar with `quality apply-learning-review`.
- Export reviewed memory records for downstream wiki ingestion with
  `memory export-wiki`, contract documented in
  [`docs/wiki-memory-export-contract.md`](docs/wiki-memory-export-contract.md).
- Single-command local memory-value loop with `npm run memory:pipeline:dry-run`.
- Safe-by-default deletion: `delete apply` is a dry run unless `--apply` is
  passed, and a session is only marked safe to delete when all required
  artifacts exist.

### Out of scope for v1

- Cursor background-agent chats (remote-only). Source strategy is researched
  in [`docs/research/background-agent-source-strategy.md`](docs/research/background-agent-source-strategy.md).
