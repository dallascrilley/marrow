import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getRuntimePath } from "../config/paths.js";
import type { Learning } from "../models/canonical.js";
import { learningSchema } from "../models/canonical.js";

export type KnowledgeWriteResult = {
  project: {
    count: number;
    path: string | null;
  };
  user: {
    count: number;
    path: string | null;
  };
};

export function getProjectKnowledgeSessionPath(projectKey: string, sessionId: string): string {
  return join(getRuntimePath("knowledgeProjects"), projectKey, `${sessionId}.jsonl`);
}

export function getUserKnowledgeSessionPath(scopeKey: string, sessionId: string): string {
  return join(getRuntimePath("knowledgeUsers"), scopeKey, `${sessionId}.jsonl`);
}

export async function writeKnowledgeArtifacts(input: {
  projectLearnings: readonly Learning[];
  sessionId: string;
  userLearnings: readonly Learning[];
}): Promise<KnowledgeWriteResult> {
  const normalizedProjectLearnings = input.projectLearnings.map((learning) =>
    learningSchema.parse(learning),
  );
  const normalizedUserLearnings = input.userLearnings.map((learning) =>
    learningSchema.parse(learning),
  );
  const projectPath =
    normalizedProjectLearnings.length > 0
      ? getProjectKnowledgeSessionPath(normalizedProjectLearnings[0]!.scope_key, input.sessionId)
      : null;
  const userPath =
    normalizedUserLearnings.length > 0
      ? getUserKnowledgeSessionPath(normalizedUserLearnings[0]!.scope_key, input.sessionId)
      : null;

  await Promise.all([
    projectPath === null
      ? Promise.resolve()
      : writeJsonlFile(projectPath, normalizedProjectLearnings),
    userPath === null ? Promise.resolve() : writeJsonlFile(userPath, normalizedUserLearnings),
  ]);

  return {
    project: {
      count: normalizedProjectLearnings.length,
      path: projectPath,
    },
    user: {
      count: normalizedUserLearnings.length,
      path: userPath,
    },
  };
}

async function writeJsonlFile(path: string, entries: readonly Learning[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const contents = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  await writeFile(path, contents, "utf8");
}
