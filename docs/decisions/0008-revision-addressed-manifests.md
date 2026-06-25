# 0008. Revision-addressed session provenance manifests

- **Status:** accepted
- **Date:** 2026-06-15

## Context

The harness ingest quality review found that changed source sessions could not be reprocessed because `writeSessionManifest()` wrote a single immutable manifest at `${sessionId}.json`. When the same `session_id` arrived with different content, the byte-for-byte immutability check threw `Immutable manifest already exists with different contents`. This blocked cursor backfill entirely and caused 30–80% losses for other harness backfills.

## Decision

Manifest paths are now revision-addressed by source hash:

- `getSessionManifestPathForRevision(sessionId, sourceHash)` returns `${sessionId}.${revision}.json`.
- `writeSessionManifest()` writes the revision path.
- Immutability is enforced per revision: identical bytes for the same session id + source hash return `created: false`; different bytes still throw.
- The legacy `${sessionId}.json` path is preserved as a read-only fallback. Existing readers (`retention.ts`, `delete-candidates.ts`, `resummarize.ts`) check the revision path first, then the legacy path.
- `export-index` dedupes legacy and revision manifests by source identity, keeping the newest `generated_at`.

## Consequences

- Reprocessing a changed transcript no longer collides with an earlier revision manifest.
- Old manifests remain readable but are not migrated, keeping the change backward-compatible.
- Export index now emits one record per source identity regardless of how many revision manifests exist on disk.
