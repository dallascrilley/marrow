import { readFile } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";

import { listSourceSessions } from "../db/ledger.js";
import { summarySchema } from "../models/canonical.js";
import { getSessionSummaryJsonPath } from "../writers/summary-writer.js";
import { isLowSignalTopic, isWrapperLeakTopic } from "./summarize.js";

export type TopicDistributionProject = {
  deterministic_topics: number;
  llm_rescued_topics: number;
  low_signal_rate: number;
  low_signal_topics: number;
  missing_summaries: number;
  project_key: string;
  sessions: number;
  wrapper_leak_topics: number;
};

export type TopicDistributionReport = {
  by_project: TopicDistributionProject[];
  remediation: {
    commands: string[];
    resummarize_candidate_count: number;
  };
  totals: {
    deterministic_topics: number;
    invalid_summaries: number;
    llm_rescued_topics: number;
    low_signal_topics: number;
    missing_summaries: number;
    sessions: number;
    wrapper_leak_topics: number;
  };
};

export async function auditTopicDistribution(
  database: DatabaseSync,
  options: { limit?: number } = {},
): Promise<TopicDistributionReport> {
  const sourceSessions = listSourceSessions(database);
  const selectedSessions =
    options.limit === undefined
      ? sourceSessions
      : sourceSessions.slice(0, Math.max(0, options.limit));

  const projectMap = new Map<string, TopicDistributionProject>();
  const totals = {
    deterministic_topics: 0,
    invalid_summaries: 0,
    llm_rescued_topics: 0,
    low_signal_topics: 0,
    missing_summaries: 0,
    sessions: 0,
    wrapper_leak_topics: 0,
  };

  for (const sourceSession of selectedSessions) {
    totals.sessions += 1;
    const project = getProjectBucket(projectMap, sourceSession.project_key);
    project.sessions += 1;

    const summaryResult = await readSummary(sourceSession.session_id);
    if (summaryResult.error !== null) {
      if (summaryResult.error === "missing") {
        totals.missing_summaries += 1;
        project.missing_summaries += 1;
      } else {
        totals.invalid_summaries += 1;
      }
      continue;
    }

    const summary = summaryResult.summary;
    if (summary.topic_source === "llm") {
      totals.llm_rescued_topics += 1;
      project.llm_rescued_topics += 1;
    } else {
      totals.deterministic_topics += 1;
      project.deterministic_topics += 1;
    }

    if (isLowSignalTopic(summary.topic)) {
      totals.low_signal_topics += 1;
      project.low_signal_topics += 1;
    }

    if (isWrapperLeakTopic(summary.topic)) {
      totals.wrapper_leak_topics += 1;
      project.wrapper_leak_topics += 1;
    }
  }

  const byProject = [...projectMap.values()]
    .map((project) => ({
      ...project,
      low_signal_rate:
        project.sessions === 0
          ? 0
          : Number((project.low_signal_topics / project.sessions).toFixed(3)),
    }))
    .sort((left, right) => {
      if (right.low_signal_rate !== left.low_signal_rate) {
        return right.low_signal_rate - left.low_signal_rate;
      }

      return left.project_key.localeCompare(right.project_key);
    });

  return {
    by_project: byProject,
    remediation: {
      commands: ["npm run corpus:resummarize:dry-run", "npm run corpus:resummarize"],
      resummarize_candidate_count: totals.low_signal_topics,
    },
    totals,
  };
}

function getProjectBucket(
  projectMap: Map<string, TopicDistributionProject>,
  projectKey: string,
): TopicDistributionProject {
  const existing = projectMap.get(projectKey);
  if (existing) {
    return existing;
  }

  const created: TopicDistributionProject = {
    deterministic_topics: 0,
    llm_rescued_topics: 0,
    low_signal_rate: 0,
    low_signal_topics: 0,
    missing_summaries: 0,
    project_key: projectKey,
    sessions: 0,
    wrapper_leak_topics: 0,
  };
  projectMap.set(projectKey, created);
  return created;
}

type SummaryReadResult =
  | { error: "missing" | "invalid"; summary: null }
  | { error: null; summary: ReturnType<typeof summarySchema.parse> };

async function readSummary(sessionId: string): Promise<SummaryReadResult> {
  try {
    const contents = await readFile(getSessionSummaryJsonPath(sessionId), "utf8");
    return {
      error: null,
      summary: summarySchema.parse(JSON.parse(contents)),
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return { error: "missing", summary: null };
    }

    return { error: "invalid", summary: null };
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
