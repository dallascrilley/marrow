# Prior-art deep reads: heartbeat, self-reflect, ax-claude

Date: 2026-05-19
Status: research notes — not yet a design proposal

Three projects identified as the closest siblings to asd. This note captures
their architecture and lists ideas worth integrating, tiered by impact and
fit. Companion to [vault-push-source-strategy.md](vault-push-source-strategy.md)
and the per-source strategy notes.

## 1. claude-heartbeat (`wooson00308/claude-heartbeat`)

**Shape**: Python preprocessor + OS-level daemon (launchd / Task Scheduler /
systemd) that periodically wakes Claude to run skills. Two skills shipped:
`dream` (consolidate transcripts → memory) and `heartbeat-register` (NL → job
spec). 1★.

**Architectural primitives**

- Three-layer pipeline: config (`HEARTBEAT.md`) → condition gate (shell
  command, exit 0 = run) → execution (`claude -p "{prompt}"`).
- Daemon never calls the LLM. It only decides *when* to. "데몬 자체는 LLM 호출
  안 함 → 상주해도 비용 0."
- Job DSL fields: `slug`, `prompt`, `interval`, `timeout`, `condition`,
  `notify`, `max_per` (sliding-window quota e.g. `5/24h`).
- `dream` runs the KAIROS loop: **Orient → Gather → Consolidate → Prune &
  Index**. Produces topic files plus a `MEMORY.md` index update.
- Preprocessing compresses transcripts before the skill sees them: drop
  system messages, fold consecutive tool calls into `[도구: Bash, Read x2]`,
  truncate code blocks past 3 lines.
- Skill is invoked non-interactively (`claude -p "/dream"`), so the prompt
  must be self-contained.

**What asd should steal**

1. **Daemon-LLM separation principle.** asd's `ingest sync` currently does
   file scan + manifest diff *and* fires the LLM review gate in one step.
   Split them. A cheap watcher decides "is there new work?"; only when yes
   does the LLM-gated pass run.
2. **Sliding-window cost budget.** Adopt `max_per: N/24h` semantics for the
   OpenRouter-gated review command. Prevents a 50-session backlog landing
   all at once and costing $20.
3. **Condition gate.** Even when invoked manually, a `--if-new` style flag
   that exits cleanly when no new transcripts exist would make scheduled
   runs cheap and idempotent.
4. **Transcript pre-compression before LLM review.** asd already trims
   transcripts, but heartbeat's tool-call folding + code-block truncation
   is more aggressive than what we do today. Worth measuring against
   review-output quality.

**Skip**

- The launchd/systemd registration layer. asd already runs from `cron` or
  ad hoc; OS scheduler registration is a packaging concern, not a design
  concern.
- Natural-language job registration. Overkill for an ingest tool.

## 2. claude-self-reflect (`ramakay/claude-self-reflect`)

**Shape**: npm package + Node `csr-engine`. Reads Claude Code JSONL,
embeds it locally, exposes 12 MCP tools, auto-injects context via 6
lifecycle hooks. 214★ — most validated UX in the space. Topics:
`ai-memory`, `mcp`, `qdrant`, `semantic-search`.

**Architectural primitives**

- Storage: SQLite + HNSW + FastEmbed (384-dim local embeddings). 44 MB
  binary. No external DB. Sub-millisecond p95 search.
- Three-layer enrichment: raw chunks → semantic embeddings → optional
  AI-generated narratives (Batch API, ~$0.012/conversation, 82% token
  compression, 9.3× search-quality improvement).
- AST-aware code search across 6 languages.
- MCP retrieval surface: `csr_reflect_on_past`, `search_by_recency`,
  `csr_search_by_file`, `csr_search_insights`, etc.
- Auto-injection via session lifecycle hooks (SessionStart,
  UserPromptSubmit, PostToolUse, Stop, PreCompact, SessionEnd). User
  never invokes retrieval explicitly.
- Session-scoped deduplication in PostToolUse. Stuck-loop pattern
  detection in Stop hook.

**What asd should steal**

1. **MCP server surface — biggest gap in asd today.** asd's distilled
   learnings sit as static markdown in the vault. Claude Code can read
   them only if it knows where to look. An `asd-mcp` server exposing
   `search_learnings(query)`, `learnings_for_file(path)`,
   `recent_learnings(window)`, `aggregate_themes()` would make the
   corpus useful *during* a session, not just after.
2. **Local embeddings + HNSW index.** FastEmbed is small; SQLite +
   HNSW is a few hundred lines. Pair with the MCP surface above so
   semantic search over learnings actually works.
3. **`search_by_file` is high-leverage.** asd already tracks
   `source_refs.file_path` on most learnings. Indexing by file path
   gives Claude Code an immediate "what have we learned about this
   file?" answer. Cheap to ship.
4. **Batch API for the LLM review gate.** $0.012/conversation is
   roughly an order of magnitude below interactive OpenRouter pricing.
   Adopt for any non-time-sensitive review pass.
5. **Aggregated-pattern synthesis.** `csr_search_insights` aggregates
   patterns across results. asd should have a periodic `asd synthesize`
   that finds recurring themes across distilled learnings — different
   output type from individual session learnings.
6. **Recency-weighted retrieval.** `search_by_recency` is a one-liner
   over an indexed timestamp; pairs well with asd's `manifest.json`.

**Skip / defer**

- AST-aware code search. Out of scope for asd's current value prop.
- Six lifecycle hooks. Pick one or two with the highest payoff
  (SessionStart auto-inject of recent project learnings is the clear
  winner).

## 3. ax-claude (`mqjinwon/ax-claude`)

**Shape**: shell-script-driven Claude Code plugin. Per-project memory
in `<project>/.ax/memory/` split into multiple files. Skill routing,
research ingestion, hook-enforced rate limiting. 0★ but the most
overlapping *vision* with asd's longer-term direction.

**Architectural primitives**

- Memory file split: `MEMORY.md` (index) + `decisions.md` +
  `research-notes.md` + `experiment-log.md` + `study-notes.md`.
  Each file has a single concern.
- SessionEnd ingest pipeline (adapter chain): bootstrap topic files →
  collect OMC data → ingest research outputs → sync routing overrides
  → auto-compact when size cap exceeded.
- 4-tier skill router: project override → keyword → TF-IDF on
  `examples:` field → LLM fallback.
- PreToolUse hook enforces both write-protection on `.ax/memory/`
  *and* tiered rate limits: ≥80% warn, ≥90% pause, 100% block.
- UserPromptSubmit hook auto-suggests related skills.
- `/ax learn` records timestamped decisions; `/ax learn route: K → S`
  declares project-level routing overrides.
- Adapter pattern: shell scripts in `~/.ax/adapters/` for each
  ingest source — mirrors asd's TS adapter pattern almost exactly.
- Per-project `.ax/config.yaml` for thresholds.

**What asd should steal**

1. **Split memory files per project.** Today asd writes everything
   under `~/vault/wiki/projects/<key>/asd-learnings/`. Splitting by
   concern (`decisions.md`, `open-problems.md`, `recurring-patterns.md`,
   `session-log.md`) gives Claude Code targeted reads and keeps any
   single file small enough to load fully.
2. **PreToolUse hook for the vault carve-out.** The CLAUDE.md
   amendment is a *social* guarantee that the asd carve-out won't grow.
   A real PreToolUse hook checking write paths against the carve-out
   pattern is a *technical* guarantee. Strictly better.
3. **SessionEnd hook to trigger `asd ingest sync`.** Removes the
   need for cron and removes the "I forgot to run it" failure mode.
4. **Auto-compaction when learning file grows past a cap.** asd has
   manifests + deletion receipts but no compaction. ax's pattern: when
   a topic file exceeds N lines/bytes, run a merge pass that collapses
   duplicates and demotes stale entries.
5. **Tiered budget thresholds.** 80% / 90% / 100% gives the user
   feedback before a hard stop. Better UX than asd's current "OpenRouter
   key missing → review disabled" binary.

**Skip / defer**

- 4-tier skill router. asd isn't a router and shouldn't become one.
- Browser quiz/Feynman UI. Out of scope.
- LLM-fallback routing as a default. The TF-IDF tier is the
  interesting idea; the LLM fallback adds cost without much value.

## Cross-cutting synthesis: tiered backlog for asd

### Tier 1 — fills the largest architectural gaps

| Idea | Source | Why |
|---|---|---|
| MCP server surface over distilled learnings | self-reflect | Learnings are useless if Claude Code can't query them mid-session. |
| SessionEnd hook → `asd ingest sync` | ax-claude | Removes manual / cron coupling. |
| Daemon-LLM separation: cheap watcher + gated distillation | heartbeat | Cleanly separates "is there work?" from "do the expensive work". |
| Periodic synthesis pass (`asd synthesize`) | self-reflect (`search_insights`) | Cross-session theme extraction is a different artifact type from per-session learnings. |

### Tier 2 — cost and safety

| Idea | Source | Why |
|---|---|---|
| Sliding-window LLM budget (`max_per: N/24h`) | heartbeat | Backlog protection. |
| Batch API for review gate | self-reflect | ~10× cheaper than interactive. |
| Real PreToolUse hook enforcing vault carve-out | ax-claude | Replaces social contract with technical guarantee. |
| Tiered budget thresholds (warn / pause / block) | ax-claude | Better UX than binary on/off. |

### Tier 3 — retrieval quality and structure

| Idea | Source | Why |
|---|---|---|
| Local embeddings + HNSW index (FastEmbed) | self-reflect | Required for the MCP surface to be more than substring search. |
| `search_by_file` retrieval | self-reflect | `source_refs.file_path` already in asd manifests. |
| Recency-weighted retrieval | self-reflect | Trivial given existing timestamps. |
| Split project memory files | ax-claude | Single-concern files load smaller and faster. |
| Auto-compaction when file exceeds cap | ax-claude | Closes the loop on retention/deletion receipts. |

### Tier 4 — deferred / not worth adopting

- AST-aware code search.
- Skill routing (asd is not a router).
- Natural-language job registration.
- Browser-based study UI.
- Per-OS scheduler registration (use cron / launchd at packaging time).

## Open design questions raised by this review

1. **Does asd need its own retrieval layer at all, or should the vault
   plugin own it?** `claude-obsidian` already indexes the vault.
   Duplicating embedding+HNSW in asd makes sense only if asd's MCP
   surface offers `source_refs`-aware queries (search_by_file,
   recent_for_project) that a generic vault search can't.
2. **Where does the synthesis pass write?** A per-project rollup
   (`asd-learnings/_themes.md`) is a clean target but it grows the
   vault carve-out. Worth re-examining the carve-out scope before
   shipping `asd synthesize`.
3. **Is the SessionEnd hook installed by asd or registered by the
   operator?** asd is repo-installed today; the hook lives in
   `~/.claude/settings.json`. Likely needs a `asd install-hooks`
   subcommand.
4. **Batch API vs interactive review.** Batch is cheaper but breaks
   the LLM-gated review UX where the operator approves/rejects each
   learning interactively. Probably want two modes.

---

# Round 2: meta-learning projects

Added 2026-05-19. Two projects pointed at us by the operator
(`johnlindquist/lamarck`, `affaan-m/ECC/skills/continuous-learning-v2`)
plus the closest siblings found by targeted search. These overlap asd's
charter much more directly than Round 1 — they all answer the question
"how do you turn a stream of agent sessions into compounding knowledge
the agent actually uses?"

## 4. lamarck (`johnlindquist/lamarck`)

**Shape**: npm CLI, TypeScript. Reads Claude Code's `~/.claude/history.jsonl`
incrementally and produces per-project `MEMORY.md` files plus a curated
`playbook.yaml`. Named after Lamarckian inheritance: *"Your Claude gets
smarter because of what it lived through."* No public star count yet,
but architecturally the closest sibling to asd we've found.

**Architectural primitives**

- Six-stage pipeline: *"Incremental scan (byte-offset cursor) →
  Per-project queue with retry tracking → LLM reflection (diary + deltas)
  → Quality gates (dedup, filtering, quotas) → Playbook curation (add,
  merge, deprecate) → MEMORY.md export."*
- Byte-offset cursor over `history.jsonl` so *"it never re-scans the
  same sessions."* Simpler than asd's manifest-based dedup.
- Playbook lifecycle per bullet: **candidate → established → proven →
  deprecated**. Maturity advances based on historical performance.
- **90-day exponential half-life** on feedback. **4× multiplier on
  harmful feedback** so corrections weigh more than reinforcements.
- Topic-file split by concern: `workflow.md`, `tooling.md`,
  `preferences.md`, `pitfalls.md`, `debugging.md`. Plus a `~200-line`
  curated `MEMORY.md` that links into them.
- Per-project storage at `~/.lamarck/projects/<encoded-path>/` with
  `playbook.yaml` (curated) and `processed.jsonl` (append-only session
  ledger for idempotent replay).
- LLM reflection produces both a "diary" (narrative) and "deltas"
  (structured changes to apply to the playbook). Two-track output is
  novel.
- Quality gates: dedup, filtering, quotas — *before* the LLM sees the
  candidate set.
- Secret redaction before LLM reflection.
- Distinct **`lamarck skill <name>`** subcommand: analyzes adherence
  to a `SKILL.md` across real session evidence and proposes
  improvements. Closes the loop on skill-drift.

**What asd should steal**

1. **Lifecycle ladder for learnings** (candidate → established →
   proven → deprecated). asd's review state is binary today. A real
   maturity model gives weight semantics and lets the synthesis pass
   prefer proven bullets.
2. **Topic-file split by concern** (workflow / tooling / preferences /
   pitfalls / debugging). Orthogonal to ax-claude's file-type split
   (decisions / research / experiments) — and probably more useful
   for asd because these match how *Claude Code* uses the file, not
   how the operator browses it.
3. **Curated `MEMORY.md` exporter with line cap + drill-down links.**
   asd writes flat learning files today. A `~200-line` curated rollup
   loaded by Claude Code via project CLAUDE.md is a much more usable
   surface than a folder of session learnings.
4. **Diary + deltas LLM output format.** Today asd's review pass
   produces learning blobs. Splitting into (a) narrative diary for
   humans and (b) structured deltas for the playbook gives the LLM a
   cleaner target and makes the structured layer auditable.
5. **Quality-gate pre-pass.** Dedup / filter / quota *before* the
   expensive LLM call. asd does some of this; making it an explicit
   pipeline stage with metrics is cheap and worthwhile.
6. **Secret redaction.** Explicit redaction pass before the OpenRouter
   call. asd should ship this as a non-negotiable safety pre-pass.
7. **`asd skill <name>` mode.** Operator's `~/.hub` skills already
   exist; asd already has session transcripts. Combining them to
   detect skill drift ("you said TDD is mandatory but in 7 of 12
   sessions touching this skill, no test was written first") is a
   high-value product surface that nobody else seems to be building.
   Could become asd's distinguishing feature.

**Skip**

- The npm packaging model is fine but asd's CLI shape already works.

## 5. ECC continuous-learning-v2 (`affaan-m/ECC/skills/continuous-learning-v2`)

**Shape**: A Claude Code skill, not a standalone CLI. PreToolUse +
PostToolUse hooks capture observations; a background Haiku agent
extracts atomic "instincts" with confidence scoring. v2.1 added
project-scoping. Sibling skills in the same repo: `continuous-learning`
(v1), `continuous-agent-loop`, `agent-introspection-debugging`,
`agent-sort`.

**Architectural primitives**

- **PreToolUse/PostToolUse hooks** for observation. 100% capture
  versus v1's Stop-hook 50–80% reliability.
- Atomic **"instincts"** as the storage unit (one observation, one
  YAML record) instead of v1's coarser "full skills".
- Instinct YAML: `id, trigger, confidence (0.3-0.9), domain, source,
  scope, project_id`.
- **Confidence math**: increases when patterns repeat without
  correction; decreases on explicit correction or extended absence.
- **Background Haiku agent** for extraction. Cheap model, explicit
  routing. Not "whatever OpenRouter picks".
- **Project ID by git-remote URL hash.** Portable across machines and
  checkouts. asd uses path keys today (machine-specific).
- **Promotion mechanic**: same instinct ID in ≥2 projects with avg
  confidence ≥ 0.8 → auto-promote to global via `/promote`.
- **Evolution pipeline**: `instincts → cluster → skill / command /
  agent`. Atomic observations accumulate, cluster, and graduate into
  proper Claude Code artifacts.
- XDG-compliant storage at `${XDG_DATA_HOME:-~/.local/share}/ecc-homunculus/`.
- `/instinct-export` and `/instinct-import` for cross-machine sharing.

**What asd should steal**

1. **Atomic learning unit + confidence score.** Replace "session
   learning blob" with "atomic instinct (YAML, scored 0.3-0.9)" as
   the primary storage type. Session learning becomes a *bundle of
   atomic instincts*, not the unit itself. This unlocks everything
   downstream (dedup, promotion, decay).
2. **Git-remote-hash as project ID.** Portable across operator's
   laptop/desktop/CI. asd uses path keys today, which silently fork
   across machines. Big UX win.
3. **Cross-project promotion mechanic.** Same instinct in N≥2
   projects + confidence threshold → promote to a global tier. asd
   today is strictly per-project; cross-project pattern detection is
   the obvious next vector.
4. **Explicit cheap-model routing for the extraction pass.** Today
   asd uses whatever OpenRouter model the operator configures. Pinning
   the cheap extraction pass to Haiku (or local Qwen) and reserving
   premium models for the optional synthesis pass is sound cost
   architecture.
5. **Evolution into hub skills.** The longest-leverage idea on this
   list. Clusters of consistent instincts should be promotable into
   `~/.hub/artifacts/skills/<id>/` (this operator's actual skill
   home) via a guarded `asd promote` workflow. asd → hub feedback
   loop. Not v0 work, but the shape to design toward.
6. **XDG-compliant paths.** Minor nit: `~/.agent-session-distillery/`
   should honor `XDG_DATA_HOME`.

**Skip / careful**

- **PreToolUse/PostToolUse hooks for observation.** Tempting because
  100% capture is genuinely better. But asd's value prop is *post-hoc*
  LLM-gated review, not live observation. Mixing models would make
  asd a different product. Leave hook-based capture to v2 if it
  matters; asd should stay transcript-driven.
- v2's evolution from v1 was largely "move the observer up the
  pipeline". For asd this isn't a needed shift.

## 6. BetterForAll/self-improving-agents (53★)

**Shape**: Educational progression of self-improving agent designs.
Four levels, each adding one mechanism. Not directly applicable but
gives asd a reference frame for where its own design sits.

| Level | Mechanism | asd analog |
|---|---|---|
| L1 AutoResearch | Binary accept/reject from a benchmark | asd today: review approves/rejects |
| L2 Feedback | Reviewer returns *why* + suggested fix | asd next: explanatory review w/ fix proposals |
| L3 HyperAgent | Agent rewrites own source across generations | Out of scope |
| L4 Arena | Adversarial co-evolution (code vs tests) | Out of scope |

**Takeaway for asd**

asd is L1. Moving to L2 means the review pass should not just decide
"keep / discard" — it should produce structured reasons and concrete
deltas (cf. lamarck's "diary + deltas"). The "asymmetric information"
framing (*"the worker sees only the code, the reviewer sees full
history"*) maps directly onto asd's two-pass design: extraction can
work from a single session, but the review/synthesis pass should have
full historical context (all prior learnings for the project) to make
good promotion/decay decisions.

## 7. MaximeRobeyns/self_improving_coding_agent (328★)

**Shape**: Reference implementation of an L3 self-modifying coding
agent (workshop paper). Docker-isolated. Eval → archive → improve loop.

**Takeaway for asd**

Not directly applicable. Mainly useful as a citation point: the
eval/archive/improvement loop is the template that lamarck,
continuous-learning, and asd all implement in milder forms. Worth
linking from asd's README to ground asd's "boring but useful"
positioning against the more ambitious self-modifying work.

## 8. Other adjacent finds (not deep-read)

- **`affaan-m/ECC/skills/continuous-agent-loop`** — sibling skill in
  the same repo. Continuous loop variant, likely complementary to
  continuous-learning-v2.
- **`affaan-m/ECC/skills/agent-introspection-debugging`** — debugging
  the agent's own behavior across sessions. Adjacent to asd's
  skill-drift idea.
- **`affaan-m/ECC/skills/agent-sort`** — different problem (trim ECC
  to a project's actual stack via six parallel review passes per
  component class). The parallel-reviewer pattern is borrowable
  elsewhere.
- **`joelhans/bmo-agent`** (35★), **`BetterForAll/self-improving-agents`**
  (53★) — referenced above.
- **`ArtLjn/mcp-session-insight`** — MCP server for Claude Code
  session insight (read/analyze/handoff). Tiny but the MCP-surface
  angle aligns with the Round 1 recommendation.
- **`natapplefuji/lab_claude_2`** — "Hands-on Claude Code learning
  playbook" — looks like a tutorial repo, not a tool.

## Revised tier list (Round 1 + Round 2 combined)

### Tier 1 — change asd's architecture in this direction

| Idea | Source | Why |
|---|---|---|
| **Atomic instinct as primary unit** (YAML + confidence 0.3-0.9) | ECC v2 | Unlocks dedup, promotion, decay, evolution. Bigger leverage than any single feature. |
| **MCP server surface over learnings** | self-reflect | Static markdown is wasted; runtime queryability is the unlock. |
| **Curated `MEMORY.md` export per project, ~200 lines, with drill-down links** | lamarck | The shape Claude Code actually loads. |
| **SessionEnd hook → `asd ingest sync`** | ax-claude | No more manual / cron. |
| **Daemon-LLM separation** (cheap watcher + gated distillation) | heartbeat | Cleanly separates "is there work?" from "do the work". |
| **Cross-project promotion** (instinct in N≥2 projects + confidence threshold → global) | ECC v2 | New product capability, not just a refactor. |
| **`asd skill <name>` adherence analysis** | lamarck | Distinctive feature nobody else owns; pairs naturally with operator's `~/.hub`. |
| **Evolution: clusters of instincts → generated hub skills** | ECC v2 | The longest-leverage idea on the page. Long horizon. |

### Tier 2 — concrete quality / cost / safety

| Idea | Source | Why |
|---|---|---|
| Lifecycle ladder (candidate → established → proven → deprecated) | lamarck | Replace binary review state with a maturity model. |
| 90-day exponential decay + 4× harmful-feedback multiplier | lamarck | Concrete decay formula. Adopt as default. |
| Diary + deltas as the LLM review output format | lamarck | Splits human-readable from machine-applicable. |
| Quality gates as an explicit pipeline stage (dedup/filter/quota) | lamarck | Cheap, measurable, before the LLM. |
| Secret redaction before LLM | lamarck | Non-negotiable safety pre-pass. |
| Cheap-model pinning for extraction (Haiku / local) | ECC v2 | Routes premium spend to synthesis only. |
| Sliding-window LLM budget (`max_per: N/24h`) | heartbeat | Backlog protection. |
| Batch API for the review gate | self-reflect | ~10× cheaper for non-interactive review. |
| Real PreToolUse hook enforcing vault carve-out | ax-claude | Technical, not social, guarantee. |
| Tiered budget thresholds (warn / pause / block) | ax-claude | Better UX than binary. |

### Tier 3 — retrieval and storage shape

| Idea | Source | Why |
|---|---|---|
| Git-remote-hash project ID | ECC v2 | Portable across machines. |
| XDG-compliant storage paths | ECC v2 | Cheap nit. |
| Topic-file split by concern (workflow/tooling/preferences/pitfalls/debugging) | lamarck | Better targeted reads. |
| Local embeddings + HNSW (FastEmbed) | self-reflect | Required for non-trivial MCP search. |
| `search_by_file` retrieval | self-reflect | `source_refs.file_path` already tracked. |
| Recency-weighted retrieval | self-reflect | Trivial given timestamps. |
| Byte-offset cursor for incremental scan | lamarck | Simpler than manifest-based for append-only sources. |
| Idempotent-replay ledger | lamarck | Complements manifest. |
| Auto-compaction at file-size cap | ax-claude | Closes the retention loop. |

### Tier 4 — deferred

- L3/L4 self-modifying agent loops.
- AST-aware code search.
- Skill routing layer.
- Browser study UI.
- PreToolUse/PostToolUse live-observation capture (mixes models with
  asd's post-hoc value prop).

## Updated open design questions

1. **Should asd's primary storage unit be "session learning" or
   "atomic instinct"?** (ECC v2 makes a strong case for the latter.)
   This is a foundational choice that touches everything downstream.
2. **Project ID: path-based, git-remote-hash, or both with a
   migration?**
3. **Does asd grow an `asd promote` that writes to `~/.hub/artifacts/skills/`?**
   This would make asd a producer in the hub maintenance system
   defined in `~/.claude/CLAUDE.md`'s "Hub Environment Contract"
   section, not just a consumer of vault space.
4. **Curated `MEMORY.md` vs `asd-learnings/` directory:** is the
   ~200-line rollup the *primary* artifact and the per-session files
   the *audit trail*, or the other way around? lamarck makes the
   rollup primary.
5. **Where does the carve-out boundary move if asd starts producing
   curated rollups?** Current carve-out is
   `~/vault/wiki/projects/<key>/asd-learnings/`. A curated
   `MEMORY.md` at the project root inside the carve-out is still
   within scope; a curated rollup that lives elsewhere is not.
6. **Skill-drift product surface (`asd skill <name>`): scope?**
   Operator's hub has dozens of skills. Even shipping this for one
   hand-picked skill would be a distinctive feature unmatched in the
   landscape we surveyed.
