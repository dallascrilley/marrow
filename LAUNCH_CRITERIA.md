---
project: agent-session-distillery
owner: dallascrilley
last_reviewed: 2026-07-09
version: 1.3.0
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
  test: Run `node dist/cli.js archive run`, `node dist/cli.js delete candidates`, and dry-run `node dist/cli.js delete sources --source codex-cli` against a sandbox containing ready and blocked fixture sessions.
  proof_required: Output showing ready and blocked deletion-candidate states, including blocked reasons and dry-run raw-archive deletion behavior.
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
  test: Run `node dist/cli.js quality apply-learning-review --batch <batch-path>`, then `node dist/cli.js memory export-wiki` against a sandbox with reviewed project learnings.
  proof_required: Command output plus generated `knowledge/projects-reviewed/` and wiki export JSONL artifact paths.
  proof_level: B
  status: validated
  validated_on: 2026-05-18
  proof: /tmp/agent-session-distillery/2026-05-18_reviewed-memory-export/SUMMARY.md

- id: review-apply-exactly-once
  feature: Reviewed-memory application is bound to an immutable batch, repeated application is a stable no-op, and interrupted application converges through an append-only ledger.
  test: Run `node scripts/proof-review-apply-exactly-once.mjs --live` with the OpenRouter credential sourced from the operator secret store.
  proof_required: Duplicate output hashes and timestamps, a skipped-generation no-change snapshot, failed/retry ledger transitions, and a one-learning live batch with count and spend caps.
  proof_level: B
  status: validated
  validated_on: 2026-07-09
  proof: docs/ops/proofs/2026-07-09-review-apply-exactly-once.md

## P1 - Launch-week polish

- id: parsed-staging-retention
  feature: Safe parsed intermediates are removed after durable archive promotion, and scheduled fallback retention enforces age and byte ceilings without depending on LLM review output.
  test: Run `npm test` — `test/integration/ingest-lifecycle.test.mjs`, `test/parsed-cleanup.test.mjs`, and `test/scheduled-memory-pipeline.test.mjs` cover immediate deletion, unsafe retention, oldest-first byte pressure, and review-independent scheduling.
  proof_required: Passing integration tests showing only exact `parsed-records.json` files with safe deletion candidates are removed while reduced sessions and durable outputs remain.
  proof_level: B
  status: validated
  validated_on: 2026-07-13
  proof: test/integration/ingest-lifecycle.test.mjs, test/parsed-cleanup.test.mjs, test/scheduled-memory-pipeline.test.mjs

- id: external-staging-storage
  feature: Parsed and reduced intermediates can use a pre-created external filesystem without moving the durable control plane or weakening cleanup recovery.
  test: Run `storage migrate-staging` dry-run/apply against an isolated runtime and `/Volumes/SSK`, cut over with `AGENT_SESSION_DISTILLERY_STAGING_ROOT`, exercise inventory and cleanup, make the proof root temporarily unavailable, then restore it.
  proof_required: Matching source/destination hashes and different device IDs; local migration receipt; external inventory; nonzero absent-root reader; successful rollback; source intact; proof root removed.
  proof_level: B
  status: validated
  validated_on: 2026-07-18
  proof: docs/ops/proofs/2026-07-18-external-staging-storage.md

- id: emulo-profile-evidence-bridge
  feature: ASD publishes a private, versioned user-message corpus that the private Emulo mirror can validate without reparsing raw logs or starting model work.
  test: Run `node dist/cli.js profile export-emulo` against an isolated reduced-session fixture, then run private Emulo `plugin preflight --source asd --preview` against the same runtime root.
  proof_required: One accepted session, expected user-message count, no assistant prose in the generation, an Emulo approval hash, and no Emulo `runs/` directory.
  proof_level: B
  status: validated
  validated_on: 2026-07-17
  proof: docs/recipes/emulo-profile-bridge.md and /tmp/asd-emulo-bridge-proof.q8upxA/

- id: first-run-proof-doc
  feature: The README links to or summarizes the latest first-run proof artifact.
  test: After P0 proof is captured, update README or docs with the proof path and rerun `npm test`.
  proof_required: Commit or PR linking the proof artifact and passing test output.
  proof_level: C
  status: validated
  validated_on: 2026-05-18
  proof: docs/launch-proof-index.md

- id: session-index-export
  feature: `export-index` writes valid `asd.session_index.v1` JSONL from manifests and summaries.
  test: Run `node dist/cli.js export-index` against a sandbox with at least one archived session manifest and summary pair.
  proof_required: JSONL export path plus records validating schema version, topic, topic_source, and absolute summary paths.
  proof_level: B
  status: validated
  validated_on: 2026-05-23
  proof: test/cli.test.mjs (export-index test)

- id: llm-topic-low-signal-gate
  feature: `--llm-topic` rescues low-signal deterministic topics on ingest/resummarize without breaking core ingest.
  test: Run `npm test` — `test/summarize.test.mjs` optional LLM topic cases and `isLowSignalTopic` regression fixtures (wrapper leaks, bare skill slugs).
  proof_required: Passing unit tests showing low-signal detection and LLM fail-safe fallback.
  proof_level: B
  status: validated
  validated_on: 2026-05-23
  proof: test/summarize.test.mjs

- id: resummarize-corpus-upgrade
  feature: Operators can upgrade topics for archived sessions without mutating immutable manifests.
  test: Run `node dist/cli.js quality resummarize --session-id <id>` against a fixture with a low-signal topic; verify summary.json topic changes and manifest bytes are unchanged. Bulk path: `npm run corpus:resummarize:dry-run` then `npm run corpus:resummarize`.
  proof_required: Passing `test/resummarize.test.mjs`, `test/cli.test.mjs`, and `test/resummarize-corpus.test.mjs` plus command output showing processed_count and unchanged manifest hash.
  proof_level: B
  status: validated
  validated_on: 2026-05-23
  proof: test/resummarize.test.mjs, test/cli.test.mjs (quality resummarize CLI), test/resummarize-corpus.test.mjs

- id: session-index-no-wrapper-topics
  feature: Session index topics exclude bare skill slugs and wrapper-only harness text (e.g. `brainstorming`, `whats-next`).
  test: Run `npm test` — `test/summarize.test.mjs` and `test/resummarize.test.mjs` assert `isLowSignalTopic` rejects bare slugs and `summarizeSession` skips skill-wrapper-only prompts.
  proof_required: Passing unit tests with wrapper-leak regression fixtures from issue #16.
  proof_level: B
  status: validated
  validated_on: 2026-05-23
  proof: test/summarize.test.mjs, test/resummarize.test.mjs

- id: ingest-batch-resilience
  feature: Per-session ingest failures do not abort an entire backfill batch.
  test: Run `npm test` — `test/ingest-backfill-isolation.test.mjs`.
  proof_required: Passing test showing failures array populated while batch completes.
  proof_level: B
  status: validated
  validated_on: 2026-05-23
  proof: test/ingest-backfill-isolation.test.mjs

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

- id: pi-adapter-source-research
  feature: The Pi adapter has a researched source strategy citing real on-disk paths, role-nested message classifier handling, and the documented tool-call-block strategy before any code lands.
  test: Read docs/research/pi-source-strategy.md; verify the cited paths resolve on this machine and the classifier covers all probed type values plus the role-branching for message records.
  proof_required: Research note checked in, citing real on-disk paths and the message.role classifier branch.
  proof_level: C
  status: validated
  validated_on: 2026-05-18
  proof: docs/research/pi-source-strategy.md

- id: pi-adapter
  feature: asd ingests local Pi (Zosma) session JSONL files via `ingest backfill --source pi` end-to-end, branching message records by message.role into user/assistant/toolResult kinds.
  test: Run `node dist/cli.js ingest backfill --source pi` against the smoke fixture at test/fixtures/pi/sessions/. Verify the session is discovered, parsed (7 records covering session/model_change/thinking_level_change/custom_message/message-user/message-assistant/message-toolResult), summarised, has a learning extracted, and is archived.
  proof_required: Unit tests (workspace-map, discover, parse) plus integration test (ingest-backfill via CLI subprocess) passing under `npm test`; live end-to-end run against the fixture HOME.
  proof_level: B
  status: validated
  validated_on: 2026-05-18
  proof: /tmp/agent-session-distillery/2026-05-18_f1g-pi-adapter/SUMMARY.md

- id: kimi-adapter-source-research
  feature: The Kimi adapter has a researched source strategy citing real on-disk paths, wire.jsonl classifier handling, and the documented MD5 workspace-path mapping strategy before any code lands.
  test: Read docs/research/kimi-source-strategy.md; verify the cited paths resolve on this machine and the classifier covers all probed type values (TurnBegin, ContentPart, ToolCall, ToolResult).
  proof_required: Research note checked in, citing real on-disk paths and the wire.jsonl classifier table.
  proof_level: C
  status: validated
  validated_on: 2026-05-27
  proof: docs/research/kimi-source-strategy.md

- id: kimi-adapter
  feature: asd ingests local Kimi (Kimi Code CLI) wire.jsonl files via `ingest backfill --source kimi` end-to-end, mapping TurnBegin/ContentPart/ToolCall/ToolResult records into user/assistant/tool kinds.
  test: Run `node dist/cli.js ingest backfill --source kimi` against the smoke fixture at test/fixtures/kimi/sessions/. Verify the session is discovered, parsed, summarised, has a learning extracted, and is archived.
  proof_required: Unit tests (workspace-map, discover, parse) plus integration test (ingest-backfill via CLI subprocess) passing under `npm test`; live end-to-end run against the fixture HOME.
  proof_level: B
  status: validated
  validated_on: 2026-05-27
  proof: test/integration/kimi-ingest.test.mjs, test/kimi-discover.test.mjs, test/kimi-parse-transcript.test.mjs, test/kimi-workspace-map.test.mjs

- id: session-end-hook
  feature: Operators can install a Claude Code SessionEnd hook that triggers asd ingest after each session.
  test: Run `npm test` — `test/hooks-install.test.mjs`. Operator smoke: `node dist/cli.js hooks install --dry-run` in a project checkout.
  proof_required: Passing hook install/merge tests plus unattended-loop proof showing hook dry-run and ingest chain exit 0.
  proof_level: B
  status: validated
  validated_on: 2026-06-14
  proof: test/hooks-install.test.mjs, /tmp/agent-session-distillery/2026-06-14_unattended-loop/SUMMARY.md

- id: pipeline-gate
  feature: Operators can run cheap pipeline gates before LLM-bound review passes (pending ingest, unreviewed learnings, sliding-window budget).
  test: Run `npm test` — `test/pipeline-gate.test.mjs`, `test/llm-budget.test.mjs`. Operator smoke: `node dist/cli.js pipeline gate --max-per 5/24h`.
  proof_required: Passing gate/budget unit tests; scheduled script calls gate; ADR-0007 accepted.
  proof_level: B
  status: validated
  validated_on: 2026-06-14
  proof: test/pipeline-gate.test.mjs, test/llm-budget.test.mjs, docs/decisions/0007-daemon-llm-separation.md

- id: skill-adherence-report
  feature: Operators can list skill mentions in the exported session index and score checklist adherence per skill.
  test: Run `npm test` — `test/skill-report.test.mjs`. Operator smoke: `node dist/cli.js skill evidence <skill-id>` and `node dist/cli.js skill report <skill-id>` after `export-index`.
  proof_required: Passing adherence/evidence unit tests plus operator recipe documenting the workflow.
  proof_level: B
  status: validated
  validated_on: 2026-06-14
  proof: test/skill-report.test.mjs, docs/recipes/skill-adherence-report.md

- id: quality-audit-topic-distribution
  feature: Operators can rank corpus topic quality per project and get resummarize remediation hints.
  test: Run `npm test` — `test/quality-audit.test.mjs` topic-distribution case. Operator smoke: `node dist/cli.js quality audit --topic-distribution`.
  proof_required: Passing aggregation test showing low-signal rate, wrapper-leak count, LLM rescue coverage, and remediation commands.
  proof_level: B
  status: validated
  validated_on: 2026-06-14
  proof: test/quality-audit.test.mjs

## P0 — v2 launch blockers (atomic instincts + vault render)

- id: v2-instinct-yaml-roundtrip
  feature: Atomic instinct records round-trip through YAML serialization and schema validation.
  test: Run `npm test` — `test/v2-instinct-store.test.mjs` and related schema tests.
  proof_required: Passing unit tests for emit/parse and store prune behavior.
  proof_level: B
  status: validated
  validated_on: 2026-05-22
  proof: test/v2-instinct-store.test.mjs

- id: v2-project-id-resolution
  feature: Project IDs resolve per ADR-0002 (git-remote hash with path-hash fallback).
  test: Run `npm test` — `test/v2-project-id.test.mjs`.
  proof_required: Passing tests covering git-remote, declared-key, and path-hash paths.
  proof_level: B
  status: validated
  validated_on: 2026-05-22
  proof: test/v2-project-id.test.mjs

- id: v2-bundle-replay-store
  feature: Session bundles replay into the instinct store with create/reinforce deltas.
  test: Run `npm test` — `test/v2-bundle-replay.test.mjs`, `test/v2-apply-delta.test.mjs`.
  proof_required: Passing bundle replay and delta application tests.
  proof_level: B
  status: validated
  validated_on: 2026-05-22
  proof: test/v2-bundle-replay.test.mjs

- id: v2-vault-memory-render
  feature: Curated MEMORY.md and topic spill files render under the vault carve-out with allowlist enforcement.
  test: Run `npm test` — `test/v2-render-memory.test.mjs`, `test/v2-memory-pipeline.test.mjs`.
  proof_required: Passing render tests including rollup selection and spill paths.
  proof_level: B
  status: validated
  validated_on: 2026-05-22
  proof: test/v2-render-memory.test.mjs

- id: v2-memory-pipeline-e2e
  feature: Reviewed learnings sync to instincts, export to wiki JSONL, and push to vault including MEMORY.md render.
  test: Run `node scripts/proof-smoke.mjs --suite v2` against fixture-backed ingest + review sidecar in an isolated sandbox.
  proof_required: Proof smoke output with instinct store files, export JSONL, asd-learnings page, and MEMORY.md path.
  proof_level: B
  status: validated
  validated_on: 2026-05-22
  proof: /tmp/agent-session-distillery/2026-05-22_v2-memory-pipeline/SUMMARY.md
