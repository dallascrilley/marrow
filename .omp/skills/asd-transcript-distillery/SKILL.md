---
name: asd-transcript-distillery
description: Use Marrow (formerly agent-session-distillery/ASD) to ingest local agent transcripts, mine reviewable workflow guidance, identify repetition tax, scout missing skills, and audit skill adherence. Use for transcript distillery, Marrow workflow mining, workflow sweeps, repetition tax, mining friction, skill scouting, and transcript-derived process improvements.
metadata:
  version: 2.0.0
---

# ASD transcript distillery

Use this repository's `marrow` CLI. The old Hub2 skill's bundled `bin/td`, `td init`,
`td inventory`, `td sweep`, `td skill-scout`, `td kill-tax`, configuration file, and
resource-limit model do not apply here.

## CLI resolution

Run commands from the Marrow repository root with:

```bash
npm run marrow -- <command> [options]
```

This rebuilds the ignored `dist/` tree before invoking `node dist/cli.js`, so it uses the
current checkout. Prefer it over a globally installed `marrow`, which may contain an older
build. Do not look up or invoke `td`.

The live runtime defaults to `~/.marrow`. Set `MARROW_ROOT` only for an intentionally isolated
proof or alternate runtime; do not mistake an empty isolated runtime for the operator corpus.
Legacy `AGENT_SESSION_DISTILLERY_ROOT` and selected `ASD_*` environment names remain supported
where documented, but the current `MARROW_*` names win when both are set.

## Boundaries

1. **Local by default:** ingest, indexing, deterministic extraction, workflow mining, storage
   inventory, and reports are local. `workflow judge` is the optional remote-LLM boundary.
2. **Runtime-scoped mining:** `workflow mine` scans the selected Marrow runtime. `--days` and
   `--source` filter indexed session records, but global workflow instincts are appended from
   the global store and are not constrained by those filters; treat `source_tier: instinct`
   candidates as outside the requested session window/source unless their evidence says
   otherwise. `--cluster` and `--recommendation` filter the merged candidate list, then
   `--limit` truncates that list rather than scan work. Use `--include-decided` to include
   candidates with prior decisions, and `--json` for machine-readable output.
   Marrow has no `td` project-init or byte-budget contract.
3. **Source selection is explicit:** refresh only the requested adapter: `cursor`,
   `claude-code`, `codex-cli`, `kimi`, or `pi`. For OMP transcripts, point `ASD_PI_SESSIONS_ROOT`
   at `$HOME/.omp/agent/sessions`.
4. **Evidence before guidance:** never promote a single excerpt, a weak candidate, or a
   contradicted candidate into durable instructions. Inspect parent-session evidence first.
5. **No automatic skill mutation:** `workflow apply` is draft-only, requires `--dry-run`, and
   writes under the runtime's `reports/workflow-drafts/`; review the draft before editing a
   real skill, rule, or workflow document.
6. **Privacy:** keep reports on the Marrow sanitized/capped evidence surface. Do not copy raw
   transcript bodies or local transcript paths into skills or outward systems.
7. **Cost gate:** before `workflow judge`, verify provider policy and budget, then pass explicit
   `--max-per` and `--max-usd` limits. Never infer approval for OpenRouter use from a local
   mining request.

## Core workflow

### 1. Inspect corpus health and cost-free state

```bash
npm run marrow -- health --json
npm run marrow -- stats
npm run marrow -- storage inventory --json
npm run marrow -- pipeline gate --max-per 5/24h --max-usd 1/24h
```

`storage inventory` scans runtime file metadata and classifies retention dependencies.
`pipeline gate` reports pending ingest/review work and budget headroom without calling
OpenRouter.

### 2. Refresh one relevant transcript source

Choose the adapter that produced the sessions being investigated. Examples:

```bash
npm run marrow -- ingest sync --source claude-code --resume
npm run marrow -- ingest sync --source codex-cli --resume
ASD_PI_SESSIONS_ROOT="$HOME/.omp/agent/sessions" \
  npm run marrow -- ingest sync --source pi --resume
```

Then refresh the shared session index:

```bash
npm run marrow -- export-index
```

Do not ingest every adapter by default. A mining-only request may use the existing corpus when
`health` shows it is current enough for the requested evidence window.

### 3. Mine a bounded evidence window

```bash
npm run marrow -- workflow mine --days 7 --limit 20
npm run marrow -- workflow mine --days 30 --limit 20 --json
npm run marrow -- workflow mine --days 30 --source pi --limit 20 --json
npm run marrow -- workflow mine --days 30 --source pi --cluster validation \
  --recommendation adopt --include-decided --limit 20 --json
```

Each candidate includes a stable `candidate_id`, cluster, proposed artifact kind, confidence,
source tier, recommendation, supporting/contradicting counts, parent-session evidence, and
capped sanitized excerpts.

### 4. Triage candidates

```bash
npm run marrow -- workflow review --days 30 --limit 20
npm run marrow -- workflow show <candidate-id> --days 30
```

Use this disposition:

- **Strong + adopt + zero contradictions:** check whether existing project or installed guidance
  already covers it. Prefer improving the existing artifact over creating a duplicate.
- **Medium:** compare more sessions; normally defer.
- **Weak:** normally dismiss; do not author guidance from it.
- **Contradicted or ambiguous:** defer for operator review.

Record a reviewed decision when the task includes triage:

```bash
npm run marrow -- workflow adopt <candidate-id> --note "<evidence-backed reason>" --days 30
npm run marrow -- workflow defer <candidate-id> --note "<missing evidence>" --days 30
npm run marrow -- workflow dismiss <candidate-id> --note "<why this is not durable>" --days 30
```

Use the same `--days` value for `mine`, `review`, `show`, and the decision command so the
candidate resolves against the same evidence set.

### 5. Draft, then author deliberately

For an uncovered, adopted candidate:

```bash
npm run marrow -- workflow apply <candidate-id> --target skill --dry-run --days 30
```

Valid targets are `skill`, `rule`, and `doc`. Read the generated Markdown and JSON apply report.
Author or revise the actual project-local artifact only after checking current guidance for
overlap and preserving its stronger safety contracts.

## Repetition-tax and missing-skill analysis

Marrow replaces `td kill-tax` and `td skill-scout` with evidence-based interpretation of
`workflow mine` output; there are no commands with those names.

For repetition tax:

1. Mine 30–90 days as JSON.
2. Prioritize repeated debugging, validation, shipping, review, and orchestration candidates
   with multiple supporting sessions and zero contradictions.
3. Separate a missing deterministic check from a missing skill. Prefer executable enforcement
   when the repeated failure can be checked mechanically.
4. Quantify the repeated steps or failures from candidate evidence; do not invent savings.

For missing-skill scouting:

1. Inspect candidates whose `artifact_kind` is `skill` and whose recommendation is `adopt` or
   `consider`.
2. Search existing project-local and installed skill metadata for equivalent guidance.
3. Improve an existing skill when ownership and trigger overlap are substantial; create a new
   skill only for a distinct reusable workflow.
4. Keep candidate IDs and Marrow session IDs as provenance, but omit raw transcript text and
   paths.

## Existing-skill evidence

After `export-index`, audit whether a known skill is being invoked and followed. Marrow checks
`~/.claude/skills`, `~/.cursor/skills`, and Hub artifact skills by default. Pass
`--skill-root .omp/skills` for project-local OMP skills:

```bash
npm run marrow -- skill evidence <skill-id> --limit 10
npm run marrow -- skill report <skill-id> --limit 5
npm run marrow -- skill report <skill-id> --json
npm run marrow -- skill report asd-transcript-distillery \
  --skill-root .omp/skills --limit 5
```

Treat adherence scores and suggestions as heuristics. Verify low-scoring checklist items against
reduced-session evidence before changing the skill.

## CLI verification

When verifying this skill against the current checkout, use an isolated runtime and exercise
every `workflow mine` option in one read-only invocation:

```bash
MARROW_ROOT="${TMPDIR:-/tmp}/marrow-cli-proof" \
  npm run --silent marrow -- workflow mine --days 30 --source pi --cluster validation \
  --recommendation adopt --include-decided --limit 20 --json
```

The command should exit successfully and emit JSON containing the requested `days` and `source`.
When a corpus refresh is in scope, verify the selected local adapter and index separately before
mining it:

```bash
ASD_PI_SESSIONS_ROOT="$HOME/.omp/agent/sessions" \
  npm run marrow -- ingest sync --source pi --resume
npm run marrow -- export-index
npm run marrow -- workflow mine --days 30 --source pi --limit 20 --json
```

## Optional LLM judging

Only when remote judging is explicitly in scope:

```bash
npm run marrow -- doctor provider
npm run marrow -- pipeline gate --max-per 5/24h --max-usd 1/24h
npm run marrow -- workflow judge --limit 5 --days 30 \
  --max-per 5/24h --max-usd 1/24h
```

Credentials must come from the approved environment or secret-manager flow. A local mining run
does not require `OPENROUTER_API_KEY`.

## Completion evidence

Report:

- runtime root used;
- adapters refreshed, or that the existing corpus was intentionally reused;
- exact mining window, source filter, and candidate limit;
- sessions scanned and candidate counts by confidence/recommendation;
- candidate IDs reviewed and their dispositions;
- drafts or real artifacts changed;
- whether any remote LLM call occurred and the applied count/USD limits;
- remaining contradicted, ambiguous, or stale-evidence items.
