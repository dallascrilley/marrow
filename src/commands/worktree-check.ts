import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { join, resolve } from "node:path";

import type { CommandContext } from "../cli.js";
import {
  classifyWorktree,
  type WorktreeCandidate,
  type WorktreeClassificationResult,
  type WorktreeTask,
} from "../worktree-check.js";

type WorktreeCheckOptions = {
  json: boolean;
  repoPath: string;
};

type PorcelainWorktree = {
  branch: string | null;
  detached: boolean;
  head: string;
  path: string;
};

type TrackerTaskRecord = {
  id?: unknown;
  status?: unknown;
  updated_at?: unknown;
};

type TrackerState = { available: boolean; tasks: Map<string, WorktreeTask> };

export async function executeWorktreeCheck(context: CommandContext): Promise<number> {
  const options = parseWorktreeCheckOptions(context.args);
  const tracker = loadTrackerTasks(options.repoPath);
  const worktrees = inspectWorktrees(options.repoPath, tracker.tasks);
  const report = {
    generated_at: new Date().toISOString(),
    repo_path: options.repoPath,
    tracker_available: tracker.available,
    worktrees,
  };

  context.output.info(options.json ? JSON.stringify(report, null, 2) : formatWorktreeCheck(report));
  return tracker.available ? 0 : 2;
}

function parseWorktreeCheckOptions(args: readonly string[]): WorktreeCheckOptions {
  let json = false;
  let repoPath = process.cwd();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--repo") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--repo requires a path");
      repoPath = resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown worktree check option: ${arg}`);
  }

  return { json, repoPath };
}

function inspectWorktrees(
  repoPath: string,
  tracker: ReadonlyMap<string, WorktreeTask>,
): WorktreeClassificationResult[] {
  return parseWorktreePorcelain(runGit(repoPath, ["worktree", "list", "--porcelain"])).map(
    (worktree) => {
      const taskId = worktree.branch?.match(/\btd-[a-z0-9]+\b/i)?.[0].toLowerCase() ?? null;
      const task = taskId ? (tracker.get(taskId) ?? null) : null;
      const dirty = inspectDirtyState(worktree.path);
      const candidate: WorktreeCandidate = {
        path: worktree.path,
        branch: worktree.branch,
        head: worktree.head,
        dirty: dirty.dirty,
        dirtyModifiedAt: dirty.modifiedAt,
        detached: worktree.detached,
        merged:
          task?.status === "closed" ||
          (worktree.branch ? isMerged(repoPath, worktree.branch) : false),
        lastCommitAt: gitTimestamp(worktree.path),
        task,
      };
      return classifyWorktree(candidate);
    },
  );
}

function inspectDirtyState(path: string): { dirty: boolean; modifiedAt: string | null } {
  const records = runGit(path, ["status", "--porcelain", "-z"]).split("\0").filter(Boolean);
  const modificationTimes = records.flatMap((record) => {
    const relativePath = record.slice(3);
    if (!relativePath) return [];
    try {
      return [statSync(join(path, relativePath)).mtime.toISOString()];
    } catch {
      return [];
    }
  });
  return {
    dirty: records.length > 0,
    modifiedAt: modificationTimes.sort().at(-1) ?? null,
  };
}

function parseWorktreePorcelain(output: string): PorcelainWorktree[] {
  return output
    .trim()
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const fields = new Map(
        block.split("\n").map((line) => {
          const separator = line.indexOf(" ");
          return separator === -1
            ? [line, ""]
            : [line.slice(0, separator), line.slice(separator + 1)];
        }),
      );
      const path = fields.get("worktree");
      const head = fields.get("HEAD");
      if (!path || !head) throw new Error("git worktree list returned an incomplete record");
      const ref = fields.get("branch");
      return {
        path,
        head,
        branch: ref?.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : null,
        detached: fields.has("detached"),
      };
    });
}

function loadTrackerTasks(repoPath: string): TrackerState {
  try {
    const records = JSON.parse(
      runCommand(repoPath, "td", ["list", "--format", "json", "--limit", "10000"]),
    ) as unknown;
    if (!Array.isArray(records)) return { available: false, tasks: new Map() };
    return {
      available: true,
      tasks: new Map(
        records.flatMap((record) => {
          const task = record as TrackerTaskRecord;
          if (
            typeof task.id !== "string" ||
            typeof task.status !== "string" ||
            typeof task.updated_at !== "string"
          ) {
            return [];
          }
          return [
            [
              task.id.toLowerCase(),
              { id: task.id, status: task.status, updatedAt: task.updated_at },
            ],
          ];
        }),
      ),
    };
  } catch {
    return { available: false, tasks: new Map() };
  }
}

function isMerged(repoPath: string, branch: string): boolean {
  for (const base of ["main", "origin/main"]) {
    try {
      runGit(repoPath, ["merge-base", "--is-ancestor", branch, base]);
      return true;
    } catch {
      // Try the next locally available main reference without fetching.
    }
  }
  return false;
}

function gitTimestamp(path: string): string | null {
  try {
    return runGit(path, ["log", "-1", "--format=%cI"]).trim() || null;
  } catch {
    return null;
  }
}

function runGit(path: string, args: readonly string[]): string {
  return runCommand(path, "git", args);
}

function runCommand(path: string, command: string, args: readonly string[]): string {
  return execFileSync(command, args, {
    cwd: path,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function formatWorktreeCheck(report: {
  generated_at: string;
  repo_path: string;
  worktrees: WorktreeClassificationResult[];
}): string {
  const lines = [`Worktree check: ${report.repo_path}`, `Generated: ${report.generated_at}`, ""];
  for (const worktree of report.worktrees) {
    lines.push(`${worktree.classification}\t${worktree.path}`);
    lines.push(
      `  branch: ${worktree.branch ?? "detached"}  task: ${worktree.task?.id ?? "unknown"}`,
    );
    lines.push(`  next: ${worktree.nextCommand}`);
  }
  return lines.join("\n");
}
