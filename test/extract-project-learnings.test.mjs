import test from "node:test";
import assert from "node:assert/strict";

import { eventSchema, sourceSessionFixture, turnSchema } from "../dist/models/canonical.js";
import { extractLearnings } from "../dist/pipeline/extract.js";

function sourceSession(overrides = {}) {
  return {
    ...sourceSessionFixture,
    project_key: "studio-tools",
    session_id: "project-learning-session",
    source_hash: "sha256:project-learning",
    ...overrides
  };
}

function turn(overrides = {}) {
  const sessionId = overrides.session_id ?? "project-learning-session";
  return turnSchema.parse({
    assistant_summary: "No assistant summary captured.",
    commands_seen: [],
    ended_at: "2026-05-16T12:05:00Z",
    files_touched: [],
    index: 0,
    session_id: sessionId,
    started_at: "2026-05-16T12:00:00Z",
    tool_stub_count: 0,
    turn_id: `${sessionId}:turn-0000`,
    user_prompt: "Implement the project change.",
    verification_seen: false,
    ...overrides
  });
}

function event(turnId, type, summary, overrides = {}) {
  return eventSchema.parse({
    confidence: "medium",
    event_id: `${turnId}:${type}:000001`,
    payload_small: {
      matched_rule: type,
      ...(overrides.payload_small ?? {})
    },
    source_offsets: {
      end_line: 3,
      start_line: 3
    },
    summary,
    turn_id: turnId,
    type,
    ...overrides
  });
}

test("promotes same-turn fix and verification into project learning", () => {
  const source = sourceSession();
  const firstTurn = turn({
    files_touched: ["desktop/vitest.config.ts"],
    verification_seen: true
  });
  const events = [
    event(firstTurn.turn_id, "fix", "Updated Vitest config to use worker threads and happy-dom.", {
      event_id: `${firstTurn.turn_id}:fix:000001`,
      payload_small: {
        command_strings: ["desktop/vitest.config.ts", "happy-dom"],
        matched_rule: "updated"
      }
    }),
    event(firstTurn.turn_id, "verification", "Verification noted: All 92 tests pass.", {
      event_id: `${firstTurn.turn_id}:verification:000002`,
      payload_small: {
        command_strings: ["npm test"],
        matched_rule: "tests pass"
      }
    })
  ];

  const learnings = extractLearnings({
    events,
    sourceSession: source,
    turns: [firstTurn]
  });

  assert.ok(
    learnings.project.some((learning) =>
      learning.statement === "Fixed updated Vitest config to use worker threads and happy-dom; verified with `npm test`."
    )
  );
});

test("promotes error resolution when failure is followed by a fix", () => {
  const source = sourceSession();
  const firstTurn = turn();
  const events = [
    event(firstTurn.turn_id, "failure", "Import failed with ENOENT while loading shared/logging.", {
      event_id: `${firstTurn.turn_id}:failure:000001`
    }),
    event(firstTurn.turn_id, "fix", "Resolved by adding `configure_logging` to `shared/logging/__init__.py`.", {
      event_id: `${firstTurn.turn_id}:fix:000002`,
      payload_small: {
        command_strings: ["shared/logging/__init__.py"],
        matched_rule: "resolved"
      }
    })
  ];

  const learnings = extractLearnings({
    events,
    sourceSession: source,
    turns: [firstTurn]
  });

  assert.ok(
    learnings.project.some((learning) =>
      learning.kind === "failure_mode" &&
      learning.statement.includes("Resolved Import failed with ENOENT")
    )
  );
});

test("promotes workflow learning from project-specific commands", () => {
  const source = sourceSession();
  const firstTurn = turn({
    commands_seen: ["uv sync --all-extras", "pnpm install", "./.cursor/setup-worktree-unix.sh"],
    user_prompt: "@.cursor/worktrees.json develop a worktree setup script for this project"
  });

  const learnings = extractLearnings({
    events: [],
    sourceSession: source,
    turns: [firstTurn]
  });

  assert.ok(
    learnings.project.some((learning) =>
      learning.statement === "Use `./.cursor/setup-worktree-unix.sh` for worktree setup in studio-tools."
    )
  );
});

test("promotes file-scoped implementation learning from concrete fix evidence", () => {
  const source = sourceSession();
  const firstTurn = turn({
    files_touched: ["shared/db_sqlite.py"],
    user_prompt: "@shared/db_sqlite.py"
  });
  const events = [
    event(firstTurn.turn_id, "fix", "Resolved by adding `import psycopg.rows`.", {
      payload_small: {
        command_strings: ["shared/db_sqlite.py", "import psycopg.rows"],
        matched_rule: "resolved"
      }
    })
  ];

  const learnings = extractLearnings({
    events,
    sourceSession: source,
    turns: [firstTurn]
  });

  assert.ok(
    learnings.project.some((learning) =>
      learning.statement === "Updated shared/db_sqlite.py for @shared/db_sqlite.py: resolved by adding `import psycopg.rows`."
    )
  );
});

test("does not promote process-only future verification text", () => {
  const source = sourceSession();
  const firstTurn = turn({
    commands_seen: ["npm test"],
    user_prompt: "/docs/update"
  });
  const events = [
    event(firstTurn.turn_id, "verification", "I can verify after I finish checking the repo.", {
      payload_small: {
        matched_rule: "verified"
      }
    })
  ];

  const learnings = extractLearnings({
    events,
    sourceSession: source,
    turns: [firstTurn]
  });

  assert.deepEqual(learnings.project, []);
});
