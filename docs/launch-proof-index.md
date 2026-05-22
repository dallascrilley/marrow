# Launch Proof Index

Date: 2026-05-22
Repo: `/Users/dallascrilley/Code/agent-session-distillery`

Operator-facing index for v1 local transcript launch proof and v2 atomic-instinct
memory pipeline proof. Canonical gate definitions:
[`LAUNCH_CRITERIA.md`](../LAUNCH_CRITERIA.md).

## Verdict

**v1:** P0 validated — six local Cursor transcript gates.

**v2:** P0 validated — five atomic-instinct + vault-render gates.

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
