import type { DatabaseSync } from "node:sqlite";

import { listSourceSessions } from "../db/ledger.js";
import type { SourceSession } from "../models/canonical.js";
import { loadParsedSessionManifests, type ParsedSessionManifest } from "../read/session-index.js";

export type SessionIntegrityFindingCode =
  | "duplicate_ledger_session_id"
  | "duplicate_asd_session_id"
  | "orphan_manifest";

export type SessionIntegrityFinding = {
  code: SessionIntegrityFindingCode;
  details: string;
  manifest_paths: string[];
  session_id: string;
};

export type SessionIntegrityReport = {
  counts: {
    duplicate_asd_session_ids: number;
    duplicate_ledger_session_ids: number;
    ledger_sessions: number;
    manifests: number;
    orphan_manifests: number;
  };
  findings: SessionIntegrityFinding[];
  ok: boolean;
};

/**
 * Writers already enforce:
 * - UNIQUE(source_tool, source_path, session_id) on ledger inserts
 * - Immutable revision-addressed manifests per source hash (ADR-0008)
 *
 * This check catches drift they do not prevent: duplicate asd_session_id across
 * manifests, duplicate session_id rows under different source identities, and
 * manifests with no matching ledger row.
 */
export async function assessSessionIntegrity(
  database: DatabaseSync,
): Promise<SessionIntegrityReport> {
  const findings: SessionIntegrityFinding[] = [];
  const ledgerSessions = listSourceSessions(database);
  const ledgerIdentities = new Set(ledgerSessions.map((session) => ledgerIdentityKey(session)));

  for (const row of findDuplicateLedgerSessionIds(database)) {
    findings.push({
      code: "duplicate_ledger_session_id",
      details: `${row.total} ledger rows share session_id (source_session ids: ${row.source_session_ids})`,
      manifest_paths: [],
      session_id: row.session_id,
    });
  }

  const manifests = await loadParsedSessionManifests();

  for (const manifest of manifests) {
    if (!ledgerIdentities.has(ledgerIdentityKey(manifest.session))) {
      findings.push({
        code: "orphan_manifest",
        details: `Manifest has no matching ledger row for source identity`,
        manifest_paths: [manifest.manifestPath],
        session_id: manifest.session.session_id,
      });
    }
  }

  const manifestsByAsdId = new Map<string, ParsedSessionManifest[]>();
  for (const manifest of manifests) {
    const group = manifestsByAsdId.get(manifest.asdSessionId) ?? [];
    group.push(manifest);
    manifestsByAsdId.set(manifest.asdSessionId, group);
  }

  for (const [asdSessionId, group] of manifestsByAsdId) {
    if (group.length <= 1) {
      continue;
    }

    findings.push({
      code: "duplicate_asd_session_id",
      details: `${group.length} manifests share asd_session_id from summary.json`,
      manifest_paths: group.map((entry) => entry.manifestPath),
      session_id: asdSessionId,
    });
  }

  const duplicateLedgerSessionIds = findings.filter(
    (finding) => finding.code === "duplicate_ledger_session_id",
  ).length;
  const duplicateAsdSessionIds = findings.filter(
    (finding) => finding.code === "duplicate_asd_session_id",
  ).length;
  const orphanManifests = findings.filter((finding) => finding.code === "orphan_manifest").length;

  return {
    counts: {
      duplicate_asd_session_ids: duplicateAsdSessionIds,
      duplicate_ledger_session_ids: duplicateLedgerSessionIds,
      ledger_sessions: ledgerSessions.length,
      manifests: manifests.length,
      orphan_manifests: orphanManifests,
    },
    findings,
    ok: findings.length === 0,
  };
}

export function sessionIntegrityExitCode(report: SessionIntegrityReport): number {
  return report.ok ? 0 : 1;
}

export function formatSessionIntegritySummary(report: SessionIntegrityReport): string {
  if (report.ok) {
    return `Session integrity OK (${report.counts.manifests} manifests, ${report.counts.ledger_sessions} ledger sessions).`;
  }

  const lines = [
    `Session integrity FAILED (${report.findings.length} finding(s); ${report.counts.manifests} manifests, ${report.counts.ledger_sessions} ledger sessions).`,
  ];

  for (const finding of report.findings) {
    const manifestHint =
      finding.manifest_paths.length > 0 ? ` manifests=${finding.manifest_paths.join(", ")}` : "";
    lines.push(`- ${finding.code}: ${finding.session_id} — ${finding.details}${manifestHint}`);
  }

  return lines.join("\n");
}

function ledgerIdentityKey(
  session: Pick<SourceSession, "session_id" | "source_path" | "source_tool">,
): string {
  return `${session.source_tool}\0${session.source_path}\0${session.session_id}`;
}

function findDuplicateLedgerSessionIds(database: DatabaseSync): Array<{
  session_id: string;
  source_session_ids: string;
  total: number;
}> {
  return database
    .prepare(
      `SELECT session_id, COUNT(*) AS total, GROUP_CONCAT(id) AS source_session_ids
       FROM source_sessions
       GROUP BY session_id
       HAVING COUNT(*) > 1
       ORDER BY session_id`,
    )
    .all() as Array<{
    session_id: string;
    source_session_ids: string;
    total: number;
  }>;
}
