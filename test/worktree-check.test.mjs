import assert from "node:assert/strict";
import test from "node:test";

import { classifyWorktree } from "../dist/worktree-check.js";

const now = new Date("2026-07-13T12:00:00.000Z");

function worktree(overrides = {}) {
  return {
    path: "/repo/.worktrees/example",
    branch: "feat/td-123abc-example",
    head: "abc123",
    dirty: false,
    detached: false,
    merged: false,
    lastCommitAt: "2026-07-13T11:30:00.000Z",
    task: { id: "td-123abc", status: "in_progress", updatedAt: "2026-07-13T11:45:00.000Z" },
    ...overrides,
  };
}

test("classifyWorktree keeps recent dirty tracked work active", () => {
  const result = classifyWorktree(worktree({ dirty: true }), now);

  assert.equal(result.classification, "dirty-active");
  assert.match(result.nextCommand, /git -C .* status --short/);
});

test("classifyWorktree never labels dirty active work merged", () => {
  const result = classifyWorktree(worktree({ dirty: true, merged: true }), now);

  assert.equal(result.classification, "dirty-active");
});

test("classifyWorktree flags old dirty work without calling it disposable", () => {
  const result = classifyWorktree(
    worktree({
      dirty: true,
      lastCommitAt: "2026-07-10T11:30:00.000Z",
      task: { id: "td-123abc", status: "open", updatedAt: "2026-07-10T11:45:00.000Z" },
    }),
    now,
  );

  assert.equal(result.classification, "dirty-stale");
  assert.match(result.nextCommand, /td show td-123abc/);
  assert.doesNotMatch(result.nextCommand, /remove|delete|discard/i);
});

test("classifyWorktree identifies merged and clean current worktrees", () => {
  assert.equal(classifyWorktree(worktree({ merged: true }), now).classification, "merged");
  assert.equal(classifyWorktree(worktree(), now).classification, "clean-current");
});

test("classifyWorktree leaves detached and untracked worktrees unknown", () => {
  assert.equal(classifyWorktree(worktree({ detached: true }), now).classification, "unknown");
  assert.equal(classifyWorktree(worktree({ task: null }), now).classification, "unknown");
});
