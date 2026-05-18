# Launch Proof Index

Date: 2026-05-18
Repo: `/Users/dallascrilley/Code/agent-session-distillery`

This is the operator-facing index for the current v1 local Cursor transcript
launch proof. The canonical gate definitions live in
[`LAUNCH_CRITERIA.md`](../LAUNCH_CRITERIA.md).

## Verdict

Launch status: P0 validated.

All six P0 launch gates are validated against local proof artifacts:

- `install-build-help`
- `cursor-local-discovery`
- `ingest-review-explain`
- `deletion-readiness-safety`
- `quality-audit-signal`
- `memory-export-reviewed`

Remaining blockers: none for the current v1 local Cursor transcript workflow.

Remaining polish:

- Independent `td` review still needs to approve the implementation-session
  items currently in review.
- Remote-only Cursor background-agent chats remain out of scope for v1.

## Proof Artifacts

| Gate | Result | Proof |
| --- | --- | --- |
| First-run install, help, local Cursor discovery, review, explain | `npm install`, `npm run build`, `--help`, `stats`, fixture-backed ingest, `review queue`, `review show`, `explain`, and `delete candidates` passed. One fixture session reached `deletionCandidateState=ready`. | `/tmp/agent-session-distillery/2026-05-18_first-run/SUMMARY.md` |
| Deletion-readiness safety | 2 ready candidates, 3 blocked candidates, blocked reasons preserved, dry-run delete apply did not apply deletion. | `/tmp/agent-session-distillery/2026-05-18_deletion-readiness/SUMMARY.md` |
| Quality audit signal | Audit reported deletion-readiness counts, issue counts, 3 recommendations, learning distribution metrics, and 5 worst-session checks. | `/tmp/agent-session-distillery/2026-05-18_quality-audit/SUMMARY.md` |
| Reviewed memory export | `quality apply-learning-review` kept 1 reviewed learning, `memory export-wiki` wrote 1 `reviewed-export` JSONL record from `knowledge/projects-reviewed/`. | `/tmp/agent-session-distillery/2026-05-18_reviewed-memory-export/SUMMARY.md` |
| GitHub CI | GitHub Actions workflow `npm test` ran on `main`; run `26012987261` completed successfully for job `Node 22`. | `https://github.com/dallascrilley/agent-session-distillery/actions/runs/26012987261` |

## Rerun Commands

From a clean checkout:

```bash
npm install
npm run build
node dist/cli.js --help
AGENT_SESSION_DISTILLERY_ROOT=/tmp/asd-demo node dist/cli.js stats
```

Fixture-backed first-run flow:

```bash
export HOME=/tmp/asd-first-run/home
export AGENT_SESSION_DISTILLERY_ROOT=/tmp/asd-first-run/runtime
mkdir -p "$HOME/.cursor/projects/agent-session-distillery/agent-transcripts"
cp test/fixtures/cursor/transcripts/session-e2e.jsonl \
  "$HOME/.cursor/projects/agent-session-distillery/agent-transcripts/session-e2e.jsonl"
node dist/cli.js ingest backfill --source cursor
node dist/cli.js review queue
node dist/cli.js review show session-e2e
node dist/cli.js explain session-e2e
node dist/cli.js delete candidates
```

Deletion-readiness safety:

```bash
export HOME=/tmp/asd-retention/home
export AGENT_SESSION_DISTILLERY_ROOT=/tmp/asd-retention/runtime
mkdir -p "$HOME/.cursor/projects/live-regression/agent-transcripts"
cp test/fixtures/cursor/live-regression/{0fc0a884-3413-44fa-bdd4-77984f40e413,2477b32c-27f6-4c56-b81c-75ab3e6938d8,6e8197bb-269e-43a8-bc58-e965468c3f82,6edabde1-32b9-47cb-b4e8-0e5884f98a14,d2d8b0e7-3fae-4506-927b-8f80a301ccb0}.jsonl \
  "$HOME/.cursor/projects/live-regression/agent-transcripts/"
node dist/cli.js ingest backfill --source cursor
node dist/cli.js archive run
node dist/cli.js delete candidates
node dist/cli.js delete apply
node dist/cli.js stats
```

Quality audit:

```bash
export AGENT_SESSION_DISTILLERY_ROOT=/tmp/asd-retention/runtime
node dist/cli.js quality audit --limit 100
```

Reviewed memory apply and wiki export:

```bash
export HOME=/tmp/asd-memory-export/home
export AGENT_SESSION_DISTILLERY_ROOT=/tmp/asd-memory-export/runtime
mkdir -p "$HOME/.cursor/projects/agent-session-distillery/agent-transcripts"
cp test/fixtures/cursor/transcripts/session-e2e.jsonl \
  "$HOME/.cursor/projects/agent-session-distillery/agent-transcripts/session-e2e.jsonl"
node dist/cli.js ingest backfill --source cursor
node --input-type=module <<'NODE'
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.env.AGENT_SESSION_DISTILLERY_ROOT;
const learningPath = join(root, "knowledge/projects/agent-session-distillery/session-e2e.jsonl");
const [learning] = (await readFile(learningPath, "utf8")).trim().split("\n").map(JSON.parse);
await mkdir(join(root, "reports"), { recursive: true });
await writeFile(join(root, "reports/llm-learning-review.jsonl"), `${JSON.stringify({
  project_key: "agent-session-distillery",
  session_id: "session-e2e",
  learning_id: learning.id,
  model: "local-proof",
  prompt_version: "manual-proof",
  verdict: "keep",
  reason: "Proof sidecar for reviewed-memory export rerun.",
  reviewed_body: "Use reviewed project learnings for wiki export proof.",
  confidence: "high",
  source_learning: learning,
})}\n`);
NODE
node dist/cli.js quality apply-learning-review
node dist/cli.js memory export-wiki
```

CI proof:

```bash
gh-axi run list --limit 5
gh-axi run view 26012987261
```

## Notes

- The first-run proof used the absolute Node binary
  `/Users/dallascrilley/.local/share/mise/installs/node/22.22.2/bin/node` after a
  fake-`HOME` sandbox exposed a mise trust prompt through the shell shim.
- `delete apply` is a dry run by default. Use `delete apply --apply` only when
  intentionally recording deletion tombstones.
- `memory export-wiki` prefers `knowledge/projects-reviewed/` when reviewed
  learnings exist and falls back to deterministic `knowledge/projects/`.
