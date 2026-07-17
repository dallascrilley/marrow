---
date: 2026-07-17
origin: user request to compare Emulo with ASD and privately integrate the missing profile layer
td_epic: td-cf32d7
---

# Emulo Personal-Profile Bridge

**Summary:** Keep agent-session-distillery (ASD) as the canonical multi-harness ingestion and provenance system, create a private MIT-licensed mirror of Emulo, and connect them through a versioned normalized-user-message export. Emulo remains the bounded profile compiler and loader for work, design, writing, and video behavior.

## Requirements

- R1. Establish with repository evidence which Emulo capabilities already exist in ASD and which are genuinely missing.
- R2. Preserve the upstream Emulo source and MIT attribution in a private repository owned by `dallascrilley`, with an `upstream` remote for controlled updates.
- R3. Export only real user-authored messages already preserved in ASD's durable reduced-session artifacts; do not mine rules files, memory, assistant prose, or synthesized self-descriptions.
- R4. Preserve ASD session IDs, source tools, timestamps, source hashes, turn order, and project provenance in a deterministic, versioned bridge format.
- R5. Teach the private Emulo mirror to consume that bridge as `--source asd` without weakening Emulo's redaction, deduplication, preflight approval hash, report validation, pack validation, or activation gates.
- R6. Prove the integration with focused tests in both repositories and an isolated end-to-end preflight that performs no model calls.
- R7. Document the ownership boundary, private-repository path, update workflow, privacy boundary, and exact commands.

## Key technical decisions

- ASD remains the source of normalized evidence. Its `staging/<session-id>/reduced-session.json` files retain every canonical turn's `user_prompt` after parsed intermediates are safely cleaned, so the bridge does not need to re-read live raw transcript paths or summaries.
- The bridge is file-based JSONL rather than a runtime dependency. ASD and Emulo stay independently testable, the export is inspectable before model use, and Emulo's existing `--path`/preflight model remains intact.
- The export root is `$AGENT_SESSION_DISTILLERY_ROOT/exports/emulo/`; each session gets one deterministic JSONL file plus a corpus manifest. Atomic directory replacement prevents mixed generations.
- The private mirror is a new private repository rather than a GitHub fork because GitHub does not support changing a public fork to private visibility. The original `ohad6k/emulo` repository remains the `upstream` remote and its MIT license remains intact.
- A normal Emulo mining run remains separately approval-gated. This implementation ends at a read-only `plugin preflight --source asd`; it does not spend model budget or activate a profile without a later explicit approval.
- Apply `docs/solutions/tooling/codex-source-cleanup-after-tombstone.md`: raw deletion safety stays receipt-backed and separate. The bridge consumes durable reduced artifacts, so it remains available even after verified raw-source deletion.

## Implementation units

### U1. Create the private Emulo mirror

- **Goal:** Create `dallascrilley/emulo-private`, clone it to `/Users/dallascrilley/Code/emulo-private`, preserve `origin` as the private repository, and add `upstream=https://github.com/ohad6k/emulo.git` at the reviewed upstream commit.
- **Requirements:** R1, R2, R7
- **Files:** Emulo repository metadata, `README.md`
- **Approach:** Import the current upstream `main` history without squashing; record the reviewed upstream commit and private-mirror purpose in a short integration section while preserving the license.
- **Tests:** `git remote -v`, `git rev-parse HEAD`, `gh repo view dallascrilley/emulo-private --json visibility,url`, clean status.
- **Verification:** Private visibility is reported, `origin` and `upstream` are distinct, and the imported head matches the reviewed upstream commit.

### U2. Add the ASD Emulo export

- **Goal:** Add `asd profile export-emulo` as a deterministic local export of canonical user prompts.
- **Requirements:** R3, R4, R6, R7
- **Files:** `src/cli.ts`, `src/commands/profile-export-emulo.ts`, `src/config/paths.ts`, `test/profile-export-emulo.test.mjs`, `README.md`, `LAUNCH_CRITERIA.md`
- **Approach:** Enumerate eligible source sessions, load and validate each durable reduced artifact with canonical schemas, emit one `asd.user_message.v1` JSONL record per turn, and write a sorted `asd.emulo_corpus.v1` manifest. Refuse malformed or provenance-mismatched artifacts; report skipped sessions explicitly. Build the export in a sibling temporary directory and rename it into place only after all writes succeed.
- **Tests:** Happy path across multiple source tools, deterministic rerun, assistant text exclusion, malformed/mismatched artifact rejection, empty corpus behavior, and runtime-root isolation.
- **Verification:** `npm run build` followed by the focused Node test; the generated corpus contains only canonical `user_prompt` values with stable provenance.

### U3. Add ASD as a native Emulo source

- **Goal:** Make the private Emulo mirror accept `--source asd` and preserve ASD provenance in Emulo receipts.
- **Requirements:** R3, R4, R5, R6
- **Files:** `emulo.py`, `tests/test_asd_source.py`, `README.md`, plugin skill documentation if its command examples enumerate source choices
- **Approach:** Add the ASD export root to source discovery, recognize `asd.user_message.v1` records, take session ID/source/date/text from validated records, reject mixed-session files and unsupported schema versions, and keep existing redaction/deduplication and profile-pack gates unchanged.
- **Tests:** Valid multi-source ASD export, malformed schema rejection, injected non-user record rejection, stable session/source identity, CLI choice coverage, and preflight hash stability over unchanged input.
- **Verification:** Focused Python tests plus the repository's full test command if practical.

### U4. Prove the bridge end to end

- **Goal:** Demonstrate a zero-model-call ASD-to-Emulo preflight using an isolated ASD runtime.
- **Requirements:** R5, R6, R7
- **Files:** `docs/recipes/emulo-profile-bridge.md`, Emulo `README.md`
- **Approach:** Build ASD, seed or ingest a fixture corpus, export it, run private Emulo `plugin preflight --source asd --path <export-root>`, and record the returned session/token/worker plan without preparing or activating a pack.
- **Tests:** The preflight reports the expected sessions and selected source tokens; no run ID, reports, pack, activation, or model calls exist.
- **Verification:** `script/cibuild` in ASD under Node 22, Emulo test suite, and an isolated preflight receipt.

## Worktree & concurrency

- **worktree_slug:** codex/emulo-bridge-v2
- **spine_owner:** self
- **Pre-flight:** Worktrunk created `/Users/dallascrilley/Code/.worktrees/agent-session-distillery/codex-emulo-bridge-v2` from `origin/main` at `3272e2581000aa02dc0c4f9f31de16c806154ffa`.
- **Active conflicts:** The primary ASD checkout has foreign modifications and untracked files; this plan does not touch them. The abandoned first worktree was removed after discovering the local `main` checkout was stale and diverged from `origin/main`.

### Write surfaces

- U1: `/Users/dallascrilley/Code/emulo-private`
- U2: `src/commands/profile-export-emulo.ts`, `src/cli.ts`, `src/config/paths.ts`, `test/profile-export-emulo.test.mjs`, `README.md`, `LAUNCH_CRITERIA.md`
- U3: private Emulo mirror `emulo.py`, tests, and docs
- U4: `docs/recipes/emulo-profile-bridge.md` and verification artifacts outside git

## Prior learnings applied

- `docs/solutions/tooling/codex-source-cleanup-after-tombstone.md` — do not treat tombstones or derived summaries as raw-transcript preservation; keep the verified archive workflow intact.
- Prior Emulo run evidence — freeze or export a stable corpus before asking for model-cost approval because live Codex history can invalidate the approval hash.

## Deferred / out of scope

- Running paid/model-backed Emulo workers or activating a newly mined profile.
- Replacing the currently installed public Emulo plugin before the private bridge is reviewed and verified.
- Upstreaming the ASD source adapter publicly.
- Adding cloud sync, accounts, billing, or Emulo Pro services.

## Open questions

- None blocking. The default private repository name is `dallascrilley/emulo-private`; it can be renamed later without changing the bridge format.
