import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { DatabaseSync } from "node:sqlite";

import type { CommandContext } from "../cli.js";
import { ensureRuntimePath } from "../config/paths.js";
import { listSourceSessions } from "../db/ledger.js";
import type { ReviewQueueEntryRow } from "../db/queries.js";
import { listKnowledgeSnapshot } from "../read/knowledge.js";
import { listHarnessComparison, listPipelineStatus, listReviewItems } from "../read/operations.js";
import { getSessionDetailForRecord } from "../read/session-detail.js";
import { loadSessionIndexRecords } from "../read/session-index.js";
import {
  buildDashboardData,
  type DashboardReviewItem,
  type DashboardSession,
  renderDashboardHtml,
} from "../report/dashboard.js";

export async function executeReport(
  context: CommandContext,
  database: DatabaseSync,
): Promise<number> {
  const options = parseReportArgs(context.args);

  if (!options.html) {
    throw new Error("report currently requires --html");
  }
  const sessions = await loadDashboardSessions(database);
  const outputPath = options.outPath ?? join(await ensureRuntimePath("reports"), "dashboard.html");
  const dashboard = renderDashboardHtml(
    buildDashboardData(
      sessions,
      listPipelineStatus(database),
      await listKnowledgeSnapshot(database),
      await listHarnessComparison(database),
      listReviewItems(database).map(mapReviewItem),
    ),
  );

  await writeFile(outputPath, dashboard, "utf8");

  context.output.info(
    `Wrote dashboard HTML for ${sessions.length} session${sessions.length === 1 ? "" : "s"}.`,
  );
  context.output.info(`Output path: ${outputPath}`);
  return 0;
}

type ReportOptions = {
  html: boolean;
  outPath: string | null;
};

function parseReportArgs(args: readonly string[]): ReportOptions {
  let html = false;
  let outPath: string | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      continue;
    }

    if (arg === "--html") {
      html = true;
      continue;
    }

    if (arg === "--out") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--out requires a value");
      }
      outPath = value;
      index += 1;
      continue;
    }

    throw new Error(`Unknown flag: ${arg}`);
  }

  return { html, outPath };
}

async function loadDashboardSessions(database: DatabaseSync): Promise<DashboardSession[]> {
  const indexBySessionId = new Map(
    (await loadSessionIndexRecords({ database, fallbackToBuild: true })).map((record) => [
      record.asd_session_id,
      record,
    ]),
  );
  const sourceSessions = listSourceSessions(database);
  const sessions = await Promise.all(
    sourceSessions.map(async (sourceSession) => {
      const record = indexBySessionId.get(sourceSession.session_id);
      if (!record) {
        return null;
      }

      return {
        detail: await getSessionDetailForRecord(record),
        lifecycle_state: sourceSession.current_lifecycle_state,
      };
    }),
  );

  return sessions.filter((session): session is DashboardSession => session !== null);
}

function mapReviewItem(item: ReviewQueueEntryRow): DashboardReviewItem {
  return {
    current_lifecycle_state: item.current_lifecycle_state,
    enqueued_at: item.enqueued_at,
    project_key: item.project_key,
    queue_state: item.queue_state,
    reason: item.reason,
    review_kind: item.review_kind,
    session_id: item.session_id,
    updated_at: item.updated_at,
  };
}
