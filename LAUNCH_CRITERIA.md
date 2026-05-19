---
project: agent-session-distillery
owner: dallascrilley
last_reviewed: 2026-05-18
version: 1.0.0
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
  status: validated
  validated_on: 2026-05-18
  proof: /tmp/agent-session-distillery/2026-05-18_deletion-readiness/SUMMARY.md

- id: quality-audit-signal
  feature: Operators can audit summary, learning, and deletion-readiness quality across stored runtime artifacts.
  test: Run `node dist/cli.js quality audit --limit 100` against a sandbox with live-regression fixtures.
  proof_required: Audit output showing deletion-readiness counts, issue counts, recommendations, learning distribution metrics, and worst-session quality checks.
  proof_level: B
  status: validated
  validated_on: 2026-05-18
  proof: /tmp/agent-session-distillery/2026-05-18_quality-audit/SUMMARY.md

- id: memory-export-reviewed
  feature: Reviewed memory records can be exported for downstream wiki ingestion without mutating deterministic project-learning originals.
  test: Run `node dist/cli.js quality apply-learning-review`, then `node dist/cli.js memory export-wiki` against a sandbox with reviewed project learnings.
  proof_required: Command output plus generated `knowledge/projects-reviewed/` and wiki export JSONL artifact paths.
  proof_level: B
  status: validated
  validated_on: 2026-05-18
  proof: /tmp/agent-session-distillery/2026-05-18_reviewed-memory-export/SUMMARY.md

## P1 - Launch-week polish

- id: first-run-proof-doc
  feature: The README links to or summarizes the latest first-run proof artifact.
  test: After P0 proof is captured, update README or docs with the proof path and rerun `npm test`.
  proof_required: Commit or PR linking the proof artifact and passing test output.
  proof_level: C
  status: validated
  validated_on: 2026-05-18
  proof: docs/launch-proof-index.md

## P2 - Fast-follow

- id: background-agent-source-research
  feature: Remote-only Cursor background-agent chats have a researched source strategy.
  test: Document available source surfaces and constraints before implementing any adapter.
  proof_required: Research note or plan with verified source behavior.
  proof_level: C
  status: validated
  validated_on: 2026-05-18
  proof: docs/research/background-agent-source-strategy.md

- id: vault-push-research
  feature: Vault push integration has a researched source strategy and a documented CLAUDE.md amendment draft before any code lands.
  test: Read docs/research/vault-push-source-strategy.md and docs/claude-md-amendment-draft.md; verify the probe results match the current state of ~/vault and the amendment target line exists in ~/.claude/CLAUDE.md.
  proof_required: Research note plus amendment draft, both committed.
  proof_level: C
  status: validated
  validated_on: 2026-05-18
  proof: docs/research/vault-push-source-strategy.md

- id: vault-push-phase-1
  feature: asd can push reviewed-memory records into the personal vault as Obsidian-shaped pages, scoped to wiki/projects/<key>/asd-learnings/.
  test: Against a fixture vault dir, run `node dist/cli.js memory push-wiki`. Verify (a) one page per unique record id, (b) rerun is a no-op via the manifest skip, (c) `--no-overwrite` preserves manual edits, (d) vault path missing exits 0 with a notice, (e) only the asd-learnings subtree is touched.
  proof_required: Unit tests plus integration test suite passing under `npm test`; live end-to-end run against a fixture vault dir.
  proof_level: B
  status: validated
  validated_on: 2026-05-18
  proof: test/vault-push-unit.test.mjs and test/integration/vault-push.test.mjs

- id: adapter-base-contract
  feature: Generic adapter helpers live in src/adapters/_common/ (hash, fs, jsonl, text-extract) and the Cursor adapter rewires to import them with zero behaviour change.
  test: Run `ingest backfill --source cursor` against the live-regression fixture on the refactored branch and on main; diff the runtime trees. Differences must be limited to wall-clock timestamps and fixture-HOME paths.
  proof_required: Side-by-side diff of pre- and post-refactor runtime trees showing byte-identical summaries/knowledge content; `npm test` 97/97 passing.
  proof_level: B
  status: validated
  validated_on: 2026-05-18
  proof: /tmp/agent-session-distillery/2026-05-18_f1a-adapter-base-contract/SUMMARY.md

- id: claude-code-adapter-source-research
  feature: The Claude Code adapter has a researched source strategy citing real on-disk paths and a documented classifier strategy before any code lands.
  test: Read docs/research/claude-code-source-strategy.md; verify the cited paths resolve on this machine and the classifier table covers all probed type values.
  proof_required: Research note checked in, citing real on-disk paths.
  proof_level: C
  status: validated
  validated_on: 2026-05-18
  proof: docs/research/claude-code-source-strategy.md

- id: claude-code-adapter
  feature: asd ingests local Claude Code transcripts via `ingest backfill --source claude-code` end-to-end through every pipeline phase.
  test: Run `node dist/cli.js ingest backfill --source claude-code` against the smoke fixture at test/fixtures/claude-code/projects/. Verify at least one session is discovered, parsed, summarised, has a learning extracted, and is archived with a deletion candidate state.
  proof_required: Unit tests (workspace-map, discover, parse) plus integration test (ingest-backfill via CLI subprocess) passing under `npm test`; live end-to-end run against the fixture HOME.
  proof_level: B
  status: validated
  validated_on: 2026-05-18
  proof: /tmp/agent-session-distillery/2026-05-18_f1c-claude-code-adapter/SUMMARY.md

- id: codex-cli-adapter-source-research
  feature: The Codex CLI adapter has a researched source strategy citing real on-disk paths, two-level type discriminator decoding, and a documented classifier strategy before any code lands.
  test: Read docs/research/codex-cli-source-strategy.md; verify the cited paths resolve on this machine and the composite-key classifier table covers all probed type/payload.type combinations.
  proof_required: Research note checked in, citing real on-disk paths and the two-level discriminator joins.
  proof_level: C
  status: validated
  validated_on: 2026-05-18
  proof: docs/research/codex-cli-source-strategy.md

- id: codex-cli-adapter
  feature: asd ingests local Codex CLI rollouts via `ingest backfill --source codex-cli` end-to-end through every pipeline phase, decoding the two-level type/payload.type discriminator.
  test: Run `node dist/cli.js ingest backfill --source codex-cli` against the smoke fixture at test/fixtures/codex-cli/sessions/. Verify the session is discovered, parsed (9 records with composite rawType strings), summarised, has a learning extracted, and is archived with a deletion candidate state.
  proof_required: Unit tests (workspace-map, discover, parse) plus integration test (ingest-backfill via CLI subprocess) passing under `npm test`; live end-to-end run against the fixture HOME.
  proof_level: B
  status: validated
  validated_on: 2026-05-18
  proof: /tmp/agent-session-distillery/2026-05-18_f1e-codex-cli-adapter/SUMMARY.md
