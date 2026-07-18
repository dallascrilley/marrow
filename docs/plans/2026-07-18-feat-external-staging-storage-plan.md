---
date: 2026-07-18
origin: user-request-2026-07-18
td_epic: td-25b886
---

# External staging storage

Living document. Update Progress, Surprises & Discoveries, Decision Log, Outcomes &
Retrospective, and Revision History as implementation proceeds. This repository has no
`docs/PLANS.md`; this plan follows the repository's existing `docs/plans/` convention and the
Compound Engineering plan contract.

**Summary:** Move only parsed and reduced staging artifacts out of the internal drive. Use a
pre-created directory on `/Volumes/SSK` as the live staging filesystem, fail closed when the
volume is absent, preserve the existing receipt-backed cleanup guarantees, and migrate with a
copy-and-verify workflow that never deletes the source automatically. Treat S3 as an optional
cold tier with explicit offload and restore commands, not as a mounted live filesystem.

## Purpose / Big Picture

The current `~/.agent-session-distillery/staging` tree occupies 14,277,319,949 bytes across
19,980 files. Of that, 13,463,515,017 bytes are `parsed-records.json`; 809,135,488 bytes are
`reduced-session.json`. `/Volumes/SSK` is mounted with about 40 GB free. After this work, an
operator can keep the durable control plane under `~/.agent-session-distillery`, place the
large reproducible intermediates on `/Volumes/SSK`, and continue to use ingest, resume,
rereduce, reextract, inventory, and parsed cleanup without weakening deletion safety.

The first delivery target is the external volume. S3 remains a separate, opt-in cold-storage
lane because object storage does not provide the path, directory, descriptor, or atomic-rename
semantics used by `src/pipeline/parsed-cleanup.ts`.

## Progress

- [x] (2026-07-18 18:40Z) Measured live staging composition and `/Volumes/SSK` headroom.
- [x] (2026-07-18 18:40Z) Traced staging path consumers and parsed-cleanup safety boundaries on
  `origin/main` at `c9eeb75`.
- [x] (2026-07-18 18:40Z) Selected staging-only external-volume storage and rejected direct S3
  mounting for the live pipeline.
- [x] (2026-07-18 18:45Z) Imported the plan into td as epic `td-25b886` with stable U1-U5
  child issues and dependency order.
- [x] (2026-07-18 19:44Z) Implemented and independently reviewed U1-U3: validated root API,
  consumer cutover and cross-device cleanup, and receipt-backed migration.
- [x] (2026-07-18 19:44Z) Ran the isolated SSK ingest/resume/migrate/inventory/cleanup/disconnect/
  rollback proof; source and destination hashes matched and the proof target was moved to Trash.
- [x] (2026-07-18 19:51Z) Completed CI-equivalent verification: Biome passed, all 696
  tests passed, and the TypeScript build passed. Final review and shipping follow this commit.
- [ ] Decide later whether the optional S3 cold-tier lane is worth its dependency, operational,
  and billable surface.

## Surprises & Discoveries

- Observation: Parsed artifacts account for roughly 94% of staging bytes. Evidence: the live
  tree contains 9,988 parsed files totaling 13,463,515,017 bytes and 9,991 reduced files
  totaling 809,135,488 bytes.
- Observation: The current cleanup implementation atomically renames parsed files into
  `deletes/parsed-cleanup-quarantine/`. If staging moves to another filesystem while deletes
  remains local, that rename can fail with `EXDEV`. Evidence: `src/pipeline/parsed-cleanup.ts`
  derives the source from `getRuntimePath("staging")` and quarantine from
  `getRuntimePath("deletes")`.
- Observation: The primary checkout was 32 commits behind `origin/main`; the current remote
  includes storage inventory, parsed cleanup, pending-receipt recovery, and scheduled retention
  that the local primary branch did not contain. This plan is therefore based on `origin/main`
  commit `c9eeb75` in an isolated worktree.
- Observation: `/Volumes/SSK` has about three times the current staging footprint free. That is
  enough for a verified migration after safe parsed cleanup, but not enough to treat the disk as
  an unbounded archive.
- Observation: Completed cleanup receipts initially blocked cutover because they were fully parsed
  against the new root before terminal-status filtering. The proof failed safely; status-first
  filtering now ignores completed historical receipts while pending/failed receipts still bind
  recovery to their recorded paths.
- Observation: SSK free space fell from the planning snapshot to about 28 GB before proof. The
  isolated proof remained small; a live 13 GB copy still fits today but should be preceded by a
  fresh capacity check and is not part of this non-destructive implementation proof.

## Requirements

- R1. Relocate only `staging/<session-id>/parsed-records.json` and
  `staging/<session-id>/reduced-session.json`; keep the ledger, manifests, summaries, knowledge,
  reviews, archives, reports, deletion receipts, and tombstones under the normal runtime root.
- R2. Preserve current behavior when no new setting is supplied: staging remains
  `~/.agent-session-distillery/staging` or `<AGENT_SESSION_DISTILLERY_ROOT>/staging`.
- R3. Add `AGENT_SESSION_DISTILLERY_STAGING_ROOT` as an absolute, staging-only override. A
  configured root must already exist as a real directory. Missing, relative, symlinked,
  redirected, or unwritable roots fail before any session directory is created; the application
  must never recreate `/Volumes/SSK` on the internal drive when the volume is absent.
- R4. Make every staging reader and writer use one canonical path API. Ingest, `--resume`,
  rereduce, reextract, resummarize, profile export, storage inventory, session detail, workflow
  mining, and parsed cleanup must resolve the same root.
- R5. Preserve parsed-cleanup invariants across filesystems: exact filename and session anchoring,
  no symlink traversal, receipt-first mutation, atomic quarantine on the staging filesystem,
  fail-closed conflict recovery, and no deletion of reduced or durable artifacts.
- R6. Provide a dry-run-first, resumable, copy-and-verify migration workflow. It must reject
  pending cleanup receipts, verify destination capacity and ownership, copy only supported
  regular artifacts through temporary files, hash source and destination, write a durable
  receipt, and never remove the source tree.
- R7. Make the cutover reversible. The operator changes one environment setting after a
  successful migration receipt; rollback removes that setting and leaves the original staging
  tree usable until a separately approved retirement step.
- R8. Keep S3 outside the live path contract. If implemented later, it must upload immutable,
  compressed, hash-addressed artifacts only after durable archive promotion, verify them before
  local cleanup, and restore them into a local staging root before any pipeline consumer reads
  them.
- R9. Do not print or persist credentials. S3 credentials, if the optional lane is selected, use
  the standard AWS credential provider chain. Bucket creation, encryption-key creation, and any
  billable AWS mutation require separate explicit approval.
- R10. Update operator documentation and launch criteria with the new path, absent-volume
  behavior, migration proof, rollback, and S3 boundary.

## Key technical decisions

- Use a staging-only override, not `AGENT_SESSION_DISTILLERY_ROOT=/Volumes/SSK/...`. The ledger
  and durable read model must remain available when the removable volume is disconnected.
- Use `/Volumes/SSK/agent-session-distillery/staging` as the recommended live target. The
  operator creates this directory while the disk is mounted; ASD never creates the configured
  root itself.
- Keep path resolution filesystem-native. Do not introduce a generic storage-backend interface
  in the first delivery; the pipeline's artifacts and safety checks are intentionally local-file
  contracts.
- Choose quarantine on the same device as the parsed artifact. Retain the existing local
  `deletes/parsed-cleanup-quarantine/` path when staging and deletes share a device. When they do
  not, use a reserved `.parsed-cleanup-quarantine/` beneath the validated staging root while
  keeping the durable applying/applied receipt under the local runtime's `deletes/receipts/`.
  This preserves atomic rename and restart recovery without copying a multi-gigabyte file during
  deletion.
- Migrate copy-first and leave the source intact. A successful migration receipt authorizes
  cutover, not deletion. Source retirement is a separate, reviewable operator action after a
  soak period.
- Reject an S3 FUSE mount as live staging. Strong object-level consistency does not supply the
  directory descriptors, hard-link checks, device identity, or atomic local rename relied on by
  cleanup. An S3 lane, if justified later, is explicit offload/restore.
- Apply the existing parsed-retention policy before copying. The dry run is
  `node dist/cli.js storage cleanup-parsed --max-total-bytes 1073741824`; applying it requires
  inspecting the candidate/receipt output and then adding `--apply`.

## Context and Orientation

`src/config/paths.ts` currently derives every runtime child from
`AGENT_SESSION_DISTILLERY_ROOT`. `src/pipeline/parse.ts` writes
`parsed-records.json`; `src/pipeline/reduce.ts` reads parsed records and writes
`reduced-session.json`. Several commands and read surfaces then reopen those files by joining
against `getRuntimePath("staging")`.

`src/read/lifecycle-inventory.ts` classifies staging files and supplies safe cleanup candidates.
`src/commands/storage-parsed-cleanup.ts` freezes the candidate set and delegates mutation to
`src/pipeline/parsed-cleanup-receipts.ts` and `src/pipeline/parsed-cleanup.ts`. The latter uses a
descriptor-relative Python helper to quarantine and unlink exact files while resisting path
replacement. This boundary is load-bearing and must be adapted, not bypassed.

The relevant existing learning is
`docs/solutions/tooling/codex-source-cleanup-after-tombstone.md`: receipts and tombstones do not
replace verified archive or explicit source cleanup. The companion
`docs/solutions/performance/codex-worktree-runtime-backups-disk-bomb.md` warns against creating
large duplicate runtime snapshots while trying to reclaim disk. Accordingly, migration must
avoid copying the entire runtime and must not leave accidental worktree-local runtime backups.

## Implementation units

### U1. Define and validate the external staging-root contract

- **Goal:** Resolve all staging paths through a single fail-closed module while preserving the
  default layout.
- **Requirements:** R1, R2, R3, R4
- **Files:** `src/config/paths.ts`, `src/storage/staging.ts`,
  `test/staging-storage.test.mjs`
- **Approach:** Export the new environment-variable name from `src/config/paths.ts`. Add a small
  `src/storage/staging.ts` module that resolves the root, validates absolute path and directory
  identity, distinguishes read and write readiness, and returns canonical parsed, reduced, and
  quarantine paths. Validation must inspect the pre-created configured root before any recursive
  `mkdir`; a missing override is an error, not a request to create it. Preserve the current root
  fallback when the variable is unset.
- **Tests:** Default path follows `AGENT_SESSION_DISTILLERY_ROOT`; a valid pre-created absolute
  override is selected; relative, missing, regular-file, symlink, and unwritable overrides fail;
  failure leaves the would-be volume path absent; session IDs cannot escape the root.
- **Verification:** `npm run build && node --test --test-concurrency=1 test/staging-storage.test.mjs`

### U2. Wire consumers and preserve cross-device cleanup safety

- **Goal:** Make every staging consumer honor the override and keep parsed cleanup atomic and
  recoverable when staging and deletes are on different devices.
- **Requirements:** R4, R5
- **Files:** `src/pipeline/parse.ts`, `src/pipeline/reduce.ts`,
  `src/pipeline/resummarize.ts`, `src/pipeline/parsed-cleanup.ts`,
  `src/pipeline/parsed-cleanup-receipts.ts`, `src/commands/pipeline-reextract.ts`,
  `src/commands/pipeline-rereduce.ts`, `src/commands/profile-export-emulo.ts`,
  `src/read/lifecycle-inventory.ts`, `src/read/session-detail.ts`, `src/workflow/mine.ts`,
  `test/parsed-cleanup.test.mjs`, `test/integration/ingest-lifecycle.test.mjs`,
  `test/pipeline-reextract.test.mjs`, `test/pipeline-rereduce.test.mjs`
- **Approach:** Replace direct staging joins with the U1 API. Preflight the external root before
  reads or writes. Compare staging and deletes device identity during cleanup preparation. Use
  the existing deletes quarantine on one device and the reserved validated staging quarantine
  across devices. Persist the selected quarantine root and directory identity in the applying
  receipt so recovery does not recompute it after configuration changes. Refuse configuration
  cutover while an applying receipt is pending.
- **Tests:** Parse/reduce/resume work through an override; absent volume fails without falling
  back; inventory reports the configured root unavailable without mutation; injected
  same-device and cross-device cases choose the correct quarantine; interrupted cleanup recovers
  from its recorded external quarantine; redirected paths, symlinks, hard links, missing helper,
  and conflicting replacements remain fail-closed; reduced artifacts and durable outputs remain.
- **Verification:**
  `npm run build && node --test --test-concurrency=1 test/staging-storage.test.mjs test/parsed-cleanup.test.mjs test/integration/ingest-lifecycle.test.mjs test/pipeline-reextract.test.mjs test/pipeline-rereduce.test.mjs`

### U3. Add a receipt-backed staging migration command

- **Goal:** Copy the current staging tree to a validated local filesystem without data loss or
  automatic source deletion.
- **Requirements:** R6, R7
- **Files:** `src/commands/storage-migrate-staging.ts`, `src/pipeline/staging-migration.ts`,
  `src/models/canonical.ts`, `src/cli.ts`, `test/staging-migration.test.mjs`, `test/cli.test.mjs`
- **Approach:** Add `asd storage migrate-staging --to <absolute-path>` as a dry run and require
  `--apply` to copy. The destination must be a pre-created directory containing an ASD ownership
  marker or be empty; it must not equal or nest inside the source. Abort on pending parsed-cleanup
  receipts, unsupported file types, symlinks, insufficient free bytes, or a changed source file.
  Copy only exact `parsed-records.json` and `reduced-session.json` files to destination-side
  temporary names, hash while streaming, fsync, rename into place, and verify the destination
  hash. Reruns skip hash-matching files and safely replace only incomplete temporary files. Write
  a JSONL manifest plus a final JSON receipt beneath `reports/storage-migrations/`; record source,
  destination, counts, bytes, hashes, timestamps, skipped files, and the exact environment value
  for cutover. Do not change shell configuration, scheduled jobs, or delete source files.
- **Tests:** Dry run is non-mutating; apply copies and hashes both artifact kinds; rerun is
  idempotent; interrupted temporary files resume; insufficient capacity, source mutation,
  pending cleanup, nesting, symlink, unsupported file, and hash mismatch abort; receipt contains
  no credentials and source remains intact.
- **Verification:**
  `npm run build && node --test --test-concurrency=1 test/staging-migration.test.mjs test/cli.test.mjs`

### U4. Prove SSK cutover, rollback, and operator documentation

- **Goal:** Demonstrate the real mounted-volume path and document a reversible operator workflow.
- **Requirements:** R7, R10
- **Files:** `README.md`, `PROJECT_CONTEXT.md`, `LAUNCH_CRITERIA.md`,
  `docs/recipes/external-staging-storage.md`,
  `docs/ops/proofs/2026-07-18-external-staging-storage.md`
- **Approach:** Document the default and override precedence, the requirement to pre-create the
  mounted root, cleanup-before-copy, dry-run/apply migration, receipt inspection, environment
  cutover, scheduled-job propagation, absent-volume failure, rollback, and deferred source
  retirement. Run the proof against an isolated ASD runtime and
  `/Volumes/SSK/agent-session-distillery/proof-staging`; do not use the operator's live ledger.
  Ingest one fixture, resume it, inventory it, run parsed-cleanup dry run/apply, disconnect only by
  renaming the proof root within the mounted volume, observe fail-closed behavior, restore the
  root, and observe recovery. Remove only the proof directory after inspecting its receipt.
- **Tests:** Documentation commands match CLI help. The proof records source and destination
  device IDs, artifact hashes, command exit codes, absent-root error, successful rollback, and
  final cleanup of the isolated proof root.
- **Verification:** `script/cibuild`, followed by the recipe's isolated SSK proof. Expected result:
  all CI-equivalent gates pass; the proof shows staging paths on `/Volumes/SSK`; ledger and
  receipts remain under the isolated internal runtime; absent-root access fails; rollback reads
  the unchanged source tree.

### U5. Optional S3 cold-tier offload and restore

- **Goal:** Reclaim local staging space while retaining explicitly restorable archived
  intermediates in S3, without pretending S3 is a local filesystem.
- **Requirements:** R8, R9, R10
- **Files:** `package.json`, `package-lock.json`, `src/storage/s3-staging.ts`,
  `src/commands/storage-offload-staging.ts`, `src/commands/storage-restore-staging.ts`,
  `src/cli.ts`, `test/s3-staging.test.mjs`, `README.md`,
  `docs/recipes/external-staging-storage.md`
- **Approach:** Start this unit only after a separate decision to incur AWS dependency and
  storage costs. Use AWS SDK for JavaScript v3 and its default credential provider chain. Upload
  only sessions already in a durable terminal archive state. Gzip each artifact and write it to
  an immutable key such as
  `<prefix>/staging/v1/<source-tool>/<session-id>/<source-hash>/<artifact>.json.gz`; attach SHA-256
  and byte metadata, then write a versioned manifest last. Verify with `HeadObject` and a streamed
  read/hash before marking a local offload receipt complete. Local deletion remains delegated to
  the existing safe cleanup path. Restore verifies manifest and payload hashes into temporary
  local files, atomically renames them into the configured staging root, and never overwrites a
  mismatched local artifact. Require a versioned general-purpose bucket with default encryption
  and a lifecycle policy; provisioning that bucket is not included.
- **Tests:** Fake-client tests cover upload ordering, retries, idempotence, checksum mismatch,
  partial manifest, credential failure redaction, restore collision, and no local delete before
  verified completion. A live S3 smoke is opt-in, prefix-scoped, cost-bounded, and never runs in
  ordinary CI.
- **Verification:** Focused fake-client tests plus an explicitly approved live smoke that uploads,
  heads, downloads, hashes, restores, and deletes only the temporary smoke prefix. Without that
  approval, report S3 as not live-verified.

## Milestones

### Milestone 1: Filesystem contract and safety

Complete U1 and U2. The default runtime remains byte-for-byte compatible, all staging consumers
honor the override, and cleanup remains receipt-backed on same-device and cross-device layouts.
This milestone is accepted when the focused tests pass and an absent configured root produces a
clear error without creating any directory beneath `/Volumes`.

### Milestone 2: Reversible SSK migration

Complete U3 and U4. A dry-run/apply migration copies and verifies staging on the mounted SSK,
writes a durable receipt, and leaves the original tree unchanged. This milestone is accepted
when the isolated real-volume proof passes and `script/cibuild` is green.

### Milestone 3: Optional S3 cold tier

Complete U5 only if the operator explicitly chooses offsite retention over the simpler SSK-only
layout and authorizes the billable AWS slice. This milestone is accepted only after fake-client
tests and a separately approved live prefix-scoped proof.

## Concrete Steps

1. Before implementation, sync the isolated worktree to current `origin/main`, confirm no active
   writer overlaps the listed surfaces, and run a focused build/test baseline under Node 22.
2. Implement and commit U1, then U2. Do not combine the path contract with migration mechanics.
3. Run the focused safety suite before adding migration behavior. Treat any cleanup regression as
   a blocker because it can affect deletion guarantees.
4. Implement U3 as a non-mutating dry run first; prove it reports the live 13 GB tree without
   copying. Add apply, retry, and receipt behavior only after the dry-run tests pass.
5. Before the real migration, build current `origin/main`, run
   `node dist/cli.js storage inventory --json`, run
   `node dist/cli.js storage cleanup-parsed --max-total-bytes 1073741824`, inspect the safe
   candidate set, and apply only after the receipt/recovery state is clean.
6. Pre-create `/Volumes/SSK/agent-session-distillery/staging`, run the migration dry run, confirm
   capacity and artifact counts, run `--apply`, and inspect the final receipt. Do not delete
   `~/.agent-session-distillery/staging`.
7. Set `AGENT_SESSION_DISTILLERY_STAGING_ROOT` only in the ASD operator launcher/scheduled-job
   environment, run inventory and one bounded `--resume` ingest, then run the U4 absent-root and
   rollback proof.
8. Keep the original staging tree through an operator-selected soak period. Any later retirement
   is a separate destructive action with a fresh inventory and explicit approval.
9. Reassess U5 using observed post-cleanup staging growth. If SSK capacity and retention are
   adequate, defer S3 and avoid the dependency, credential, request-cost, and restore surfaces.

## Validation and Acceptance

- With neither override set, all existing path and cleanup tests pass and staging remains under
  the runtime root.
- With `AGENT_SESSION_DISTILLERY_STAGING_ROOT` pointing to a pre-created directory, parsed and
  reduced files are written there while ledger, receipts, manifests, summaries, and reports are
  written under `AGENT_SESSION_DISTILLERY_ROOT`.
- With the configured staging root missing, a staging-dependent command exits nonzero before
  creating a session directory or falling back to the internal drive. Read-only health/inventory
  output identifies the configured path and unavailable state.
- Parsed cleanup uses an atomic same-filesystem quarantine, writes applying/applied receipts,
  recovers after interruption, and never deletes reduced or durable artifacts.
- Migration dry run changes nothing. Apply verifies every copied file, writes a complete receipt,
  is idempotent, and leaves the source tree unchanged.
- The isolated SSK proof covers ingest, resume, inventory, cleanup, absent-root failure, restore,
  and rollback. `script/cibuild` passes under Node 22.
- S3 is not represented as supported live staging. If U5 is deferred, documentation says so. If
  U5 is completed, offload/restore is fake-client tested and live verification status is explicit.

## Idempotence and Recovery

Path resolution is deterministic from the two runtime environment variables. U1/U2 do not move
existing files. The migration command is safe to rerun because only hash-matching destination
files are accepted as complete; incomplete temporary files can be replaced, while mismatched
completed files stop the run. Applying cleanup remains receipt-first and recovers from the exact
recorded quarantine root.

Rollback unsets `AGENT_SESSION_DISTILLERY_STAGING_ROOT` and restarts the bounded command or
scheduled job. Because migration never deletes the source, the old tree remains available. If a
cleanup applying receipt exists, finish or recover that receipt under the configuration recorded
in it before changing roots. If the SSK is unavailable, remount it; do not create a same-named
directory under `/Volumes`.

For S3, immutable object keys and a manifest-last protocol make retries idempotent. Restore writes
temporary local files and renames only after hash verification. A missing or partial manifest is
not restorable and never authorizes local cleanup.

## Interfaces and Dependencies

- New environment variable: `AGENT_SESSION_DISTILLERY_STAGING_ROOT` — absolute path to an
  existing staging directory.
- New local command: `asd storage migrate-staging --to <absolute-path> [--apply]`.
- Existing command retained: `asd storage cleanup-parsed [--older-than-days <n>]
  [--max-total-bytes <n>] [--apply]`.
- Optional S3 commands: `asd storage offload-staging --s3-uri s3://bucket/prefix [--apply]` and
  `asd storage restore-staging --session-id <id> --s3-uri s3://bucket/prefix [--apply]`.
- U1-U4 add no production dependency. U5 may add `@aws-sdk/client-s3` and
  `@aws-sdk/lib-storage`; the repository remains on npm and Node 22.
- S3 bucket requirements, if U5 proceeds: general-purpose bucket, Versioning enabled, default
  encryption, lifecycle policy for old object versions and incomplete multipart uploads, and
  least-privilege prefix-scoped IAM. Infrastructure creation is outside this plan's authorized
  execution scope.

## Worktree & concurrency

- **worktree_slug:** `codex/staging-storage-plan`
- **spine_owner:** self for plan authoring; assign one implementation owner for `src/cli.ts`,
  `src/config/paths.ts`, and cleanup wiring.
- **Pre-flight:** `wt list --full`; `git status --short`; inspect
  `.agents-state/worktrees.json` when present; rerun overlap checks for every implementation unit.
  The Hub-global `~/.hub/scripts/worktree-posture.sh` currently reports the Hub repository rather
  than this project, so it is not evidence for this worktree.
- **Active conflicts:** none at authoring time. The only other ASD worktree,
  `corpus-reextract`, is clean and last committed more than 23 hours ago; recheck before touching
  `src/pipeline/reduce.ts`.

### Write surfaces

- U1: `src/config/paths.ts`, `src/storage/staging.ts`, `test/staging-storage.test.mjs`
- U2: staging consumers listed in U2 plus cleanup and focused tests
- U3: storage migration command, pipeline, model, CLI, and tests
- U4: `README.md`, `PROJECT_CONTEXT.md`, `LAUNCH_CRITERIA.md`, recipe, proof
- U5: optional S3 module, commands, dependency manifests, tests, and docs

## Prior learnings applied

- `docs/solutions/tooling/codex-source-cleanup-after-tombstone.md` — never equate a receipt or
  tombstone with verified archived data; keep cleanup explicit and evidence-backed.
- `docs/solutions/performance/codex-worktree-runtime-backups-disk-bomb.md` — move only staging,
  avoid whole-runtime copies, and prevent proof/worktree snapshots from multiplying the 13 GB
  tree.

## Deferred / out of scope

- Moving SQLite, manifests, summaries, knowledge, archives, reports, or receipts to SSK or S3.
- Mounting S3 through FUSE and presenting it as a POSIX staging directory.
- Automatically editing shell profiles, launch agents, cron jobs, or automation configuration.
- Deleting the original live staging tree after cutover.
- Provisioning an S3 bucket, KMS key, IAM identity, lifecycle policy, or any other billable AWS
  resource without separate explicit approval.
- Generalizing every runtime path into a pluggable storage backend.

## Open questions

No architecture-blocking question remains. The plan selects SSK for live staging and treats S3
as an optional cold tier. The only later product decision is whether observed staging growth after
the existing 1 GB parsed-retention ceiling justifies implementing U5.

## Outcomes & Retrospective

U1-U4 implemented the SSK path without moving durable control-plane state. The real-volume proof
showed different source/destination devices, matching SHA-256, fail-closed absence, successful
rollback, idempotent rerun, and source retention. No live operator staging was deleted or cut over,
so measured internal disk reclaimed remains 0 bytes. S3 remains deferred as the optional U5 lane.

## Revision History

- 2026-07-18: Initial plan based on `origin/main` `c9eeb75`, live staging measurements, current
  parsed-cleanup safety behavior, and the mounted SSK capacity check.
- 2026-07-18: Linked the plan to td epic `td-25b886`; U1 begins at `td-965810`.
- 2026-07-18: Implemented U1-U4 after `de3a7fd`, corrected the completed-receipt cutover bug
  discovered by the isolated SSK proof, captured proof evidence and operator documentation, and
  passed the full 696-test CI-equivalent gate.
