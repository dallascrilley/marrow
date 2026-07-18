# External staging storage

Use a mounted local filesystem for live ASD staging. Keep the SQLite ledger, manifests,
summaries, knowledge, archives, reports, and deletion receipts under the normal runtime root.
S3 is not a live staging backend; any future S3 cold tier requires separate approval and an
explicit offload/restore workflow.

## Preconditions

Build with Node 22, confirm the volume is mounted, inspect capacity, and verify cleanup recovery
has no pending conflicts:

```bash
npm run build
df -h /Volumes/SSK
node dist/cli.js storage inventory --json
node dist/cli.js storage cleanup-parsed --max-total-bytes 1073741824
```

Inspect the cleanup candidate and pending-receipt output. Applying cleanup is optional and
destructive, so use `--apply` only for the reviewed candidate set. Migration itself never deletes
the source.

## Copy and verify

The destination must already exist and be empty, or contain the ownership marker from an earlier
migration of the same canonical source root.

```bash
mkdir -p /Volumes/SSK/agent-session-distillery/staging
node dist/cli.js storage migrate-staging --to /Volumes/SSK/agent-session-distillery/staging
node dist/cli.js storage migrate-staging --to /Volumes/SSK/agent-session-distillery/staging --apply
```

Inspect `files`, `total_bytes`, `manifest_path`, `receipt_path`, and the emitted environment value.
Apply hashes every source, copies through a temporary file, fsyncs, atomically renames, verifies
the destination hash, and leaves the original tree unchanged. A rerun should report every file as
skipped. Do not proceed if the command reports pending cleanup, insufficient capacity, unsafe
entries, source mutation, a destination mismatch, or foreign ownership.

## Cut over

Set the override in the exact operator launcher and every scheduled job that runs ASD:

```bash
export AGENT_SESSION_DISTILLERY_STAGING_ROOT=/Volumes/SSK/agent-session-distillery/staging
node dist/cli.js storage inventory --json
node dist/cli.js ingest sync --source cursor --resume
node dist/cli.js storage cleanup-parsed
```

Inventory must show the configured root as available and writable. The runtime root must still
contain the ledger, reports, receipts, summaries, knowledge, and manifests. If the volume or root
is absent, staging-dependent commands fail; ASD does not recreate the path or fall back silently.

## Roll back

Unset the staging-only override and restart the launcher or scheduled job:

```bash
unset AGENT_SESSION_DISTILLERY_STAGING_ROOT
node dist/cli.js storage inventory --json
```

Because migration never deletes the original staging tree, this immediately returns readers and
writers to `<AGENT_SESSION_DISTILLERY_ROOT>/staging` (or
`~/.agent-session-distillery/staging`). Keep that source through an operator-selected soak period.
Retiring it later is a separate destructive action requiring a fresh hash/inventory comparison and
explicit approval.

## S3 decision

Do not mount S3 as the staging directory. Object storage cannot preserve the local descriptor and
atomic-rename guarantees used by parsed cleanup. Revisit S3 only if observed growth exceeds SSK
capacity and the operator separately approves dependency, request, storage, and live-smoke costs.
