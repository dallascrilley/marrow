# Launch Proof Index

Date: 2026-06-14
Repo: `/Users/dallascrilley/Code/agent-session-distillery`

Operator-facing index for v1 local transcript launch proof and v2 atomic-instinct
memory pipeline proof. Canonical gate definitions:
[`LAUNCH_CRITERIA.md`](../LAUNCH_CRITERIA.md).

## Verdict

**v1:** P0 validated — six local Cursor transcript gates.

**v2:** P0 validated — five atomic-instinct + vault-render gates.

**P1 (session index):** export-index, LLM topic low-signal gate, resummarize corpus upgrade (incl. `npm run corpus:resummarize`), ingest batch resilience — validated 2026-05-23 via unit tests.

**P2 (Kimi adapter):** kimi-adapter-source-research, kimi-adapter — validated 2026-05-27 via integration and unit tests.

**P2 (automation surfaces):** session-end-hook, pipeline-gate, skill-adherence-report, quality-audit-topic-distribution — validated 2026-06-14 via unit tests, ADR-0007, and operator proofs.

Remaining out of scope: remote Cursor background-agent chats.

## Proof Artifacts

| Gate | Result | Proof |
| --- | --- | --- |
| v1 first-run install, help, discovery, review, explain | Fixture-backed ingest through review/explain surfaces. | `/tmp/agent-session-distillery/2026-05-18_first-run/SUMMARY.md` |
| Deletion-readiness safety | Ready/blocked candidates with dry-run delete apply. | `/tmp/agent-session-distillery/2026-05-18_deletion-readiness/SUMMARY.md` |
| Quality audit signal | Audit counts, recommendations, worst-session checks. | `/tmp/agent-session-distillery/2026-05-18_quality-audit/SUMMARY.md` |
| Reviewed memory export | apply-learning-review + export-wiki JSONL. | `/tmp/agent-session-distillery/2026-05-18_reviewed-memory-export/SUMMARY.md` |
| v2 memory pipeline e2e | ingest → apply-learning-review → instinct store → export-wiki → push-wiki + MEMORY.md. | `/tmp/agent-session-distillery/2026-05-22_v2-memory-pipeline/SUMMARY.md` |
| v2 unit tests | Instinct store, project-id, bundle replay, render, decay. | `npm test` (`test/v2-*.test.mjs`) |
| Session index export | `export-index` writes `asd.session_index.v1`. | `test/cli.test.mjs` |
| LLM topic + resummarize | Low-signal detection, wrapper skip, manifest-safe resummarize. | `test/summarize.test.mjs`, `test/resummarize.test.mjs` |
| Session index no wrapper topics | Bare skill slugs rejected; deriveTopic skips wrappers. | `test/summarize.test.mjs`, `test/resummarize.test.mjs` |
| Ingest batch resilience | Per-session failures isolated in backfill. | `test/ingest-backfill-isolation.test.mjs` |
| Kimi adapter source research | On-disk wire.jsonl paths and classifier documented. | `docs/research/kimi-source-strategy.md` |
| Kimi adapter ingest | End-to-end ingest via `--source kimi`. | `test/integration/kimi-ingest.test.mjs`, `test/kimi-*.test.mjs` |
| Corpus resummarize (operator runtime) | Dry-run + full pass on live corpus; zero failures. | `/tmp/agent-session-distillery/2026-05-27_corpus-resummarize/SUMMARY.md` |
| Unattended memory loop (partial) | Hook dry-run + claude-code ingest → audit → export-index → vault push; exit 0. | `/tmp/agent-session-distillery/2026-06-14_unattended-loop/SUMMARY.md` |
| SessionEnd hook install | Hook script + settings merge via `hooks install`. | `test/hooks-install.test.mjs` |
| Pipeline gate (daemon-LLM separation) | Cheap pending-work + budget JSON before OpenRouter. | `test/pipeline-gate.test.mjs`, `test/llm-budget.test.mjs`, ADR-0007 |
| Skill evidence + adherence report | Corpus skill mentions and checklist scoring. | `test/skill-report.test.mjs`, `docs/recipes/skill-adherence-report.md` |
| Quality audit topic distribution | Per-project low-signal/wrapper/LLM-rescue stats + remediation hints. | `test/quality-audit.test.mjs` |

## Rerun (turnkey)

From a clean checkout:

```bash
npm install
npm run build
npm run proof:smoke          # v1 + v2
node scripts/proof-smoke.mjs --suite v2   # v2 only
```

Scheduled pipeline recipe: [`docs/recipes/scheduled-memory-pipeline.md`](recipes/scheduled-memory-pipeline.md).

## CI note

GitHub Actions workflow removed 2026-05-22 per operator preference. Local proof
is authoritative: `npm test` and `npm run proof:smoke`.

## Notes

- `delete apply` is dry-run by default. Use `delete apply --apply` only when
  intentionally recording deletion tombstones.
- `memory export-wiki` prefers `knowledge/projects-reviewed/` when reviewed
  learnings exist.
- v2 project IDs use git-remote hash when `workspace-path.txt` points at a git
  checkout with `origin` configured.
