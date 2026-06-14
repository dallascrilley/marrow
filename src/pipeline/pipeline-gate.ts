import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { getRuntimePath, getRuntimeRoot } from "../config/paths.js";
import { learningSchema } from "../models/canonical.js";
import { getProjectKnowledgeSessionPath } from "../writers/knowledge-writer.js";
import { runDiscoverPhase, type SupportedSource, supportedSources } from "./discover.js";
import { assessLlmBudget, getDefaultMaxPerWindow, type LlmBudgetStatus } from "./llm-budget.js";

export type IngestGateSource = {
  discovered_count: number;
  pending_count: number;
};

export type PipelineGateReport = {
  ingest: {
    by_source: Record<string, IngestGateSource>;
    pending_sessions: number;
    skipped: boolean;
  };
  llm_budget: LlmBudgetStatus;
  llm_review: {
    pending_learnings: number;
    pending_sessions: number;
  };
  recommendations: {
    run_ingest: boolean;
    run_review_learnings: boolean;
    skip_review_learnings_reason: string | null;
  };
};

export async function assessPipelineGate(
  database: DatabaseSync,
  options: {
    maxPer?: string;
    skipIngest?: boolean;
    sources?: readonly SupportedSource[];
  } = {},
): Promise<PipelineGateReport> {
  const maxPer = options.maxPer ?? getDefaultMaxPerWindow();
  const bySource: Record<string, IngestGateSource> = {};
  let pendingSessions = 0;

  if (!options.skipIngest) {
    const selectedSources = options.sources ?? supportedSources;
    for (const source of selectedSources) {
      const discovery = await runDiscoverPhase({
        database,
        onlyNewOrChanged: true,
        source,
      });
      bySource[source] = {
        discovered_count: discovery.discoveredCount,
        pending_count: discovery.selectedCount,
      };
      pendingSessions += discovery.selectedCount;
    }
  }

  const llmReview = await countPendingLlmReview();
  const llmBudget = await assessLlmBudget(maxPer);

  let skipReviewReason: string | null = null;
  if (llmReview.pending_learnings === 0) {
    skipReviewReason = "no_unreviewed_project_learnings";
  } else if (!llmBudget.allowed) {
    skipReviewReason = "llm_budget_exhausted";
  }

  return {
    ingest: {
      by_source: bySource,
      pending_sessions: pendingSessions,
      skipped: options.skipIngest === true,
    },
    llm_budget: llmBudget,
    llm_review: llmReview,
    recommendations: {
      run_ingest: pendingSessions > 0,
      run_review_learnings: skipReviewReason === null,
      skip_review_learnings_reason: skipReviewReason,
    },
  };
}

export async function countPendingLlmReview(): Promise<{
  pending_learnings: number;
  pending_sessions: number;
}> {
  const projectsRoot = getRuntimePath("knowledgeProjects");
  const reviewedRoot = join(getRuntimeRoot(), "knowledge", "projects-reviewed");
  const sidecarPath = join(getRuntimePath("reports"), "llm-learning-review.jsonl");
  const reviewedLearningIds = await readReviewedLearningIds(sidecarPath);

  let pendingLearnings = 0;
  let pendingSessions = 0;

  const projectDirs = await listDirectories(projectsRoot);
  for (const projectKey of projectDirs) {
    const projectDir = join(projectsRoot, projectKey);
    const sessionFiles = (await readdir(projectDir)).filter((file) => file.endsWith(".jsonl"));

    for (const sessionFile of sessionFiles) {
      const sessionId = sessionFile.replace(/\.jsonl$/, "");
      const projectPath = getProjectKnowledgeSessionPath(projectKey, sessionId);
      const reviewedPath = join(reviewedRoot, projectKey, sessionFile);
      const learnings = await readLearningIds(projectPath);
      if (learnings.length === 0) {
        continue;
      }

      const pendingInSession = learnings.filter((learningId) => {
        if (reviewedLearningIds.has(learningId)) {
          return false;
        }

        return true;
      }).length;

      if (pendingInSession === 0) {
        const projectStat = await safeStat(projectPath);
        const reviewedStat = await safeStat(reviewedPath);
        if (
          projectStat &&
          reviewedStat &&
          projectStat.mtimeMs > reviewedStat.mtimeMs &&
          learnings.length > 0
        ) {
          pendingLearnings += learnings.length;
          pendingSessions += 1;
        }
        continue;
      }

      pendingLearnings += pendingInSession;
      pendingSessions += 1;
    }
  }

  return {
    pending_learnings: pendingLearnings,
    pending_sessions: pendingSessions,
  };
}

async function readReviewedLearningIds(path: string): Promise<Set<string>> {
  try {
    const contents = await readFile(path, "utf8");
    const ids = new Set<string>();
    for (const line of contents.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }

      const parsed = JSON.parse(trimmed) as { learning_id?: unknown };
      if (typeof parsed.learning_id === "string") {
        ids.add(parsed.learning_id);
      }
    }

    return ids;
  } catch (error) {
    if (isMissingFileError(error)) {
      return new Set<string>();
    }

    throw error;
  }
}

async function readLearningIds(path: string): Promise<string[]> {
  try {
    const contents = await readFile(path, "utf8");
    const ids: string[] = [];
    for (const line of contents.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }

      ids.push(learningSchema.parse(JSON.parse(trimmed)).learning_id);
    }

    return ids;
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }

    throw error;
  }
}

async function listDirectories(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }

    throw error;
  }
}

async function safeStat(path: string): Promise<{ mtimeMs: number } | null> {
  try {
    return await stat(path);
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }

    throw error;
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
