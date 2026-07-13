export type WorktreeClassification =
  | "clean-current"
  | "dirty-active"
  | "dirty-stale"
  | "merged"
  | "unknown";

export type WorktreeTask = {
  id: string;
  status: string;
  updatedAt: string;
};

export type WorktreeCandidate = {
  path: string;
  branch: string | null;
  head: string;
  dirty: boolean;
  detached: boolean;
  merged: boolean;
  lastCommitAt: string | null;
  task: WorktreeTask | null;
};

export type WorktreeClassificationResult = WorktreeCandidate & {
  classification: WorktreeClassification;
  nextCommand: string;
};

const activeWindowMs = 2 * 60 * 60 * 1000;

export function classifyWorktree(
  candidate: WorktreeCandidate,
  now: Date = new Date(),
): WorktreeClassificationResult {
  if (candidate.detached || !candidate.task || !candidate.branch) {
    return { ...candidate, classification: "unknown", nextCommand: inspectCommand(candidate.path) };
  }

  if (candidate.dirty) {
    const recent = isRecent(candidate.lastCommitAt, now) || isRecent(candidate.task.updatedAt, now);
    if (recent && candidate.task.status === "in_progress") {
      return {
        ...candidate,
        classification: "dirty-active",
        nextCommand: inspectCommand(candidate.path),
      };
    }
    return {
      ...candidate,
      classification: "dirty-stale",
      nextCommand: `td show ${candidate.task.id} && git -C ${quote(candidate.path)} status --short`,
    };
  }

  if (candidate.merged) {
    return {
      ...candidate,
      classification: "merged",
      nextCommand: `td show ${candidate.task.id} && git -C ${quote(candidate.path)} status --short`,
    };
  }

  return {
    ...candidate,
    classification: "clean-current",
    nextCommand: inspectCommand(candidate.path),
  };
}

function inspectCommand(path: string): string {
  return `git -C ${quote(path)} status --short`;
}

function isRecent(value: string | null, now: Date): boolean {
  if (!value) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && now.getTime() - time < activeWindowMs;
}

function quote(value: string): string {
  return JSON.stringify(value);
}
