---
project: agent-session-distillery
owner: dallascrilley
last_reviewed: 2026-05-18
---

# Launch Criteria

This file defines the minimum proof required before `agent-session-distillery`
can be treated as launch-ready for v1 local Cursor transcript ingestion and
retention workflows.

## P0 - Launch blockers

- id: install-build-help
  feature: A new operator can install dependencies, build the CLI, and inspect command help.
  test: Run `npm install`, `npm run build`, and `node dist/cli.js --help` from a clean checkout.
  proof_required: Command transcript showing successful install, build, and help output.
  proof_level: B
  status: validated
  validated_on: 2026-05-18
  proof: /tmp/agent-session-distillery/2026-05-18_first-run/SUMMARY.md

- id: cursor-local-discovery
  feature: The CLI discovers local Cursor transcript files and workspace hints from the supported on-disk paths.
  test: Run a fixture-backed `node dist/cli.js ingest backfill --source cursor` with `HOME` and `AGENT_SESSION_DISTILLERY_ROOT` pointed at an isolated sandbox.
  proof_required: Command output plus runtime artifacts proving at least one transcript was discovered and attributed to a project key.
  proof_level: B
  status: validated
  validated_on: 2026-05-18
  proof: /tmp/agent-session-distillery/2026-05-18_first-run/SUMMARY.md

- id: ingest-review-explain
  feature: A discovered transcript can move through parse, reduce, summarize, extract, archive, review queue, and explain surfaces.
  test: Run fixture-backed ingest, then `node dist/cli.js review queue`, `node dist/cli.js review show <session-id>`, and `node dist/cli.js explain <session-id>`.
  proof_required: Command output and runtime paths for `summaries/by-session/<session-id>/`, `reviews/`, `archives/`, and `reports/`.
  proof_level: B
  status: validated
  validated_on: 2026-05-18
  proof: /tmp/agent-session-distillery/2026-05-18_first-run/SUMMARY.md

- id: deletion-readiness-safety
  feature: Deletion readiness is blocked unless summary, knowledge, manifest, and retention receipt artifacts exist.
  test: Run `node dist/cli.js archive run`, `node dist/cli.js delete candidates`, and dry-run `node dist/cli.js delete apply` against a sandbox containing ready and blocked fixture sessions.
  proof_required: Output showing ready and blocked deletion-candidate states, including blocked reasons and dry-run deletion behavior.
  proof_level: B
  status: blocking
  validated_on: null
  proof: null

- id: quality-audit-signal
  feature: Operators can audit summary, learning, and deletion-readiness quality across stored runtime artifacts.
  test: Run `node dist/cli.js quality audit --limit 100` against a sandbox with live-regression fixtures.
  proof_required: Audit output showing deletion-readiness counts, issue counts, recommendations, learning distribution metrics, and worst-session quality checks.
  proof_level: B
  status: blocking
  validated_on: null
  proof: null

- id: memory-export-reviewed
  feature: Reviewed memory records can be exported for downstream wiki ingestion without mutating deterministic project-learning originals.
  test: Run `node dist/cli.js quality apply-learning-review`, then `node dist/cli.js memory export-wiki` against a sandbox with reviewed project learnings.
  proof_required: Command output plus generated `knowledge/projects-reviewed/` and wiki export JSONL artifact paths.
  proof_level: B
  status: blocking
  validated_on: null
  proof: null

## P1 - Launch-week polish

- id: first-run-proof-doc
  feature: The README links to or summarizes the latest first-run proof artifact.
  test: After P0 proof is captured, update README or docs with the proof path and rerun `npm test`.
  proof_required: Commit or PR linking the proof artifact and passing test output.
  proof_level: C
  status: blocking
  validated_on: null
  proof: null

## P2 - Fast-follow

- id: background-agent-source-research
  feature: Remote-only Cursor background-agent chats have a researched source strategy.
  test: Document available source surfaces and constraints before implementing any adapter.
  proof_required: Research note or plan with verified source behavior.
  proof_level: C
  status: blocking
  validated_on: null
  proof: null
