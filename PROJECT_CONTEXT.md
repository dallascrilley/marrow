# Project Context — agent-session-distillery

Durable facts an agent needs that are NOT obvious from the code. Keep current.

## What it is

Standalone CLI (`asd`) that ingests local agent session transcripts (Cursor, Claude Code, Codex CLI, Kimi, Pi), runs a deterministic pipeline (parse → reduce → summarize → extract → archive), and writes a durable runtime under `~/.agent-session-distillery` (override with `AGENT_SESSION_DISTILLERY_ROOT`). v2 adds atomic instincts, vault push, and scoped wiki memory export.

Launch proof and criteria: [`LAUNCH_CRITERIA.md`](LAUNCH_CRITERIA.md), [`docs/launch-proof-index.md`](docs/launch-proof-index.md).

## Stack & architecture

- **Stack:** Node.js 22.x, TypeScript (ESM), npm, Zod, SQLite ledger
- **Entry:** `src/cli.ts` → `dist/cli.js` (`asd` bin)
- **Adapters:** `src/adapters/{cursor,claude-code,codex-cli,kimi,pi}/` — discover + parse per harness
- **Pipeline:** `src/pipeline/` — discover, parse, reduce, summarize, extract, archive, retention, quality
- **Writers:** `src/writers/` — summaries, knowledge JSONL, manifests, reports
- **v2:** `src/v2/` — instincts, vault render/push, project-id resolution (ADR-0002)
- **Runtime layout:** ledger SQLite, staging, summaries, knowledge (deterministic + reviewed sidecar), sources/manifests, reviews, archives — see README

## Environments

| Env | Where | Notes |
|-----|-------|-------|
| local | `script/setup`, `node dist/cli.js` | Build with `npm run build`; optional `OPENROUTER_API_KEY` for LLM learning review (see secrets table below) |
| ci | `script/cibuild` | `npm ci`, biome lint, node test, tsc build |
| prod | operator machine | Scheduled ingest / vault push via launchd or cron; no hosted service |

## Key decisions

- **Vault carve-out (v2):** asd may write only eight named paths under `~/vault/wiki/projects/<project-id>/` — see [`CLAUDE.md`](CLAUDE.md). Enforced structurally: `src/pipeline/vault-push.ts` and `src/v2/vault/render-memory.ts` hardcode carve-out paths (no generic vault writer).
- **Project ID:** git-remote-hash with fallback chain — [`docs/decisions/`](docs/decisions/) ADR-0002.
- **Deletion safety:** lifecycle blocked until summary, knowledge, manifest, and retention receipt exist — never silent delete.
- **Deterministic vs reviewed learnings:** project JSONL is deterministic; LLM-reviewed sidecar is non-mutating export input.
- **Adapter scope:** local on-disk transcripts only; remote-only chat (e.g. Cursor background agents) out of scope.

## Known constraints & gotchas

- **No dev server:** CLI-only; `script/server` prints `--help` after build.
- **Resume invalidation:** `--resume` skips phases only when `source_hash` matches; parser changes need fresh run.
- **Workspace rename drift:** project keys come from workspace slugs/hints; renamed paths may mis-attribute until hints update.
- **Brownfield scripts:** repo also has `scripts/` (proof/dry-run utilities); canonical agent entrypoints are `script/*` + `just`.
- **Biome:** lint/format via `@biomejs/biome`; `dist/` excluded in `biome.json`.

## External services & secrets

| Secret / env | Purpose |
|--------------|---------|
| `AGENT_SESSION_DISTILLERY_ROOT` | Isolated runtime root for tests or sandboxes |
| `ASD_VAULT_ROOT` | Vault root override for `memory push-wiki` |
| `OPENROUTER_API_KEY` | Optional LLM-gated learning review commands; value lives in 1Password as **OpenRouter API Credentials - agent-session-distillery** |
| Local harness data | `~/.cursor`, `~/.claude`, `~/.codex`, `~/.kimi`, `~/.pi` — read-only ingestion sources |
