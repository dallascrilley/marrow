# agent-session-distillery

Standalone CLI for ingesting local Cursor agent transcripts into a durable runtime with summaries, learnings, manifests, review state, and deletion receipts.

Launch proof: [`docs/launch-proof-index.md`](docs/launch-proof-index.md)

5-minute demo: [`docs/demo-local-cursor-ingestion.md`](docs/demo-local-cursor-ingestion.md)

## Repository

[dallascrilley/agent-session-distillery](https://github.com/dallascrilley/agent-session-distillery)

## Development (Scripts to Rule Them All)

Canonical entrypoints for agents and CI — see [`AGENTS.md`](AGENTS.md):

| Task | Command |
|------|---------|
| Install deps | `script/setup` or `just setup` |
| Run tests | `script/test` or `just test` |
| CI parity | `script/cibuild` or `just cibuild` |
| Lint / format | `npm run lint` / `npm run format` |

## Automation

| Task | Command / doc |
|------|----------------|
| SessionEnd → ingest (Claude Code) | `asd hooks install` — [`docs/recipes/session-end-ingest-hook.md`](docs/recipes/session-end-ingest-hook.md) |
| Scheduled ingest + wiki push | [`docs/recipes/scheduled-memory-pipeline.md`](docs/recipes/scheduled-memory-pipeline.md) |
| Pipeline gate (skip LLM when idle) | `asd pipeline gate --max-per 5/24h --max-usd 1/24h` — ADR-0007 |
| Skill usage evidence in corpus | `asd skill evidence <skill-id>` (after `export-index`) |
| Skill adherence report | `asd skill report <skill-id>` — [`docs/recipes/skill-adherence-report.md`](docs/recipes/skill-adherence-report.md) |

## Requirements

- Node `22.x`
- npm
- Local Cursor transcript files on disk
- Optional: `OPENROUTER_API_KEY` for LLM-gated project-learning review commands.
  - Source the key from the 1Password item **OpenRouter API Credentials - agent-session-distillery** (`op read 'op://Private/OpenRouter API Credentials - agent-session-distillery/credential'`).
  - Load it via `op read` or your secret-manager flow and never commit the key.

## Install

```bash
npm install
npm run build
```

Run the CLI directly:

```bash
node dist/cli.js --help
```

Or link the package-local `asd` binary into your shell:

```bash
npm link
asd --help
```

By default the runtime lives at `~/.agent-session-distillery`. Override it with `AGENT_SESSION_DISTILLERY_ROOT` when you want an isolated sandbox or a scheduled-job-specific path.

```bash
AGENT_SESSION_DISTILLERY_ROOT=/tmp/asd-demo node dist/cli.js stats
```

## Supported Sources

Each adapter is selected with `--source <name>` on `ingest backfill` and `ingest sync`. Run multiple adapters back-to-back to grow the corpus.

### Cursor (`--source cursor`)

Local Cursor data only. Transcript inputs:

- `~/.cursor/projects/<workspace-slug>/agent-transcripts/*.jsonl`
- `~/.cursor/projects/<workspace-slug>/agent-transcripts/*.txt`

Workspace mapping hints used to recover the real workspace path:

- `~/.cursor/projects/<workspace-slug>/workspace.json`
- `~/.cursor/projects/<workspace-slug>/workspace-path.txt`
- `~/.cursor/projects/<workspace-slug>/workspace.txt`
- `~/.cursor/projects/<workspace-slug>/project.json`
- `~/.cursor/projects/<workspace-slug>/metadata.json`

Optional Cursor support databases that improve attribution but are not required for transcript discovery:

- `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`
- `~/Library/Application Support/Cursor/User/workspaceStorage/*/state.vscdb`

Out of scope: Cursor background-agent chats. Cursor stores those remotely rather than in the local transcript tree this tool ingests; see [`docs/research/background-agent-source-strategy.md`](docs/research/background-agent-source-strategy.md).

### Claude Code (`--source claude-code`)

Local Claude Code data only. Transcript inputs:

- `~/.claude/projects/<encoded-workspace>/<session-uuid>.jsonl`

The `<encoded-workspace>` segment is the absolute workspace path with `/` replaced by `-` (the leading `/` also encodes to `-`). The adapter decodes it back to the real workspace path. No auxiliary stores are needed; everything Claude Code writes for a session lives in the file.

Design and source-surface research: [`docs/research/claude-code-source-strategy.md`](docs/research/claude-code-source-strategy.md).

### Codex CLI (`--source codex-cli`)

Local Codex CLI rollout files only. Transcript inputs:

- `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl` (date-partitioned tree)
- `~/.codex/archived_sessions/rollout-*.jsonl` (flat archive)

Codex sessions are date-partitioned, not workspace-partitioned. The adapter reads the `session_meta` line at the top of each rollout to recover `payload.cwd`; the project key is the last segment of that path. The composite classifier joins the top-level `type` with the inner `payload.type` so every `response_item/message`, `response_item/function_call`, `response_item/function_call_output`, and `response_item/reasoning` is mapped correctly. Auxiliary stores (`session_index.jsonl`, `history.jsonl`) are intentionally out of scope.

Design and source-surface research: [`docs/research/codex-cli-source-strategy.md`](docs/research/codex-cli-source-strategy.md).

### Kimi (`--source kimi`)

Local Kimi Code CLI data only. Transcript inputs:

- `~/.kimi/sessions/<md5-workspace-path>/<session-uuid>/wire.jsonl`

The `<md5-workspace-path>` segment is the MD5 hex digest of the absolute workspace path. The adapter reads `~/.kimi/kimi.json` to map MD5 slugs back to real workspace paths when available. Classifier maps `TurnBegin` → `user_message`, `ContentPart` → `assistant_message`, `ToolCall` → `tool_use_stub`, and `ToolResult` → `tool_result_stub`; everything else (metadata, `StepBegin`, `StatusUpdate`, `TurnEnd`) becomes `event`.

### Pi / Zosma (`--source pi`)

Local Pi session files only. Transcript inputs:

- `~/.pi/agent/sessions/<encoded-cwd>/<iso>_<uuid>.jsonl`

The `<encoded-cwd>` segment is the absolute workspace path with leading-and-trailing `--` framing plus `/` → `-` internally. The adapter prefers the content-derived `cwd` from the session line (line 0) over the path-encoded slug because the encoding can collide if a workspace itself contains `--`. Classifier is **role-nested**: `message` records branch on `message.role` ∈ {`user`, `assistant`, `toolResult`}; tool calls live inside assistant `message.content[]` as `toolCall` blocks (not promoted to separate records in phase 1).

Design and source-surface research: [`docs/research/pi-source-strategy.md`](docs/research/pi-source-strategy.md).

## Runtime Layout

The CLI writes a local runtime under `~/.agent-session-distillery` or the path set in `AGENT_SESSION_DISTILLERY_ROOT`.

Important directories:

- `ledger/` — SQLite lifecycle state and operational history
- `staging/<session-id>/` — parsed and reduced intermediates
- `summaries/by-session/<session-id>/` — `summary.json` and `summary.md`
- `knowledge/projects/<project-key>/` — deterministic project-learning candidate JSONL
- `knowledge/projects-reviewed/<project-key>/` — LLM-reviewed project learnings applied as a non-mutating sidecar
- `knowledge/user/operator/` — user learning JSONL
- `sources/manifests/` — immutable provenance manifests
- `reviews/` — review queue runtime path
- `archives/` — archive runtime path
- `deletes/receipts/` — per-session retention receipts
- `deletes/tombstones/` — explicit deletion apply tombstones
- `reports/` — retention, audit, LLM learning-review, and static dashboard HTML reports
## Real Regression Fixtures

The repo also carries a small real-session regression corpus under
`test/fixtures/cursor/live-regression/`. These fixtures are copied from actual
local Cursor transcript files so parser and summary regressions can be judged
against production-shaped data instead of synthetic-only fixtures.

## Command Examples

Initial backfill (pick one `--source`; run multiple adapters back-to-back to grow the corpus):

```bash
node dist/cli.js ingest backfill --source cursor
node dist/cli.js ingest backfill --source claude-code
```

Initial backfill with a cutoff date and session cap:

```bash
node dist/cli.js ingest backfill --source cursor --since 2026-05-01T00:00:00Z --limit 100
```

Twice-daily incremental sync:

```bash
node dist/cli.js ingest sync --source cursor --resume
```

Review queue triage:

```bash
node dist/cli.js review queue
node dist/cli.js review show <session-id>
node dist/cli.js explain <session-id>
```

Archive run for sessions currently sitting in the extracted phase:

```bash
node dist/cli.js archive run
```

Inspect deletion readiness:

```bash
node dist/cli.js delete candidates
node dist/cli.js delete apply
```

`delete candidates` includes the raw ledger candidates plus an operator-facing
`decisions` array with ready/blocked status, required artifact presence, missing
required artifacts, manifest and retention receipt paths, and the next action for
each session.

Explicit deletion apply:

```bash
node dist/cli.js delete apply --apply
```

High-level runtime stats:

```bash
node dist/cli.js stats
```

Static offline dashboard export:

```bash
node dist/cli.js report --html
node dist/cli.js report --html --out /tmp/asd-dashboard.html
```

By default this writes `reports/dashboard.html` under the runtime root. The output is self-contained and works offline: session list, source/lifecycle filters, pipeline-health metrics, knowledge/instinct explorer cards with back-links, cross-harness comparison cards for volume/topic yield/LLM cost, a read-only review-queue snapshot with CLI follow-up hints, search, and per-session drill-down into summary and reduced timeline.

Audit summary and deletion-readiness quality across already-ingested sessions:

```bash
node dist/cli.js quality audit
node dist/cli.js quality audit --limit 100
node dist/cli.js quality audit --topic-distribution
```

Topic-distribution mode ranks projects by low-signal topic rate, wrapper-leak
count, and LLM rescue coverage, and prints remediation commands
(`corpus:resummarize:dry-run` → `corpus:resummarize`).

The default audit reports deletion-readiness counts, blocked reasons, issue counts,
recommendations, deterministic project-learning distribution metrics, knowledge
artifact presence, and the worst sessions by deterministic output-quality checks.

Review deterministic project learnings with an OpenRouter memory-lint sidecar:

```bash
# Source the key from 1Password: "OpenRouter API Credentials - agent-session-distillery"
export OPENROUTER_API_KEY="$(op read 'op://Private/OpenRouter API Credentials - agent-session-distillery/credential')"

node dist/cli.js quality review-learnings --model openai/gpt-5-nano
node dist/cli.js quality review-learnings --limit 25 --max-total-learnings 100
node dist/cli.js quality review-learnings --cache-dir /tmp/asd-review-cache
node dist/cli.js quality review-learnings --refresh-llm
node dist/cli.js quality review-learnings --max-usd 1/24h --batch-size 10
```

This writes `reports/llm-learning-review.jsonl`. LLM reviews are cached by exact learning/model/prompt/validator input under `cache/llm-learning-review/` by default; pass `--refresh-llm` to overwrite cached entries or `--no-cache` to bypass cache reads and writes. Provider or transport failures are reported in the command output and left pending for retry; they are not written as rejected review entries.

**Cost controls.** Reviews use a minimal OpenRouter reasoning effort (the memory-lint is a trivial classify task, so reasoning tokens are pure waste) and run only when **both** budgets allow: the call-count cap (`--max-per` / `ASD_LLM_MAX_PER`, default `5/24h`) and a hard USD ceiling (`--max-usd` / `ASD_LLM_MAX_USD`, default `1/24h`). The USD ceiling sums the **effective** (upstream-aware) cost of telemetry receipts in the trailing window, so it still fires for BYOK keys whose OpenRouter `usage.cost` is 0; over the cap the command skips with `skip_reason: "llm_usd_budget_exhausted"`. Before paying for any review the command drops deterministic junk and duplicate statements (reported as `skipped_pre_llm`), then reviews the remaining cache-miss learnings in batches of `--batch-size` (default 10, `1` disables batching) — one OpenRouter call per batch, demultiplexed by learning id, with cache hits served without a call.

Apply the LLM review into a separate reviewed namespace:

```bash
node dist/cli.js quality apply-learning-review
```

This writes `knowledge/projects-reviewed/` and `reports/llm-learning-review-apply.json` without mutating `knowledge/projects/`. The apply step keeps only durable keep/rewrite verdicts that pass strict post-validation.

Report OpenRouter LLM cost from the telemetry receipts written during review (`reports/llm-telemetry.jsonl`):

```bash
node dist/cli.js quality cost-report
node dist/cli.js quality cost-report --json
node dist/cli.js quality cost-report --since 2026-06-14T00:00:00Z
node dist/cli.js quality cost-report --backlog-learnings 3000   # project full-drain cost
```

Each OpenRouter call records actual token usage and USD cost (`usage: { include: true }`) using OpenTelemetry GenAI field names; cache hits are zero-cost receipts. The report aggregates cost per session (mean/p50/p90/max), cost per learning, cache-hit rate, unknown-cost calls, and `http_calls` (the true OpenRouter request count, recovered by weighting each batched receipt by `1/batch_size`). Cost is taken from the provider response, never estimated — calls where OpenRouter omits cost are counted as `unknown_cost_calls` rather than guessed.

Upgrade topics for already-archived sessions without re-ingesting transcripts (manifests stay immutable; summaries and `export-index` output refresh):

```bash
# Preview how many low-signal sessions would upgrade (no writes)
node dist/cli.js quality resummarize --low-signal-only --dry-run

# Bulk remediation for Tether Session Search / session-index consumers
npm run corpus:resummarize
npm run corpus:resummarize:dry-run

node dist/cli.js quality resummarize --low-signal-only --llm-topic --export-index
node dist/cli.js quality resummarize --session-id <session-id>
```

Sessions without manifests are skipped (not failed) so bulk runs continue; re-run ingest through archive for orphan sessions.

Run the local memory value loop as a single dry-run command:

```bash
npm --silent run memory:pipeline:dry-run -- --root /tmp/asd-memory-demo --limit 100
```

The dry run executes `quality audit`, applies `reports/llm-learning-review.jsonl`
only when that review sidecar already exists, then runs `memory export-wiki`.
It prints a JSON step report with command output, failure points, whether apply
occurred, and the wiki export path.

Wiki export contract: [`docs/wiki-memory-export-contract.md`](docs/wiki-memory-export-contract.md)

## Push to Vault

`memory push-wiki` reads the `asd.wiki_memory.v1` JSONL export and writes one
Obsidian-shaped markdown page per record into a scoped subtree of the personal
vault. Pages are atomic-written and tracked in a per-project manifest.

```bash
# Write to ~/vault (or $ASD_VAULT_ROOT) from the most recent JSONL export.
node dist/cli.js memory push-wiki

# Re-run export-wiki first, then push.
node dist/cli.js memory push-wiki --refresh

# Target a non-default vault.
node dist/cli.js memory push-wiki --vault /path/to/vault

# Preserve manual edits to asd-authored pages.
node dist/cli.js memory push-wiki --no-overwrite
```

Output layout, per project (v1 wiki pages + v2 curated rollup):

- `<vault>/wiki/projects/<project-key>/asd-learnings/<page-id>.md` — one page per reviewed learning record.
- `<vault>/wiki/projects/<project-key>/asd-learnings/_asd-manifest.json` — asd-owned manifest.
- `<vault>/wiki/projects/<project-key>/MEMORY.md` — curated instinct rollup (regenerated on each push).
- `<vault>/wiki/projects/<project-key>/{workflow,tooling,preferences,pitfalls,debugging}.md` — topic spill files when the rollup exceeds the line cap.

asd writes **only** into those paths under `wiki/projects/<project-key>/`. It never touches `hot.md`, `index.md`,
`log.md`, `wiki/sources/`, `wiki/entities/`, `wiki/concepts/`, any `_index.md`,
or `.raw/.manifest.json`. The next vault session's normal autolink / lint flow
picks up new pages through the same mechanism it uses for any other new file
under `wiki/`.

If the vault path does not exist, the command prints a "vault not present"
notice and exits 0 — safe to schedule under launchd / cron.

Design and contract:

- [`docs/plans/2026-05-18-vault-push-integration.md`](docs/plans/2026-05-18-vault-push-integration.md)
- [`docs/research/vault-push-source-strategy.md`](docs/research/vault-push-source-strategy.md)
- [`docs/claude-md-amendment-draft.md`](docs/claude-md-amendment-draft.md) — the global CLAUDE.md carve-out that this command relies on.

## Retention Model

The current lifecycle is:

1. `discovered`
2. `parsed`
3. `reduced`
4. `summarized`
5. `extracted`
6. `archived`
7. `deletion_candidate`
8. `deleted`

`ingest backfill` and `ingest sync` drive a discovered session through parse, reduce, summarize, extract, and archive. During summarization the tool creates a pending review entry. During archive it writes the immutable manifest, retention receipt, and batch report, then updates deletion-candidate state.

A session is only marked safe to delete when all of the following exist:

- `summary.json`
- `summary.md`
- at least one knowledge artifact: project learnings or user learnings
- the immutable provenance manifest
- the retention receipt

If any of those artifacts are missing, the session remains blocked with a concrete reason in the retention receipt and deletion-candidate record. `delete apply` is a dry run by default; only `delete apply --apply` records an applied deletion tombstone and advances the lifecycle to `deleted`.

## Troubleshooting

### Missing transcript paths

If `ingest backfill --source cursor` finds nothing, verify that Cursor has written local transcript files under:

- `~/.cursor/projects/*/agent-transcripts/*.jsonl`
- `~/.cursor/projects/*/agent-transcripts/*.txt`

This tool ignores non-transcript files and cannot ingest remote-only chat state.

### Workspace rename drift

Project attribution comes from the workspace slug plus any local workspace hint files. If a workspace was renamed or moved after Cursor created the slug, the tool may fall back to the slug-derived project key when the old path no longer exists. Check the hint files in the project directory, especially `workspace.json`, and confirm they point at a live absolute path.

### Parser-version invalidation

`--resume` reuses completed phase artifacts only when the stored `source_hash` still matches the current transcript. If parsing behavior changes or the transcript contents change, rerun without `--resume` so parsed and reduced artifacts are regenerated from the current source. If you use an isolated runtime root for testing parser changes, point `AGENT_SESSION_DISTILLERY_ROOT` at a fresh directory.
