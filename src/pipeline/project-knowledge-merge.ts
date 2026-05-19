import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Learning } from "../models/canonical.js";
import { learningSchema } from "../models/canonical.js";
import { semanticLearningStatementKey } from "./extract.js";

export type MergedProjectLearnings = {
  bySessionFile: Map<string, Learning[]>;
  merged: Learning[];
};

export async function mergeProjectKnowledgeDirectory(
  projectDir: string,
): Promise<MergedProjectLearnings> {
  const bySessionFile = new Map<string, Learning[]>();
  const files = (await readdir(projectDir)).filter((file) => file.endsWith(".jsonl"));

  for (const file of files.sort()) {
    const learnings = await readProjectKnowledgeFile(join(projectDir, file));
    bySessionFile.set(file, learnings);
  }

  return {
    bySessionFile,
    merged: dedupeProjectLearnings([...bySessionFile.values()].flat()),
  };
}

export function dedupeProjectLearnings(learnings: readonly Learning[]): Learning[] {
  const winners = new Map<string, Learning>();

  for (const learning of learnings) {
    const key = projectLearningDedupeKey(learning);
    const existing = winners.get(key);
    if (existing === undefined) {
      winners.set(key, learning);
      continue;
    }

    if (compareLearningRecency(learning, existing) > 0) {
      winners.set(key, mergeSourceRefs(learning, existing));
      continue;
    }

    winners.set(key, mergeSourceRefs(existing, learning));
  }

  return [...winners.values()].sort((left, right) =>
    left.learning_id.localeCompare(right.learning_id),
  );
}

function projectLearningDedupeKey(learning: Learning): string {
  const statementKey = semanticLearningStatementKey(learning.statement);
  const workflowToken = extractWorkflowCommandToken(learning.statement);
  if (workflowToken !== null && learning.kind === "workflow") {
    return `${learning.kind}:${workflowToken}:${learning.scope}`;
  }

  return `${learning.kind}:${statementKey}:${learning.scope}`;
}

function extractWorkflowCommandToken(statement: string): string | null {
  const match = statement.match(/\.\/\.codex\/prompts\/[^\s,)]+/i);
  return match?.[0] ?? null;
}

function compareLearningRecency(left: Learning, right: Learning): number {
  const leftSession = maxSessionIdFromRefs(left.source_refs);
  const rightSession = maxSessionIdFromRefs(right.source_refs);
  if (leftSession !== rightSession) {
    return leftSession.localeCompare(rightSession);
  }

  return left.learning_id.localeCompare(right.learning_id);
}

function maxSessionIdFromRefs(refs: Learning["source_refs"]): string {
  let max = "";
  for (const ref of refs) {
    if (ref.session_id.localeCompare(max) > 0) {
      max = ref.session_id;
    }
  }

  return max;
}

function mergeSourceRefs(existing: Learning, incoming: Learning): Learning {
  const refs = new Map<string, (typeof existing.source_refs)[number]>();
  for (const ref of [...existing.source_refs, ...incoming.source_refs]) {
    refs.set(sourceRefDedupeKey(ref), ref);
  }

  const mergedRefs = [...refs.values()].slice(0, 20);
  return {
    ...existing,
    source_refs: mergedRefs,
  };
}

function sourceRefDedupeKey(ref: Learning["source_refs"][number]): string {
  return `${ref.source_path}:${ref.session_id}:${ref.event_id ?? ""}:${ref.line ?? ""}`;
}

async function readProjectKnowledgeFile(path: string): Promise<Learning[]> {
  try {
    const contents = await readFile(path, "utf8");
    return contents
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => learningSchema.parse(JSON.parse(line)));
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
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
