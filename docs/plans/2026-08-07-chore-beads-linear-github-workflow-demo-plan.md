---
date: 2026-08-07
origin: conversation design (beads + Linear + GitHub multi-tracker for ASD demo)
td_epic: none-yet
status: ready-to-execute
---

# ASD Multi-Tracker Workflow Demo: Beads + Linear + GitHub

**Summary:** Make `agent-session-distillery` the full working demo of a hub-and-spoke issue workflow: beads owns agent execution, Linear owns human product planning, GitHub owns public/community issues and PR/CI gates. Migrate the live `td` backlog (14 issues), wire selective sync, freeze `td` as archive, and prove the loop with a scripted demo session.

Living document. Update Progress, Surprises, Decision Log, Outcomes as work proceeds. Reader needs only this plan + a clean ASD checkout to deliver.

## Purpose / Big Picture

After this work, an agent opening ASD:

1. Runs `bd ready` and only sees unblocked work.
2. Claims, discovers, blocks, and closes work **only in beads**.
3. Never invents Linear or GitHub Issues tickets mid-session unless promotion rules say so.
4. Pulls human roadmap changes from Linear into beads; pushes only promoted epics/features back.
5. Pulls public GitHub Issues into beads when they exist; uses GitHub **PRs/Actions** via beads gates, not as the task queue.
6. A human can open Linear and see a clean product board (epics/outcomes), not 40 agent micro-tasks.
7. A short demo script reproduces the full lifecycle in under 30 minutes.

This is intentionally a **workflow + repo policy** deliverable, not a product feature inside `asd` itself. Application code under `src/` is out of scope except if a tiny helper script under `scripts/` helps backfill.

## Progress

- [x] (2026-08-07) Design boundaries (hub-and-spoke; beads primary for agents).
- [x] (2026-08-07) Survey ASD trackers: 14 `td` issues, 0 open GH issues, no `.beads/`, Linear API items present in 1Password.
- [x] (2026-08-07) Author this plan.
- [x] (2026-08-08) U0 Preconditions (bd install, git hygiene, secrets readiness).
- [x] (2026-08-08) U1 ADR + operator runbook + agent policy docs.
- [x] (2026-08-08) U2 `bd init` + project config.
- [x] (2026-08-08) U3 Backfill from `td` → beads (parents, status, labels, external legacy ids).
- [x] (2026-08-08) U4 Linear project + selective pull/push wiring.
- [x] (2026-08-08) U5 GitHub Issues + PR/CI gate wiring.
- [x] (2026-08-08) U6 Freeze `td`, dual-track window close, cutover announcement in AGENTS.
- [x] (2026-08-08) U7 Scripted demo + acceptance proof transcript.
- [ ] U8 Optional: Dolt remote sync for multi-machine beads (only if demo needs multi-clone).

## Surprises & Discoveries

- Observation: `bd` is not currently on PATH in this environment (`bd not found`); install is a hard gate before any init. Evidence: shell `which bd` during planning.
- Observation: ASD `main` is `ahead 1, behind 42` with local dirt (`package-lock.json` deleted, untracked `pnpm-lock.yaml` / `pnpm-workspace.yaml`). Evidence: `git status -sb` 2026-08-07. Cutover must not land on a messy primary tip; reconcile first or work in a worktree.
- Observation: All listed GitHub Issues are **CLOSED**; GH Issues is empty as an active intake surface today. Demo will seed 1–2 synthetic public issues and prove PR-gate path rather than depending on live community traffic.
- Observation: `td` parent links exist (7 children → 4 epics/parents) but no first-class `blocks` dependency edges beyond status `blocked`. Beads will map `parent_id` → parent-child hierarchy; blocked status stays as status until real blockers are known from handoff notes.
- Observation: Linear API credentials already exist in 1Password (`Linear API - dallascrilleymartech workspace`, personal, Agents Team). Do not invent new keys until discovery gate fails.
- Observation: AGENTS.md is pure repo guidelines today — no issue-tracker section. Beads will need a clear agent contract section without deleting coding guidelines.

## Decision Log

- **Decision:** Hub-and-spoke with **beads as agent SoT**, not triple bidirectional sync.  
  **Rationale:** Full bi-sync across three systems thrashes status/claims; beads has ready/deps/claim semantics Linear and GH lack.  
  **Date:** 2026-08-07.

- **Decision:** One bead has **at most one remote primary** via `external_ref` (Linear URL *or* `gh-N`, never both as primary). Secondary system gets a comment/link only if needed.  
  **Rationale:** Beads stores a single `external_ref`; dual homes cause silent skip/overwrite on sync.  
  **Date:** 2026-08-07.

- **Decision:** Issue class → home mapping:

  | Class | Home | Mirror |
  |---|---|---|
  | Agent micro-tasks, discovery, session crumbs | Beads only | Never |
  | Wisps / ephemeral | Beads only | Never push |
  | Product epics / human outcomes | Linear (pull into beads) | Selective push status |
  | Public/community bugs | GitHub Issues (pull into beads) | Optional close-sync |
  | PR / CI waits | GitHub PR/Actions | Beads gates (`gh:pr`, `gh:run`) |

  **Date:** 2026-08-07.

- **Decision:** Cut over **off `td`** after successful backfill + one real agent session on beads. Keep `.todos/` read-only for 14 days as archive; do not dual-write.  
  **Rationale:** Dual SoT is the failure mode we are escaping.  
  **Date:** 2026-08-07.

- **Decision:** Beads ID prefix `asd` (issues like `asd-a1b2c3`).  
  **Rationale:** Short, matches product nickname, avoids collision with hub `td-*` ids in chat.  
  **Date:** 2026-08-07.

- **Decision:** Linear receives **epics + open product features only** on first push; agent `task` children stay beads-local until explicitly promoted.  
  **Rationale:** Board readability is the demo value of Linear.  
  **Date:** 2026-08-07.

- **Decision:** Prefer local beads on execution-field conflicts; prefer Linear on planning pull for linked roadmap items; prefer GitHub on public-issue pull. Default `prefer-newer` only when no class rule applies.  
  **Date:** 2026-08-07.

- **Decision:** Work in an isolated worktree for cutover if primary remains diverged; do not force-reconcile foreign dirt.  
  **Date:** 2026-08-07.

## Outcomes & Retrospective

**2026-08-08 cutover demo completed** on branch `asd-beads-workflow` / primary beads DB prefix `asd`.

- Migrated 14 `td` issues → beads (`legacy:td-*` labels; id-map under `.agents-state/tracker-migration/`).
- Linear project [Agent Session Distillery](https://linear.app/dallascrilley/project/agent-session-distillery-cc5ba82b08da) holds 4 epics (AGE-54..57) linked via `external_ref`.
- GitHub public demo issue #156 → bead `asd-t5s` (`gh-156`).
- `td` frozen via `.todos/FROZEN.md`; AGENTS/CLAUDE/README policy updated.
- Demo transcript: `.agents-state/tracker-migration/demo-transcript-20260808.md`.

**Surprise:** Homebrew `bd` 1.1.2 `bd linear sync --push` failed on multi-state Linear workflows (Agents team custom started states) even with `outbound_state_map`; epic create used Linear GraphQL + `bd update --external-ref` as workaround. Prefer newer bd or keep outbound maps + unique inbound maps when upgrading.

**U8** (Dolt multi-machine) deferred — single-machine demo sufficient.

## Context and Orientation

### Project

- Path: `/Users/dallascrilley/Code/agent-session-distillery`
- Remote: `https://github.com/dallascrilley/agent-session-distillery.git`
- Product: local CLI (`asd`) that distills agent transcripts into learnings/artifacts.
- Owner: `dallascrilley` (authorized for push/PR).

### Current trackers (2026-08-07)

**td (`.todos/`)** — active agent tracker, 14 issues:

| id | status | type | parent | title |
|---|---|---|---|---|
| td-31338a | in_progress | epic | — | Close the distillery feedback loop |
| td-4043b2 | in_progress | epic | — | Enforce audit-backed agent rules structurally |
| td-34b386 | in_review | epic | — | Unify pipeline, recall, and storage health |
| td-25b886 | open | epic | — | External staging storage |
| td-a9336a | in_progress | task | td-31338a | U12: Lift learning reachability |
| td-e2bc6d | blocked | task | td-31338a | U6: trigger backfill for trigger-less instincts |
| td-29b2ef | blocked | feature | td-4043b2 | R1: Stop-hook verification-evidence gate |
| td-1d395b | blocked | feature | td-4043b2 | R3: PreToolUse long-command timeout guard |
| td-54acae | in_progress | task | td-4043b2 | R4: Restore tdd-guide skill surface |
| td-cd9cfa | in_review | task | td-34b386 | H3: Surface shared health in dashboard |
| td-0e1533 | open | task | td-25b886 | U5: Optional S3 cold-tier |
| td-ed46e3 | in_progress | task | — | Decompose extract.ts |
| td-9ad669 | open | task | — | Extraction/summary polish backlog |
| td-626d72 | open | task | — | Text-normalizer + rereduce polish |

Ready-ish today (td ready): `td-25b886`, `td-0e1533`, `td-9ad669`, `td-626d72`.

**GitHub Issues:** no open issues; history is closed launch/docs work (#16–#21). PR templates and CI workflows already exist under `.github/`.

**Linear:** not wired to this repo yet. API keys available in 1Password.

**Beads:** not initialized here. System `bd` CLI must be installed first (`brew install beads` preferred; or install script / local build from `/Users/dallascrilley/Code/beads`).

### Terms

- **Hub:** beads — agents read/write here.
- **Spoke:** Linear or GitHub Issues — human/public surfaces linked by `external_ref`.
- **Promotion:** deliberate push of a bead (usually epic/feature) to a spoke.
- **Gate:** beads async wait on GH PR/CI, not an issue.
- **Freeze:** stop writing to `td` after cutover.

## Requirements

- **R1.** Beads is initialized in ASD with prefix `asd`, committed policy files, and a working local Dolt DB.
- **R2.** All 14 open/in-progress/blocked/in_review `td` issues are present in beads with status, priority, type, description, acceptance, parent links, and legacy id label/metadata (`legacy:td-…`).
- **R3.** Agent instructions force beads-only tasking (no `td` write path; no free Linear/GH issue creation).
- **R4.** Linear team/project exists for ASD; epics (and optionally open features) are linked or pushed; micro-tasks are not dumped.
- **R5.** GitHub: synthetic public issue(s) pull into beads; PR/CI demonstrated via beads gate docs/commands even if no live CI wait is required for the first demo.
- **R6.** Operator runbook documents session start/end, promote, conflict rules, and recovery.
- **R7.** Scripted demo transcript proves ready → claim → discover → block → promote → close → Linear/GH visibility.
- **R8.** `td` is frozen (documented + optional config flag); archive retained ≥14 days.
- **R9.** No secrets in git. Linear/GitHub tokens via env or `bd config` local only (not committed).
- **R10.** Demo is reproducible by a second agent reading only this plan + runbook.

## Key technical decisions

1. **Hub-and-spoke** — see Decision Log.
2. **Backfill via scripted `bd create`**, not hand entry. Export `td ls --json`, map fields, create parents first, then children with `--deps` / parent flags as supported by current `bd`.
3. **Preserve legacy ids** as labels `legacy:td-29b2ef` and notes line `Migrated from td-…` so old chat handoffs remain searchable.
4. **Status map (td → beads):**

   | td | beads |
   |---|---|
   | open | open |
   | in_progress | in_progress |
   | in_review | open + label `in_review` (or beads status if custom statuses exist; default: open + label) |
   | blocked | blocked |
   | closed | closed (not in current set) |

5. **Priority map:** P0→0 … P4→4.
6. **Type map:** epic/feature/task/bug/chore as-is; unknown → task.
7. **Linear config** (local `bd config set`, not committed secrets):

   ```bash
   bd config set linear.api_key "$LINEAR_API_KEY"
   bd config set linear.team_id "$LINEAR_TEAM_ID"
   bd config set linear.project_id "$LINEAR_PROJECT_ID"   # optional but preferred
   ```

8. **GitHub config:**

   ```bash
   bd config set github.repository "dallascrilley/agent-session-distillery"
   # token from GITHUB_TOKEN / gh auth
   ```

9. **Sync defaults for demo automation** (document as scripts, not always full bi-sync):

   ```bash
   bd linear sync --pull-if-stale --prefer-local
   bd linear sync --push --type epic,feature --exclude-type wisp --prefer-local
   bd github sync --pull-only
   # push only explicit ids
   bd github push <id>
   ```

10. **AGENTS.md** gains a **Issue Tracking (beads)** section modeled on beads integration profile `conservative` for git, but **mandatory** beads for task tracking (this repo opts into beads as SoT).

11. **Do not** remove application coding guidelines; only add tracking policy.

12. **Package manager note:** AGENTS says npm/`package-lock.json`; working tree currently has pnpm artifacts. Out of scope for this plan — do not switch managers as part of tracker work. Leave foreign lockfile dirt alone.

## Architecture (workflow)

```text
 Humans (plan)          Agents (execute)           Public / CI
      │                       │                        │
      ▼                       ▼                        ▼
  Linear board  ◄──pull──  Beads graph  ──pull──  GitHub Issues
      ▲            push       │  ready/claim           ▲
      │         (epic only)   │  deps/discover         │ push (rare)
      │                       │  gates ────────────────► PR / Actions
      │                       ▼
      │                  local Dolt (.beads/)
```

### Who may write where

| Actor | Beads | Linear | GH Issues | GH PR/CI |
|---|---|---|---|---|
| Coding agent | R/W | pull; push only promoted epics/features | pull; push only labeled public | create/update PR; gates |
| Operator | R/W | plan/prioritize | triage public | review/merge |
| Contributor | — | — | file issues | open PRs |

### Promotion rules (agent-enforceable)

Promote beads → Linear only when **all** are true:

1. Type is `epic` or `feature` (not `task`/`chore`/`wisp`).
2. Title is outcome-shaped (not “fix typo in test”).
3. Operator said “promote” **or** the bead has label `promote:linear`.
4. Not already having a Linear `external_ref`.

Promote beads → GitHub Issues only when labeled `promote:github` or type/public bug with operator request.

## Plan of Work

### U0. Preconditions

**Goal:** Tooling and tree ready so later units do not thrash.

**Steps:**

1. Install `bd` (Homebrew preferred):

   ```bash
   brew install beads
   bd version
   ```

   Fallback: build from `/Users/dallascrilley/Code/beads` if brew lags local main.

2. Confirm `gh auth status` and `GITHUB_TOKEN` usable for `dallascrilley/agent-session-distillery`.

3. Linear secrets discovery (do not print values):

   ```bash
   # Prefer Agents Team or martech workspace key for demo isolation
   op item get "Linear API - dallascrilleymartech workspace" --fields credential  # shape varies
   # Export LINEAR_API_KEY in session only
   bd linear teams   # after config, list teams; pick ASD team/project
   ```

4. Git posture: either

   - worktree for cutover: `wt switch --create asd-beads-workflow --yes` (or hubctl equivalent), **or**
   - reconcile primary if operator owns the divergence.

   Do **not** discard foreign lockfile dirt.

5. Snapshot td for rollback:

   ```bash
   mkdir -p .agents-state/tracker-migration
   td ls --json > .agents-state/tracker-migration/td-export-$(date -u +%Y%m%dT%H%M%SZ).json
   ```

**Verification:** `bd version` prints; secrets resolve without chat paste; git branch named for this work; snapshot file non-empty (14 issues).

### U1. ADR + runbook + agent policy (docs first)

**Goal:** Written contract before data moves.

**Files to create/modify:**

- Create: `docs/decisions/0010-multi-tracker-hub-spoke.md` — ADR restating Decision Log for the repo.
- Create: `docs/recipes/beads-linear-github-workflow.md` — operator runbook (session start/end, promote, sync, recovery).
- Create: `docs/recipes/beads-demo-script.md` — timed demo script for U7.
- Modify: `AGENTS.md` — add **Issue Tracking with beads** section; state `td` is frozen archive.
- Modify: `CLAUDE.md` only if it currently points agents at `td` (mirror a short pointer to AGENTS section).
- Modify: `README.md` — short “Tracking” subsection linking the recipe (1 short paragraph).

**AGENTS.md contract (required bullets):**

```markdown
## Issue Tracking (beads)

This repo uses **bd (beads)** as the agent task source of truth.

- Session start: `bd ready --json` then `bd update <id> --claim`
- Create work: `bd create "…" -t task|bug|feature|epic -p 0-4 --json`
- Link discovery: `bd create "…" --deps discovered-from:<parent-id> --json`
- Never use `td` for new work (`.todos/` is a frozen archive)
- Never open Linear or GitHub Issues unless label `promote:linear` / `promote:github` or operator says promote
- PR/CI waits: beads gates (`gh:pr`, `gh:run`), not new GH issues
- Prefer: `bd update` flags; do not use interactive `bd edit`
- Always pass `--json` for programmatic use
```

**Verification:** docs review; no secrets in files; ADR links to this plan path.

### U2. Initialize beads in ASD

**Goal:** Empty but configured tracker ready for import.

```bash
cd /Users/dallascrilley/Code/agent-session-distillery   # or worktree path
bd init --prefix asd
# optional hooks: accept beads defaults unless they fight existing hooks
bd config set github.repository "dallascrilley/agent-session-distillery"
# linear keys after U0
bd ready   # empty OK
```

Commit **non-secret** beads scaffolding only (`.beads/config.yaml` if committed by design, `.gitignore` updates beads needs, integration block in AGENTS). Do **not** commit DB secrets. Follow whatever current beads `.gitignore` / Dolt guidance says for which `.beads/` paths are tracked vs local.

**Verification:** `bd list` works; prefix is `asd`; `bd github status` shows repo; no API keys in `git grep -i linear.api`.

### U3. Backfill td → beads

**Goal:** Faithful migration of the 14-issue graph.

**Approach:**

1. Write `scripts/migrate-td-to-beads.mjs` (or `.ts` run via existing node) that:

   - Reads snapshot JSON from U0.
   - Sorts parents (no `parent_id`) before children.
   - Maps fields per Key technical decisions.
   - Calls `bd create` via subprocess with `--json`.
   - After create, applies status with `bd update` if create always starts `open`.
   - Records mapping `td-id → asd-id` to `.agents-state/tracker-migration/id-map.json`.
   - Sets parent relationships (beads parent/child API as supported — typically create child then `bd dep add` / update parent, or use create flags from `bd create --help` at execution time).
   - Adds label `legacy:td-…` and description footer with migration stamp.

2. Dry-run mode prints planned creates without executing.

3. Run for real; then:

   ```bash
   bd list --json | jq length   # expect 14
   bd ready --json
   bd show <epic-id>
   ```

4. Manual fix-up pass for the three `blocked` issues: if handoff names a concrete blocker, add `bd dep add <id> --blocks <blocker>`; else keep status blocked with notes from td description.

**Field mapping detail:**

| td field | beads |
|---|---|
| title | title |
| description | description |
| acceptance | acceptance (or acceptance_criteria flag) |
| type | issue_type |
| priority P1 | priority 1 |
| parent_id | parent link after id-map |
| labels | labels + `migrated-from-td` |
| status | post-create update |
| points | notes or metadata if no first-class field |

**Verification:**

- 14 beads exist.
- Every legacy id appears in `bd list --json` labels or description.
- Parent of R1/R3/R4 is harness epic; U6/U12 under feedback-loop epic; H3 under health epic; U5 under staging epic.
- `bd ready` does **not** list blocked items as ready.
- id-map committed under `.agents-state/` only if that dir is meant to be tracked; otherwise keep local and attach mapping into the recipe as a table for the demo.

### U4. Linear wiring + selective push

**Goal:** Human board shows 4 epics (and optionally open product features), not the whole task soup.

**Steps:**

1. Create Linear project **Agent Session Distillery** under the chosen team (UI or Linear API). Record team UUID + project UUID in operator notes (not necessarily git).

2. Configure:

   ```bash
   bd config set linear.api_key "$LINEAR_API_KEY"
   bd config set linear.team_id "$LINEAR_TEAM_ID"
   bd config set linear.project_id "$LINEAR_PROJECT_ID"
   bd linear status
   ```

3. Dry-run push of epics only:

   ```bash
   bd linear sync --push --type epic --dry-run
   bd linear sync --push --type epic --prefer-local
   ```

4. Confirm each epic has `external_ref` Linear URL: `bd show <id> --json | jq '.[].external_ref'`.

5. Document pull cadence: session start `bd linear sync --pull-if-stale --prefer-local`.

6. Optional: push open **features** that are human-visible (R1, R3) with label `promote:linear` first.

**Verification:** Linear board shows ~4 epics; opening Linear does not show polish tasks `asd-…` for extract polish; round-trip title edit test: change epic title in beads, push, see Linear update (or reverse with prefer-local understanding).

### U5. GitHub Issues + gates

**Goal:** Prove public intake and CI/PR gate path.

**Steps:**

1. Seed **one open public issue** for demo (operator-owned):

   ```bash
   gh issue create --title "docs: public tracking demo issue for beads workflow" \
     --body "Synthetic issue for multi-tracker demo. Safe to close after demo." \
     --label "docs"
   ```

2. Pull into beads:

   ```bash
   bd github sync --pull-only --dry-run
   bd github sync --pull-only
   ```

3. Confirm bead has `external_ref` like `gh-N`.

4. Document PR gate pattern in runbook (even without forcing a live wait):

   ```bash
   # After opening a PR for real work:
   # bd gate create … type gh:pr …
   # or project-standard gate commands from bd help gate
   ```

5. Policy: agents do not `gh issue create` unless `promote:github`.

**Verification:** `bd list` includes GH-linked bead; `bd github status` healthy; closing the synthetic issue later can be re-pulled without corrupting epics.

### U6. Freeze td and cut over

**Goal:** Single write path.

**Steps:**

1. Add `.todos/FROZEN.md` (or config note) stating freeze date, pointer to beads, archive retention 14 days.

2. Update AGENTS/CLAUDE: `td` write commands forbidden.

3. Optional: leave `td` CLI functional for historical `td show` but agents must not `td create`/`td update`.

4. After U7 passes, mark migration complete in plan Progress.

**Verification:** agent policy grep for `td create` is absent as instruction; beads is sole recommended path.

### U7. Scripted demo (acceptance proof)

**Goal:** End-to-end transcript an operator can re-run.

Demo script lives in `docs/recipes/beads-demo-script.md`. Outline:

| Step | Action | Expected |
|---|---|---|
| 1 | `bd ready --json` | Includes unblocked polish/staging; excludes blocked R1/R3/U6 |
| 2 | Claim a ready polish task | status in_progress |
| 3 | `bd create "Discovered edge case …" --deps discovered-from:<id>` | child linked |
| 4 | Mark claim blocked with note | leaves ready queue |
| 5 | `bd linear sync --push --type epic` | Linear still clean |
| 6 | Add label `promote:linear` to a feature + push | Linear shows it |
| 7 | Show GH-linked public bead | external_ref present |
| 8 | Close polish task with reason | closed; ready updates |
| 9 | Session end sync commands | status clean |

Capture command outputs into `.agents-state/tracker-migration/demo-transcript-YYYYMMDD.md` (local is fine).

**Acceptance (R7):** transcript exists; all expected rows observed; no agent-created Linear spam for micro-tasks.

### U8. Optional multi-machine Dolt sync

Only if the demo needs a second clone. Follow beads `docs/getting-started/sync-setup.md` (`bd dolt push` / `bd bootstrap`). Skip for single-machine demo.

## Concrete Steps (execution order)

1. U0 install + secrets + worktree + td snapshot  
2. U1 docs/ADR/AGENTS  
3. U2 `bd init`  
4. U3 migrate script + run + ready check  
5. U4 Linear project + epic push  
6. U5 seed GH issue + pull  
7. U6 freeze td  
8. U7 run demo script + save transcript  
9. Commit policy/docs/scripts (not secrets); PR if branch workflow used  
10. Update this plan Progress + Outcomes  

## Validation and Acceptance

| ID | Check | Command / observation |
|---|---|---|
| V1 | bd works in repo | `bd version && bd list` |
| V2 | 14 migrated issues | `bd list --json \| jq length` → 14 |
| V3 | Parents intact | sample `bd show` on R1 shows harness epic parent |
| V4 | Ready excludes blocked | blocked ids absent from `bd ready` |
| V5 | Agent policy present | `rg -n "Issue Tracking" AGENTS.md` |
| V6 | Linear epics linked | 4 epics with Linear `external_ref` |
| V7 | Linear not flooded | Linear project issue count ≈ epics (+few features) not 14+ |
| V8 | GH public bead | ≥1 open GH issue mirrored |
| V9 | td frozen | FROZEN note + AGENTS forbid td writes |
| V10 | Demo transcript | recipe steps all pass |
| V11 | No secrets committed | `git grep -iE 'lin_api\|ghp_\|LINEAR_API_KEY='` clean |

## Idempotence and Recovery

- **Re-run migrate:** script must skip if `legacy:td-*` already exists (check labels) or use id-map.
- **Bad Linear push:** delete Linear issues created by mistake; clear `external_ref` on beads if needed; re-push selective.
- **Nuke beads and retry:** restore from td snapshot JSON; `rm -rf .beads` only with operator approval; re-init.
- **Rollback to td:** un-freeze `.todos/FROZEN.md`, revert AGENTS section; beads remains read-only archive. Acceptable for 14 days post-cutover.
- **Conflict thrash:** stop bi-sync; use pull-only / push-only with explicit prefer flags.

## Interfaces and Dependencies

| Dep | Role |
|---|---|
| `bd` CLI (beads) | tracker |
| `td` CLI | migration source only |
| `gh` CLI | GH issues/PR |
| Linear API key | spoke sync |
| 1Password `op` | secret discovery |
| Node 22 | optional migrate script runtime |

No new runtime dependency inside the `asd` application package.json for core demo (script can be plain bash calling `bd`/`jq` if preferred — **prefer bash+jq** to avoid package-manager fights).

**Preferred migrate implementation:** `scripts/migrate-td-to-beads.sh` using `jq` + `bd`, no npm install.

## Artifacts and Notes

| Artifact | Path |
|---|---|
| This plan | `docs/plans/2026-08-07-chore-beads-linear-github-workflow-demo-plan.md` |
| ADR | `docs/decisions/0010-multi-tracker-hub-spoke.md` |
| Runbook | `docs/recipes/beads-linear-github-workflow.md` |
| Demo script | `docs/recipes/beads-demo-script.md` |
| Migrate script | `scripts/migrate-td-to-beads.sh` |
| td snapshot | `.agents-state/tracker-migration/td-export-*.json` |
| id map | `.agents-state/tracker-migration/id-map.json` |
| Demo transcript | `.agents-state/tracker-migration/demo-transcript-*.md` |

### Draft id mapping table (filled at U3)

| td id | asd id | Linear? | GH? |
|---|---|---|---|
| td-31338a | _(after migrate)_ | yes (epic) | no |
| td-4043b2 | | yes (epic) | no |
| td-34b386 | | yes (epic) | no |
| td-25b886 | | yes (epic) | no |
| td-29b2ef | | optional feature | no |
| td-1d395b | | optional feature | no |
| others | | no by default | no |

## Worktree & concurrency

- **worktree_slug:** `chore/asd-beads-workflow`
- **spine_owner:** self
- **Write surfaces:**  
  - U1: `docs/**`, `AGENTS.md`, `CLAUDE.md`, `README.md`  
  - U2–U3: `.beads/**` (local DB), `scripts/migrate-td-to-beads.sh`, `.agents-state/tracker-migration/**`  
  - U4–U5: config via `bd config` (local), maybe no extra files  
  - U6: `.todos/FROZEN.md`, AGENTS  
- **Pre-flight:** reconcile or isolate from `main` behind 42; do not touch pnpm/npm lockfile conflict as part of this work.
- **Active conflicts:** primary checkout dirt around lockfiles — leave foreign; use worktree.

## Prior learnings applied

- Beads sync concepts: Dolt is beads SoT; JSONL is export not multi-machine protocol.
- Charter: integrations map external trackers into beads; orchestration policy stays outside beads schema — use labels/metadata, not schema expansion.
- Operator secrets: discover via 1Password before asking user for Linear key.

## Deferred / out of scope

- Migrating other repos (`.hub`, `.agents`) — after ASD demo proves the pattern.
- Building a GUI board (Beadazzle / Lista) — optional later.
- Full Dolt multi-machine federation unless needed.
- Auto-sync cron/daemon — manual/session hooks first.
- Resolving ASD `main` vs origin 42-commit lag as a product merge — separate work.
- Switching ASD package manager npm↔pnpm.
- Implementing the actual blocked product work (R1 hooks, extract split, etc.) — demo only needs tracker lifecycle; product tickets remain for later sessions **using** the new workflow.

## Open questions (resolved with defaults)

| Question | Default | When to revisit |
|---|---|---|
| Which Linear team? | MarTech / Agents workspace key already in 1P; create ASD project under primary personal/work team operator uses daily | If wrong board visibility |
| Push features R1/R3 to Linear on day 1? | Epics only first; features after demo step 6 | If board looks too empty |
| Commit `.beads` DB or Dolt remote? | Follow current beads defaults for single-dev; enable Dolt remote only in U8 | Multi-machine need |
| Keep `td` forever? | Archive 14 days then optional delete of `.todos/issues.db` with backup | Storage hygiene |

## Risk register

| Risk | Mitigation |
|---|---|
| Sync floods Linear | type filters; epic-only default; dry-run first |
| Dual-write with td | freeze + AGENTS forbid |
| Secrets in git | config local; grep gate V11 |
| Diverged main blocks cutover | worktree |
| `bd` version missing linear flags | install recent beads; verify `bd linear --help` |
| Parent link API differs | check `bd create --help` / `bd dep` at execute time; fix script once |
| Blocked issues have no formal blockers | status+notes sufficient for demo |

## Handoff

**Plan path:** `docs/plans/2026-08-07-chore-beads-linear-github-workflow-demo-plan.md`

**First unit to execute:** U0 Preconditions (`brew install beads`, secrets, worktree, td snapshot).

**Success snapshot:** One agent session can run the demo script without using `td`, Linear shows only product epics, GitHub has a mirrored public issue, and AGENTS.md forbids tracker thrash.

Offer when ready: **Start `execute`**, **iterate plan**, or **done**.
