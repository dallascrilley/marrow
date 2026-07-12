# Repository Guidelines

## Project Overview

`agent-session-distillery` is a local, CLI-only TypeScript application (`asd`) that ingests on-disk agent transcripts from Cursor, Claude Code, Codex CLI, Kimi, and Pi. It turns them into durable summaries, extracted learnings, review state, archival artifacts, and safe deletion receipts under `~/.agent-session-distillery` by default. See `PROJECT_CONTEXT.md` and `README.md` for the supported source locations and runtime layout.

## Architecture & Data Flow

**Architecture:** command-oriented CLI over a local SQLite-backed runtime; there is no HTTP server or hosted service.

1. `src/cli.ts` maps `asd <command>` to an `execute*` command handler and opens the ledger with `withLedger` for database-backed commands.
2. Ingestion handlers such as `src/commands/ingest-backfill.ts` choose an adapter, then run the ordered pipeline: **discover → parse → reduce → summarize → extract → archive**.
3. `src/adapters/{cursor,claude-code,codex-cli,kimi,pi}/` convert source-specific transcript formats into shared canonical records from `src/models/canonical.ts`.
4. `src/pipeline/` owns phase behavior, quality checks, provenance, retention/deletion safety, and optional LLM review. `src/writers/` persists summaries, knowledge JSONL, manifests, and reports.
5. The ledger and runtime artifacts are read through `src/read/`, static reports in `src/report/`, MCP in `src/commands/mcp.ts`, and v2 project/instinct/vault features in `src/v2/`.

Keep the presentation and integration surfaces read-oriented. Reuse the shared read or ledger layer rather than introducing a parallel query path. Deletion is intentionally gated on required artifacts and receipts; never bypass lifecycle checks.

## Key Directories

- `src/cli.ts` — CLI entry point and command tree.
- `src/commands/` — command handlers; parse CLI options and orchestrate domain services.
- `src/adapters/` — source discovery and parsing per supported harness.
- `src/pipeline/` — deterministic ingestion phases, extraction, archive/retention, quality, and LLM-review gates.
- `src/models/` — shared Zod schemas and canonical TypeScript contracts.
- `src/db/` — SQLite ledger lifecycle and query helpers.
- `src/read/` — reusable read model for CLI, MCP, and reports.
- `src/writers/` — durable JSONL/summary/manifest/report outputs.
- `src/v2/` — project-ID resolution, instincts, promotion, vault rendering, and memory pipeline.
- `src/report/` — static offline HTML dashboard rendering; do not add a dev server.
- `test/` — Node built-in test runner suites; `test/fixtures/` holds transcript fixtures, including `cursor/live-regression/`.
- `script/` — canonical developer and CI entry points; `scripts/` contains operational, proof, and dry-run utilities.
- `docs/decisions/` and `docs/recipes/` — architectural decisions and operator workflows.

## Development Commands

Use `script/*` (or the equivalent `just` recipe) for canonical project workflows:

```bash
script/setup                 # require Node 22, install npm dependencies, install tracked hooks
script/test                  # build, then run all Node tests sequentially
script/cibuild               # npm ci + Biome lint + tests + TypeScript build; CI parity
script/server --help         # build, then invoke the CLI (despite the name, no server starts)
script/console               # Node REPL

npm run build                # compile src/ to ignored dist/
npm run lint                 # biome check src test scripts
npm run format               # apply Biome formatting
node dist/cli.js --help      # run compiled CLI directly
node dist/cli.js ingest sync --source cursor --resume
```

Use `npm run asd -- <args>` when you want build-and-run behavior. CI runs `script/cibuild` for pull requests and pushes to `main` (`.github/workflows/ci.yml`).

## Code Conventions & Common Patterns

- **TypeScript/ESM:** Use NodeNext-compatible imports with explicit `.js` suffixes (for example, `import { createLedger } from "./db/ledger.js"`). Keep code under `src/`; `dist/` is generated.
- **Strict contracts:** `tsconfig.json` enables `strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`. Define or reuse Zod schemas and inferred/shared types in `src/models/` at external-data boundaries; do not pass unvalidated transcript shapes through the pipeline.
- **Command shape:** Follow `executeFeature(context, database): Promise<number>` for ledger-backed CLI commands. Return an exit code; send user-facing output through `context.output`; let `src/cli.ts` centralize unknown-command and top-level error handling.
- **Pipeline shape:** Keep phase behavior in focused `run*Phase` functions. Preserve the ordered phase lifecycle, `source_hash` resume invalidation, ledger checkpoints, manifests, and retention receipts when changing ingest behavior.
- **Failures:** Isolate failure to the affected session when processing a batch, record failure state/history in the ledger, and continue other sessions when safe. Do not hide errors or silently skip a destructive safety check.
- **Formatting:** Biome uses 2-space indentation, 100-column lines, double quotes, semicolons, trailing commas, recommended lint rules, and import organization. Run `npm run format` rather than hand-formatting broad files.
- **State:** The runtime directory and SQLite ledger are the source of durable state. Use `AGENT_SESSION_DISTILLERY_ROOT` to isolate tests, proofs, and experiments instead of mutating the operator runtime.
- **LLM work:** Keep LLM-dependent commands explicitly gated and budgeted. `OPENROUTER_API_KEY` is optional and must come from the secret manager, never source control.
- **Vault writes:** Preserve the narrow v2 vault carve-out enforced by `src/pipeline/vault-push.ts` and `src/v2/vault/render-memory.ts`; do not add a generic vault writer.

## Important Files

- `package.json` — npm scripts, Node `22.x` requirement, `asd` bin mapping, and dependencies.
- `tsconfig.json` — strict NodeNext compilation from `src/` to `dist/`.
- `biome.json` — formatter/linter policy and excluded generated/runtime paths.
- `src/cli.ts` — command registry, dispatch, help, and ledger lifetime management.
- `src/commands/ingest-backfill.ts` — reference implementation for the end-to-end ingest flow.
- `src/models/canonical.ts` — canonical event, session, learning, and lifecycle schemas.
- `src/config/paths.ts` — runtime-root resolution.
- `script/lib/profile.sh` — actual implementation behind `script/*` commands.
- `PROJECT_CONTEXT.md` — durable architectural constraints, runtime locations, and secret names.
- `README.md` — source-adapter inputs, runtime artifacts, and operator command examples.
- `LAUNCH_CRITERIA.md` — launch/readiness criteria; check before declaring a feature ship-ready.

## Runtime/Tooling Preferences

- Required runtime: **Node.js 22.x**. `script/bootstrap` rejects other major versions.
- Package manager: **npm**; respect `package-lock.json`. Do not switch package managers or hand-edit the lockfile as a side effect of normal work.
- Module system: ESM with TypeScript `module`/`moduleResolution` set to `NodeNext`.
- Formatting and linting: `@biomejs/biome`; `dist/`, runtime artifacts, coverage, and dependency folders are excluded.
- Runtime root: `~/.agent-session-distillery`; set `AGENT_SESSION_DISTILLERY_ROOT=/tmp/asd-proof` for an isolated run.
- Secrets/configuration: `OPENROUTER_API_KEY` enables optional LLM learning review; `ASD_VAULT_ROOT` overrides the vault target. Never print or commit secret values.

## Testing & QA

Tests use Node's built-in `node:test` with strict assertions. Test files are `test/*.test.mjs`; many exercise the compiled `dist/` modules and CLI, so build before running focused tests:

```bash
npm run build
node --test --test-concurrency=1 test/cli.test.mjs
node --test --test-concurrency=1 test/extract.test.mjs
```

Follow the existing Arrange–Act–Assert style. Use `mkdtemp` and `AGENT_SESSION_DISTILLERY_ROOT` for isolated filesystem/runtime tests, and clean temporary roots in `finally` blocks. Prefer production-shaped fixtures in `test/fixtures/` for adapter or extraction regressions.

Before a PR or push, run `script/cibuild`; it is the complete CI-equivalent gate. No coverage reporter or enforced threshold is configured in `package.json` or CI. For new behavior, add focused tests for the happy path, boundaries, and error handling; target at least 80% coverage. For a docs-only change, re-read the generated documentation and verify every documented command/path against the current repository configuration rather than running unrelated code tests.
