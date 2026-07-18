# External staging storage proof — 2026-07-18

Status: **validated** on macOS with Node 22 and `/Volumes/SSK`.

## Scope

The proof used isolated runtime `/private/tmp/asd-ssk-proof-20260718.ae0Tsd/runtime`, an isolated
Cursor fixture home, and `/Volumes/SSK/agent-session-distillery/proof-staging`. It did not read or
write the operator ledger at `~/.agent-session-distillery`. The proof target was moved to Trash
after inspection; the isolated source runtime remained intact for validation.

## Evidence

- Fixture ingest: 1 discovered, 1 processed, 0 failed; `session-e2e` reached a safe deletion
  candidate. A second `ingest backfill --source cursor --resume` reported `resumed: true`.
- Migration dry run: 1 exact reduced artifact, 6,194 bytes, `apply: false`, source status `copy`,
  and no destination mutation.
- Migration apply: 1 copied, 0 skipped; manifest and receipt were written under the isolated
  runtime's `reports/storage-migrations/` directory.
- Source device: `16777233`; SSK destination device: `16777247`.
- Source and destination SHA-256:
  `e8ca22a1f068c1cb5e6159fde136a7c35a22700c819f8f707574e209fdfb0552`.
- Cutover inventory reported the configured SSK root `available: true`, `writable: true`, and the
  reduced artifact as required while ledger, receipts, reports, summaries, and knowledge remained
  under the isolated runtime.
- Cleanup dry run and apply both succeeded after cutover with zero candidates; the apply receipt
  remained under the isolated runtime.
- Disconnect simulation renamed only the proof root on SSK. `pipeline rereduce --all-with-parsed
  --dry-run` exited 1 with `staging root is unavailable` and did not recreate the path.
- Restoring the proof root made inventory succeed again (`rollback_inventory_rc=0`).
- Idempotent migration rerun reported 0 copied and 1 skipped. Byte comparison and SHA-256 matched,
  the internal source still existed, and the ownership marker was present.
- `/Volumes/SSK/agent-session-distillery/proof-staging` was moved to Trash after validation; no
  disconnected proof path remained.

## Discovery during proof

The first cutover cleanup attempt exposed that completed historical cleanup receipts were parsed
against the newly configured root before terminal status filtering. The command failed safely
without mutation. Receipt loading was corrected to inspect status first: completed receipts remain
audit evidence, while applying or failed receipts are still fully validated and block a mismatched
cutover. The focused parsed-cleanup and migration suites then passed 40/40 before the proof resumed.

## Commands exercised

```bash
node dist/cli.js ingest backfill --source cursor
node dist/cli.js ingest backfill --source cursor --resume
node dist/cli.js storage migrate-staging --to /Volumes/SSK/agent-session-distillery/proof-staging
node dist/cli.js storage migrate-staging --to /Volumes/SSK/agent-session-distillery/proof-staging --apply
node dist/cli.js storage inventory --json
node dist/cli.js storage cleanup-parsed
node dist/cli.js storage cleanup-parsed --apply
node dist/cli.js pipeline rereduce --all-with-parsed --dry-run
```
