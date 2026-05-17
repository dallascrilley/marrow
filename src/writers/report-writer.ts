import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getRuntimePath } from "../config/paths.js";
import type { RetentionReceipt } from "../models/canonical.js";
import { retentionReceiptSchema } from "../models/canonical.js";
import type { RetentionEvaluation } from "../pipeline/retention.js";

export type RetentionBatchReport = {
  blocked_count: number;
  generated_at: string;
  ready_count: number;
  sessions: Array<{
    archive_copy_written: boolean;
    project_learnings_written: boolean;
    reason_if_not: string;
    safe_to_delete: boolean;
    session_id: string;
    summary_written: boolean;
    user_learnings_written: boolean;
  }>;
  total_sessions: number;
};

export type BatchReportWriteResult = {
  jsonPath: string;
  markdownPath: string;
  report: RetentionBatchReport;
};

export type RetentionReceiptWriteResult = {
  path: string;
  receipt: RetentionReceipt;
};

export function getRetentionReceiptDirectoryPath(): string {
  return join(getRuntimePath("deletes"), "receipts");
}

export function getRetentionReceiptPath(sessionId: string): string {
  return join(getRetentionReceiptDirectoryPath(), `${sessionId}.json`);
}

export function getBatchReportJsonPath(reportName = "retention-readiness"): string {
  return join(getRuntimePath("reports"), `${reportName}.json`);
}

export function getBatchReportMarkdownPath(reportName = "retention-readiness"): string {
  return join(getRuntimePath("reports"), `${reportName}.md`);
}

export async function writeRetentionReceipt(receipt: RetentionReceipt): Promise<RetentionReceiptWriteResult> {
  const normalizedReceipt = retentionReceiptSchema.parse(receipt);
  const path = getRetentionReceiptPath(normalizedReceipt.session_id);
  await writeTextFile(path, `${JSON.stringify(normalizedReceipt, null, 2)}\n`);

  return {
    path,
    receipt: normalizedReceipt
  };
}

export async function writeRetentionBatchReport(
  evaluations: readonly RetentionEvaluation[],
  reportName = "retention-readiness"
): Promise<BatchReportWriteResult> {
  const report = buildBatchReport(evaluations);
  const jsonPath = getBatchReportJsonPath(reportName);
  const markdownPath = getBatchReportMarkdownPath(reportName);

  await Promise.all([
    writeTextFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`),
    writeTextFile(markdownPath, renderBatchReportMarkdown(report))
  ]);

  return {
    jsonPath,
    markdownPath,
    report
  };
}

function buildBatchReport(evaluations: readonly RetentionEvaluation[]): RetentionBatchReport {
  const sessions = evaluations.map((evaluation) => ({
    archive_copy_written: evaluation.receipt.archive_copy_written,
    project_learnings_written: evaluation.receipt.project_learnings_written,
    reason_if_not: evaluation.receipt.reason_if_not,
    safe_to_delete: evaluation.receipt.safe_to_delete,
    session_id: evaluation.receipt.session_id,
    summary_written: evaluation.receipt.summary_written,
    user_learnings_written: evaluation.receipt.user_learnings_written
  }));
  const readyCount = sessions.filter((session) => session.safe_to_delete).length;

  return {
    blocked_count: sessions.length - readyCount,
    generated_at: new Date().toISOString(),
    ready_count: readyCount,
    sessions,
    total_sessions: sessions.length
  };
}

function renderBatchReportMarkdown(report: RetentionBatchReport): string {
  const lines = [
    "# Retention Readiness Report",
    "",
    `- Generated at: ${report.generated_at}`,
    `- Total sessions: ${report.total_sessions}`,
    `- Ready to delete: ${report.ready_count}`,
    `- Blocked: ${report.blocked_count}`,
    "",
    "## Sessions"
  ];

  if (report.sessions.length === 0) {
    lines.push("- No sessions evaluated.", "");
    return `${lines.join("\n")}`;
  }

  for (const session of report.sessions) {
    lines.push(`- ${session.session_id}: ${session.safe_to_delete ? "ready" : session.reason_if_not}`);
  }

  lines.push("");
  return `${lines.join("\n")}`;
}

async function writeTextFile(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, "utf8");
}
