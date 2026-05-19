# Agent Learning Systems: Landscape Report

Date: 2026-05-19
Author: research synthesis for [[agent-session-distillery]]
Status: report — input to a v2 design discussion

Surveys the GitHub landscape of projects that turn agent session
transcripts into compounding knowledge. Eight projects deep-read, plus
notes on adjacent finds. Companion files:
[`prior-art-deep-reads.md`](prior-art-deep-reads.md) holds the raw
deep-read notes; this report is the synthesis.

## Executive summary

The space splits cleanly into four categories. Each category answers a
different question.

| Category | Question answered | Representatives |
|---|---|---|
| Transcript viewers | "What happened in past sessions?" | claude-code-log, claude-notes, cursor-chat-export |
| Memory banks | "What context does Claude need next session?" | hudrazine/claude-code-memory-bank, claude-mind |
| Session memory + retrieval | "Pull past relevant conversation into the current session" | claude-self-reflect, ax-claude, mcp-session-insight |
| **Distillation systems** | **"Turn sessions into durable, scoped, scored knowledge"** | **asd, lamarck, ECC continuous-learning-v2, heartbeat dream** |

asd sits in the distillation category. The other three projects in that
quadrant each ship one or two architectural primitives asd does not yet
have. Combined, they sketch a clear v2 shape.

Three findings drove this report:

1. **Atomic instinct + confidence score** (from ECC continuous-learning-v2)
   replaces "session learning blob" as the primary storage unit. Unlocks
   dedup, promotion, decay, and skill evolution. Highest-leverage change.
2. **Curated `MEMORY.md` exporter with maturity ladder** (from lamarck)
   replaces "directory of session learnings" with a tight rollup Claude
   Code actually loads. Concrete decay formula included (90-day half-life,
   4× harmful multiplier).
3. **MCP server surface over the distilled corpus** (from claude-self-reflect)
   makes the output queryable at runtime, not just readable post-hoc.
   Required to compete on UX.

Beyond those three, four secondary directions are worth committing to in
the same v2: cross-project promotion via git-remote-hash IDs, evolution
of clustered instincts into hub skills, an `asd skill <name>` adherence
mode, and SessionEnd-hook auto-ingest.

## Landscape map

### Direct siblings (distillation)

- **[lamarck](https://github.com/johnlindquist/lamarck)** — npm CLI;
  per-project `playbook.yaml` + `MEMORY.md`; lifecycle ladder; 90-day
  decay; skill-adherence mode. Architecturally closest to asd.
- **[ECC continuous-learning-v2](https://github.com/affaan-m/ECC/tree/main/skills/continuous-learning-v2)** —
  Claude Code skill; atomic instincts with confidence scoring; PreToolUse
  hooks; git-remote-hash project IDs; cross-project promotion; evolution
  into skills/commands/agents.
- **[claude-heartbeat dream skill](https://github.com/wooson00308/claude-heartbeat)** —
  Python daemon; preprocessor compresses transcripts; LLM-free scheduler
  decides *when* to invoke skills.
- **agent-session-distillery (this project)** — TS CLI; multi-adapter
  ingest (Cursor + Codex CLI + Pi); LLM-gated review; vault carve-out
  push.

### Adjacent (memory + retrieval, not distillation)

- **[claude-self-reflect](https://github.com/ramakay/claude-self-reflect)**
  (214★) — npm + MCP; SQLite + HNSW + FastEmbed; 6 lifecycle hooks
  auto-inject context; Batch API narratives ($0.012/conversation).
- **[ax-claude](https://github.com/mqjinwon/ax-claude)** — shell-driven;
  per-project memory split into 5 files; 4-tier skill router; PreToolUse
  rate-limit hook.
- **[claude-code-memory-bank](https://github.com/hudrazine/claude-code-memory-bank)**
  (38★) — Cline-derived project context bank.
- **[mcp-session-insight](https://github.com/ArtLjn/mcp-session-insight)** —
  MCP server for read/analyze/handoff of sessions.

### Adjacent (self-improvement framing)

- **[BetterForAll/self-improving-agents](https://github.com/BetterForAll/self-improving-agents)**
  (53★) — 4-level conceptual progression. Frames asd as L1 (binary
  accept/reject) and points at L2 (explanatory review).
- **[MaximeRobeyns/self_improving_coding_agent](https://github.com/MaximeRobeyns/self_improving_coding_agent)**
  (328★) — L3 reference implementation. Cite, don't copy.

### Transcript viewers (orthogonal but heavily starred)

- **[claude-code-log](https://github.com/daaain/claude-code-log)** (1033★)
- **[claude-notes](https://github.com/vtemian/claude-notes)** (76★)
- **[somogyijanos/cursor-chat-export](https://github.com/somogyijanos/cursor-chat-export)**
  (247★)
- **[0dust/claude-code-history-search](https://github.com/0dust/claude-code-history-search)**

## Per-project deep reads

Each entry: shape, mechanisms worth borrowing, what to skip.

### 1. lamarck (`johnlindquist/lamarck`)

**Shape.** npm CLI, TypeScript. Six-stage pipeline:

```
History → Incremental scan → Per-project queue → LLM reflection
→ Quality gates → Playbook curation → MEMORY.md export
```

Byte-offset cursor over `~/.claude/history.jsonl`. Per-project storage
at `~/.lamarck/projects/<encoded-path>/playbook.yaml`. Topic-file split:
`workflow.md`, `tooling.md`, `preferences.md`, `pitfalls.md`,
`debugging.md`. Curated `MEMORY.md` capped at ~200 lines with drill-down
links.

**Mechanisms worth borrowing**

- Lifecycle ladder: **candidate → established → proven → deprecated**.
- 90-day exponential decay with **4× multiplier on harmful feedback**.
- Diary-plus-deltas as the LLM review output (narrative for humans,
  structured deltas for the playbook).
- Quality gates as an explicit stage *before* the LLM call (dedup,
  filter, quota).
- Secret redaction pre-pass.
- **`lamarck skill <name>`** mode: evaluate SKILL.md adherence across
  real session evidence and propose improvements. Distinctive feature.
- Byte-offset cursor for append-only sources (simpler than manifests).
- Idempotent replay via `processed.jsonl` ledger.

**Skip.** Distribution mode (npm). asd's CLI shape works.

### 2. ECC continuous-learning-v2 (`affaan-m/ECC`)

**Shape.** Claude Code skill, not a CLI. PreToolUse + PostToolUse hooks
capture observations; a background Haiku agent extracts atomic
"instincts" with confidence scoring. v2.1 added project-scoping by git
remote hash.

Instinct schema:

```yaml
id: <slug>
trigger: <when this matters>
confidence: 0.3..0.9
domain: <code-style|testing|git|debugging|workflow>
source: <session-id>
scope: project|global
project_id: <git-remote-hash>
```

XDG-compliant storage at
`${XDG_DATA_HOME:-~/.local/share}/ecc-homunculus/`. Project storage at
`projects/<hash>/instincts/personal/`. Global at
`instincts/{personal,inherited}/`. Evolved artifacts at
`evolved/{agents,skills,commands}/`.

**Mechanisms worth borrowing**

- Atomic instinct as primary storage unit instead of session-learning
  blob.
- Confidence math: increase when patterns repeat without correction,
  decrease on explicit correction or extended absence.
- Background Haiku agent for the extraction pass. Explicit cheap-model
  routing.
- **Git-remote-hash project ID**, portable across machines.
- **Cross-project promotion**: same instinct ID in ≥2 projects with avg
  confidence ≥ 0.8 → auto-promote to global.
- **Evolution pipeline**: `instincts → cluster → skill/command/agent`.
  Promotes high-evidence clusters into proper artifacts.
- `/instinct-export` and `/instinct-import` for cross-machine sharing.
- XDG-compliant paths.

**Skip carefully.** Live hook-based observation. asd's value prop is
post-hoc LLM-gated review. Mixing those is a product shift, not a
refactor.

### 3. claude-heartbeat (`wooson00308/claude-heartbeat`)

**Shape.** Python preprocessor + OS-level daemon (launchd / Task
Scheduler / systemd). Two skills: `dream` (consolidate transcripts →
memory) and `heartbeat-register` (NL → job spec).

Job DSL fields: `slug`, `prompt`, `interval`, `timeout`, `condition`,
`notify`, `max_per` (sliding-window quota like `5/24h`).

The dream skill follows **KAIROS**: *"Orient → Gather → Consolidate
→ Prune & Index"*. Preprocessing folds tool calls (`[도구: Bash, Read x2]`)
and truncates code blocks past 3 lines.

**Mechanisms worth borrowing**

- **Daemon-LLM separation**: the daemon never calls the LLM. It only
  decides when to. *"데몬 자체는 LLM 호출 안 함 → 상주해도 비용 0."*
- **Sliding-window cost budget** (`max_per: N/24h`).
- **Condition gate** as a cheap pre-check before any LLM invocation.
- Aggressive transcript pre-compression (tool-call folding, code-block
  truncation).

**Skip.** OS scheduler registration. Packaging concern.

### 4. claude-self-reflect (`ramakay/claude-self-reflect`, 214★)

**Shape.** npm package + Node `csr-engine`. Local SQLite + HNSW +
FastEmbed (384-dim embeddings). 44 MB binary. 12 MCP tools. 6 lifecycle
hooks auto-inject context. Optional Batch API "AI Narratives" at
$0.012/conversation, 9.3× search-quality improvement, 82% token
compression.

**Mechanisms worth borrowing**

- **MCP server surface** as the primary retrieval interface. Tools like
  `csr_reflect_on_past`, `search_by_recency`, `csr_search_by_file`,
  `csr_search_insights`.
- Local embeddings + HNSW (FastEmbed) for sub-millisecond search.
- **`search_by_file`** for "what have we learned about this file?"
- Recency-weighted retrieval.
- Batch API for non-interactive review passes (~10× cost reduction).
- Aggregated insights as a distinct query type from per-result search.

**Skip / defer.** AST-aware code search. Six lifecycle hooks (pick one
or two with highest payoff; SessionStart inject is the obvious winner).

### 5. ax-claude (`mqjinwon/ax-claude`)

**Shape.** Shell-script-driven Claude Code plugin. Per-project memory
at `<project>/.ax/memory/` split into single-concern files. 4-tier
skill router. PreToolUse rate-limit hook.

Memory split: `MEMORY.md` (index), `decisions.md`, `research-notes.md`,
`experiment-log.md`, `study-notes.md`.

Ingest adapter chain on SessionEnd: bootstrap → OMC data → research
outputs → routing overrides → auto-compact.

**Mechanisms worth borrowing**

- Single-concern memory file split (analogous to lamarck's topic split
  but different cleavage).
- **PreToolUse hook for the vault carve-out.** Replace asd's social
  guarantee with a technical one.
- **SessionEnd hook → `asd ingest sync`.** Removes cron coupling.
- **Auto-compaction at file-size cap** with merge of duplicates and
  demotion of stale entries.
- **Tiered budget thresholds**: ≥80% warn, ≥90% pause, 100% block.

**Skip.** 4-tier skill router. asd is not a router. LLM-fallback layer
adds cost without commensurate value.

### 6. BetterForAll/self-improving-agents (53★)

**Shape.** Educational progression. Four levels:

| Level | Mechanism | asd analog |
|---|---|---|
| L1 AutoResearch | Binary accept/reject from a benchmark | asd today |
| L2 Feedback | Reviewer explains why + suggests fix | asd v2 review pass |
| L3 HyperAgent | Agent rewrites own source | Out of scope |
| L4 Arena | Adversarial code-vs-test co-evolution | Out of scope |

**Borrowable framing.** "Asymmetric information": *"the worker sees
only the code, the reviewer sees full history."* Maps onto asd's
two-pass design — extraction works from one session, but the review/
synthesis pass should have *full project history* as context.

### 7. MaximeRobeyns/self_improving_coding_agent (328★)

L3 reference implementation. Workshop paper. Docker-isolated. Cite as
positioning, do not borrow code. The eval → archive → improve loop is
the template that lamarck, ECC, and asd all implement in lighter forms.

### 8. claude-heartbeat dream-system doc (companion to #3)

Worth a separate note: the dream skill's preprocessing stage explicitly
optimizes for the *next* LLM pass. It is not "make markdown for
humans"; it is "produce the cheapest prompt that still preserves the
signal the reflection pass needs." That framing is borrowable.

## Cross-cutting themes

### Theme 1: atomic units beat session blobs

ECC v2's biggest insight: the storage unit should be smaller than a
session. lamarck independently arrives at the same conclusion via
"bullets" in `playbook.yaml`. asd's session-learning blob is the unit
that *least* supports downstream operations (dedup, promotion, decay,
clustering). v2 should refactor around an atomic unit (instinct /
bullet) and treat session learnings as bundles.

### Theme 2: maturity ladders beat binary state

lamarck's candidate → established → proven → deprecated and ECC v2's
confidence 0.3-0.9 are the same idea expressed two ways. asd's
pending/approved review state collapses too much information. A
real maturity model lets the synthesis pass prefer high-confidence
items and lets garbage decay automatically.

### Theme 3: cost-bounding is a first-class concern

heartbeat's `max_per: N/24h`, claude-self-reflect's Batch API,
ax-claude's 80/90/100% thresholds, and ECC v2's Haiku-pinned extraction
all attack the same problem from different angles. Today asd has no
explicit budget contract. Adding one is cheap and avoids the failure
mode where a 50-session backlog cleans the operator's OpenRouter
balance.

### Theme 4: MCP is the runtime contract

claude-self-reflect's UX promise — *"No commands. Install once, and
past context appears automatically"* — depends on the MCP surface +
lifecycle hooks. Static markdown in a vault is useful only if a human
opens it. To compete on UX, asd needs an MCP server.

### Theme 5: cross-project knowledge is the unmapped territory

Every project here is per-project. ECC v2's promotion-to-global
mechanism is the only attempt at cross-project knowledge transfer in
the survey. This is open territory. asd already touches multiple
projects through ingest; growing a "promote to operator-wide" tier is
a credible product direction nobody else has shipped well.

### Theme 6: skill drift is unexploited

Only lamarck's `lamarck skill <name>` mode attempts to use session
evidence to evaluate the agent's own skill files. The operator has a
large hub of skills under `~/.hub/`. asd has session transcripts. The
join is uniquely available to this operator and unmatched in the
landscape. Highest-leverage *distinctive* feature in the table.

## Strategic implications for asd

### What changes about asd's positioning

Today asd is "ingest transcripts and produce reviewed learnings as
vault markdown." That is one slice of a broader product surface this
landscape implies:

- **Producer of atomic, scored, project-scoped instincts.**
- **MCP server exposing those instincts to running Claude Code
  sessions.**
- **Promoter of consistent cross-project instincts into operator-wide
  knowledge.**
- **Evaluator of hub-skill adherence using session evidence.**
- **Generator of skill drafts from clusters of promoted instincts.**

These are not five products. They are five surfaces of the same
distillation pipeline, each fed by the same atomic-instinct store. The
v1 vault-markdown output remains valid; it becomes one *renderer* of
the store, not the store itself.

### What stays the same

- Multi-adapter ingest (Cursor + Codex CLI + Pi). None of the surveyed
  projects touch more than one source.
- LLM-gated review with operator approval. The Batch API and
  fully-automatic paths compete on cost but lose the trust property
  asd's reviewers care about. Keep both modes; default interactive.
- Vault as the durable human-readable surface. asd is the only project
  in the landscape that writes to a personal vault. Don't abandon that;
  treat it as one of multiple renderers.

### Risks and gotchas

- **Atomic-unit refactor is foundational.** It touches schema, dedup,
  review, push, and the wiki carve-out. Sequence it before any of the
  follow-on features.
- **MCP server scope-creep.** Easy to grow a 12-tool surface like
  self-reflect's. Resist. Ship 3: `search_instincts`,
  `instincts_for_file`, `recent_instincts`. Add more after measurement.
- **Hub skill generation.** Crossing from the asd carve-out (vault) into
  the hub canonical layer (`~/.hub/artifacts/skills/<id>/`) is a
  privilege jump. Needs a guard rail equivalent to the current vault
  carve-out: explicit operator approval, scoped target path, audit log.
- **Cross-project promotion.** Git-remote-hash IDs are clean for repos
  with remotes. asd ingests sessions from multiple sources, not all of
  which have remotes (e.g. ad-hoc Cursor workspaces). Project ID needs
  a fallback chain: git remote → workspace path hash → user-declared
  key.

## Tiered backlog (combined Round 1 + Round 2)

### Tier 1 — foundational

| Idea | Source | Notes |
|---|---|---|
| Atomic instinct as primary unit (YAML + confidence 0.3-0.9) | ECC v2 | Refactor first; everything else builds on it. |
| MCP server surface | self-reflect | 3 tools initially. |
| Curated `MEMORY.md` per project (~200 lines + drill-down links) | lamarck | New default render of the store. |
| SessionEnd hook → `asd ingest sync` | ax-claude | Removes manual coupling. |
| Daemon-LLM separation | heartbeat | Watcher decides "is there work?"; LLM only runs when yes. |
| Cross-project promotion via git-remote-hash IDs | ECC v2 | Operator-wide knowledge tier. |
| `asd skill <name>` adherence analysis | lamarck | Distinctive product surface. |
| Evolution: clusters → generated hub skills | ECC v2 | Longest horizon. Design v2 to support, ship later. |

### Tier 2 — cost / safety / quality

| Idea | Source | Notes |
|---|---|---|
| Lifecycle ladder (candidate → established → proven → deprecated) | lamarck | Replace binary review. |
| 90-day exponential decay + 4× harmful multiplier | lamarck | Concrete formula. |
| Diary + deltas LLM output format | lamarck | Splits human-readable from machine-applicable. |
| Quality gates as explicit pipeline stage | lamarck | Cheap, measurable, pre-LLM. |
| Secret redaction pre-pass | lamarck | Non-negotiable. |
| Cheap-model pinning for extraction (Haiku / local) | ECC v2 | Premium spend only on synthesis. |
| Sliding-window LLM budget (`max_per: N/24h`) | heartbeat | Backlog protection. |
| Batch API option for review gate | self-reflect | Non-interactive path. |
| Real PreToolUse hook for vault carve-out | ax-claude | Technical guarantee. |
| Tiered budget thresholds (warn / pause / block) | ax-claude | Better UX than binary. |

### Tier 3 — retrieval and storage shape

| Idea | Source | Notes |
|---|---|---|
| Local embeddings + HNSW (FastEmbed) | self-reflect | Required for non-trivial MCP search. |
| `search_by_file` retrieval | self-reflect | Already have `source_refs.file_path`. |
| Recency-weighted retrieval | self-reflect | Trivial given timestamps. |
| Topic-file split by concern | lamarck | workflow/tooling/preferences/pitfalls/debugging. |
| Byte-offset cursor for incremental scan | lamarck | Simpler than manifest for append-only. |
| Idempotent-replay ledger | lamarck | Complements manifest. |
| Auto-compaction at file-size cap | ax-claude | Closes retention loop. |
| XDG-compliant storage paths | ECC v2 | Cheap nit. |

### Tier 4 — deferred

- L3/L4 self-modifying agent loops.
- AST-aware code search.
- Skill routing layer.
- Browser study UI.
- Live PreToolUse/PostToolUse observation capture.
- Per-OS scheduler registration (packaging concern).

## Open design questions

1. **Primary storage unit: session learning or atomic instinct?** ECC
   v2 makes the strongest case for atomic. Decide before any v2
   schema work.
2. **Project ID: path, git-remote-hash, or both with a migration?**
3. **Does asd ship an `asd promote` that writes to
   `~/.hub/artifacts/skills/<id>/`?** Makes asd a producer in the Hub
   Environment Contract, not just a consumer of vault space.
4. **Curated `MEMORY.md` vs `asd-learnings/` directory: which is
   primary?** lamarck makes the rollup primary and individual files
   the audit trail. Today asd is the opposite.
5. **Where does the carve-out boundary move if asd produces curated
   rollups?** Current scope is
   `~/vault/wiki/projects/<key>/asd-learnings/`. A rollup at
   `~/vault/wiki/projects/<key>/MEMORY.md` is *outside* the carve-out
   as currently scoped. Renegotiation is needed.
6. **MCP server tool surface: 3 vs 12.** Self-reflect ships 12. Adopt
   the constraint up front: ship 3, measure, add only with evidence.
7. **Cross-project promotion threshold: hard-coded or configurable?**
   ECC uses 2-project, confidence ≥ 0.8. Plausible defaults; operator
   wants tunable.
8. **`asd skill <name>` scope.** Operator's `~/.hub` has dozens of
   skills. Pick one or two and ship for those first.

## Appendix A: search methodology

Searches were executed via `gh search repos` with terms in three
families:

- Direct: "cursor agent transcripts", "claude code session memory",
  "agent session learnings", "claude code transcript jsonl"
- Behavioral: "self-improving coding agent", "claude code feedback
  loop", "agent reflection diary", "agent skill mining"
- Conceptual: "lamarck inheritance learning", "homunculus claude",
  "memory promotion", "claude knowledge graph persistent memory"

The thinnest matches came from conceptual searches (most returned
zero results). The richest came from "claude code session memory" and
"claude code transcript jsonl" — those are the discoverable terms in
the ecosystem right now.

## Appendix B: projects surveyed but not deep-read

- `affaan-m/ECC/skills/continuous-agent-loop` — sibling of v2.
- `affaan-m/ECC/skills/agent-introspection-debugging` — debugging an
  agent's own behavior across sessions.
- `affaan-m/ECC/skills/agent-sort` — different problem (trim ECC to
  project's stack); parallel-reviewer pattern is borrowable elsewhere.
- `joelhans/bmo-agent` (35★) — self-improving agent variant.
- `maximgalson/autopilot-cc` (4★) — session memory + auto-checkpoints
  + defocus detection.
- `keepgoing-dev/claude-plugin` — re-entry briefings.
- `hudrazine/claude-code-memory-bank` (38★) — Cline-derived bank.
- `rollcarry/claude-mind` (1★) — LLM-first memory bank.
- `natapplefuji/lab_claude_2` — tutorial repo, not a tool.
- `daaain/claude-code-log` (1033★), `vtemian/claude-notes` (76★),
  `somogyijanos/cursor-chat-export` (247★) — viewers, not distillers.

## Related

- [[Iterative Retrieval]]
- [[Sub-Agent Context Problem]]
- [[Continuous Learning Systems]]
- [[Agent Orchestration]]
- [[Cost-Aware Routing]]
