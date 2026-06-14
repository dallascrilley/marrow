import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getRuntimePath } from "../config/paths.js";
import type { Summary } from "../models/canonical.js";
import { summarySchema } from "../models/canonical.js";

export type SummaryWriteResult = {
  markdownPath: string;
  sessionDirectoryPath: string;
  summary: Summary;
  summaryPath: string;
};

export function getSessionSummaryDirectoryPath(sessionId: string): string {
  return join(getRuntimePath("summaries"), sessionId);
}

export function getSessionSummaryJsonPath(sessionId: string): string {
  return join(getSessionSummaryDirectoryPath(sessionId), "summary.json");
}

export function getSessionSummaryMarkdownPath(sessionId: string): string {
  return join(getSessionSummaryDirectoryPath(sessionId), "summary.md");
}

export async function writeSessionSummary(summary: Summary): Promise<SummaryWriteResult> {
  const normalizedSummary = summarySchema.parse(summary);
  const summaryPath = getSessionSummaryJsonPath(normalizedSummary.session_id);
  const markdownPath = getSessionSummaryMarkdownPath(normalizedSummary.session_id);
  const sessionDirectoryPath = getSessionSummaryDirectoryPath(normalizedSummary.session_id);

  await mkdir(sessionDirectoryPath, { recursive: true });
  await Promise.all([
    writeTextFile(summaryPath, `${JSON.stringify(normalizedSummary, null, 2)}\n`),
    writeTextFile(markdownPath, renderSummaryMarkdown(normalizedSummary)),
  ]);

  return {
    markdownPath,
    sessionDirectoryPath,
    summary: normalizedSummary,
    summaryPath,
  };
}

function renderSummaryMarkdown(summary: Summary): string {
  const sections = [
    `# Session Summary: ${summary.topic}`,
    "",
    `- Session ID: ${summary.session_id}`,
    `- Deletion readiness: ${summary.deletion_readiness}`,
    "",
    "## What Worked",
    ...renderList(summary.what_worked),
    "",
    "## What Failed",
    ...renderList(summary.what_failed),
    "",
    "## Decisions",
    ...renderList(summary.what_was_decided),
    "",
    "## Useful Commands",
    ...renderList(summary.useful_commands),
    "",
    "## Files Of Interest",
    ...renderList(summary.files_of_interest),
    "",
    "## Next Step",
    summary.next_step,
    "",
    "## Project Learnings",
    ...renderList(summary.project_learnings),
    "",
    "## User Learnings",
    ...renderList(summary.user_learnings),
    "",
  ];

  return `${sections.join("\n")}`;
}

function renderList(values: readonly string[]): string[] {
  if (values.length === 0) {
    return ["- None noted."];
  }

  return values.map((value) => `- ${value}`);
}

async function writeTextFile(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, "utf8");
}
