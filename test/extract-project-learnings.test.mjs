import assert from "node:assert/strict";
import test from "node:test";

import { eventSchema, sourceSessionFixture, turnSchema } from "../dist/models/canonical.js";
import { extractLearnings } from "../dist/pipeline/extract.js";

function sourceSession(overrides = {}) {
  return {
    ...sourceSessionFixture,
    project_key: "studio-tools",
    session_id: "project-learning-session",
    source_hash: "sha256:project-learning",
    ...overrides,
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
    ...overrides,
  });
}

function event(turnId, type, summary, overrides = {}) {
  return eventSchema.parse({
    confidence: "medium",
    event_id: `${turnId}:${type}:000001`,
    payload_small: {
      matched_rule: type,
      ...(overrides.payload_small ?? {}),
    },
    source_offsets: {
      end_line: 3,
      start_line: 3,
    },
    summary,
    turn_id: turnId,
    type,
    ...overrides,
  });
}

test("promotes same-turn fix and verification into project learning", () => {
  const source = sourceSession();
  const firstTurn = turn({
    files_touched: ["desktop/vitest.config.ts"],
    verification_seen: true,
  });
  const events = [
    event(firstTurn.turn_id, "fix", "Updated Vitest config to use worker threads and happy-dom.", {
      event_id: `${firstTurn.turn_id}:fix:000001`,
      payload_small: {
        command_strings: ["desktop/vitest.config.ts", "happy-dom"],
        matched_rule: "updated",
      },
    }),
    event(firstTurn.turn_id, "verification", "Verification noted: All 92 tests pass.", {
      event_id: `${firstTurn.turn_id}:verification:000002`,
      payload_small: {
        command_strings: ["npm test"],
        matched_rule: "tests pass",
      },
    }),
  ];

  const learnings = extractLearnings({
    events,
    sourceSession: source,
    turns: [firstTurn],
  });

  assert.ok(
    learnings.project.some(
      (learning) =>
        learning.statement ===
        "updated Vitest config to use worker threads and happy-dom; verified with `npm test`.",
    ),
  );
});

test("promotes error resolution when failure is followed by a fix", () => {
  const source = sourceSession();
  const firstTurn = turn();
  const events = [
    event(firstTurn.turn_id, "failure", "Import failed with ENOENT while loading shared/logging.", {
      event_id: `${firstTurn.turn_id}:failure:000001`,
    }),
    event(
      firstTurn.turn_id,
      "fix",
      "Resolved by adding `configure_logging` to `shared/logging/__init__.py`.",
      {
        event_id: `${firstTurn.turn_id}:fix:000002`,
        payload_small: {
          command_strings: ["shared/logging/__init__.py"],
          matched_rule: "resolved",
        },
      },
    ),
  ];

  const learnings = extractLearnings({
    events,
    sourceSession: source,
    turns: [firstTurn],
  });

  assert.ok(
    learnings.project.some(
      (learning) =>
        learning.kind === "failure_mode" &&
        learning.statement.includes("Resolved Import failed with ENOENT"),
    ),
  );
});

test("promotes workflow learning from project-specific commands", () => {
  const source = sourceSession();
  const firstTurn = turn({
    commands_seen: ["uv sync --all-extras", "pnpm install", "./.cursor/setup-worktree-unix.sh"],
    user_prompt: "@.cursor/worktrees.json develop a worktree setup script for this project",
  });

  const learnings = extractLearnings({
    events: [],
    sourceSession: source,
    turns: [firstTurn],
  });

  assert.ok(
    learnings.project.some(
      (learning) =>
        learning.statement ===
        "Use `./.cursor/setup-worktree-unix.sh` for worktree setup in studio-tools.",
    ),
  );
});

test("promotes file-scoped implementation learning from concrete fix evidence", () => {
  const source = sourceSession();
  const firstTurn = turn({
    files_touched: ["shared/db_sqlite.py"],
    user_prompt: "@shared/db_sqlite.py",
  });
  const events = [
    event(firstTurn.turn_id, "fix", "Resolved by adding `import psycopg.rows`.", {
      payload_small: {
        command_strings: ["shared/db_sqlite.py", "import psycopg.rows"],
        matched_rule: "resolved",
      },
    }),
  ];

  const learnings = extractLearnings({
    events,
    sourceSession: source,
    turns: [firstTurn],
  });

  assert.ok(
    learnings.project.some(
      (learning) =>
        learning.statement === "In shared/db_sqlite.py, resolved by adding `import psycopg.rows`.",
    ),
  );
});

test("does not promote process-only future verification text", () => {
  const source = sourceSession();
  const firstTurn = turn({
    commands_seen: ["npm test"],
    user_prompt: "/docs/update",
  });
  const events = [
    event(firstTurn.turn_id, "verification", "I can verify after I finish checking the repo.", {
      payload_small: {
        matched_rule: "verified",
      },
    }),
  ];

  const learnings = extractLearnings({
    events,
    sourceSession: source,
    turns: [firstTurn],
  });

  assert.deepEqual(learnings.project, []);
});

test("promotes PR review workflow from git worktree and gh commands", () => {
  const source = sourceSession({ project_key: "tether-ntfy-ios" });
  const firstTurn = turn({
    commands_seen: [
      "git worktree add ../tether-ntfy-ios-review-pr16",
      "gh pr diff 16",
      "git worktree remove ../tether-ntfy-ios-review-pr16",
    ],
    user_prompt: "checkout and review pr 16 and 17",
  });

  const learnings = extractLearnings({
    events: [],
    sourceSession: source,
    turns: [firstTurn],
  });

  assert.ok(
    learnings.project.some(
      (learning) =>
        learning.kind === "workflow" &&
        learning.statement.includes("git worktree") &&
        learning.statement.includes("PR review"),
    ),
  );
});

test("promotes fork sync workflow from git remote add upstream", () => {
  const source = sourceSession({ project_key: "openreel-video" });
  const firstTurn = turn({
    commands_seen: [
      "git remote add upstream https://github.com/original/repo.git",
      "git fetch upstream",
      "git merge upstream/main",
    ],
    user_prompt:
      "convert this into a private clone for me - keep upstream but push to a private repo",
  });

  const learnings = extractLearnings({
    events: [],
    sourceSession: source,
    turns: [firstTurn],
  });

  assert.ok(
    learnings.project.some(
      (learning) =>
        learning.kind === "workflow" &&
        learning.statement.includes("git remote add upstream") &&
        learning.statement.includes("private fork"),
    ),
  );
});

test("promotes crash diagnostic from fix prompt and diagnostic commands", () => {
  const source = sourceSession({ project_key: "hub" });
  const firstTurn = turn({
    commands_seen: ['bun -e "console.log(process.argv)"'],
    files_touched: ["/Users/dallascrilley/.pi/agent/pi-crash.log"],
    user_prompt: "fix: crash in pi tui at tui.js:974",
  });

  const learnings = extractLearnings({
    events: [],
    sourceSession: source,
    turns: [firstTurn],
  });

  assert.ok(
    learnings.project.some(
      (learning) => learning.kind === "failure_mode" && learning.statement.includes("crash"),
    ),
  );
});

test("promotes spec decision from speckit prompt and spec files", () => {
  const source = sourceSession({ project_key: "hub" });
  const firstTurn = turn({
    files_touched: ["/Users/dallascrilley/.hub/specs/004-hub-skills-cli-wrapper/spec.md"],
    user_prompt: "/speckit-specify create a hub wrapper around the skills cli",
  });

  const learnings = extractLearnings({
    events: [],
    sourceSession: source,
    turns: [firstTurn],
  });

  assert.ok(
    learnings.project.some(
      (learning) =>
        learning.kind === "decision" &&
        learning.statement.includes("spec.md") &&
        learning.statement.includes("architecture"),
    ),
  );
});

test("does not promote basic git init as project learning", () => {
  const source = sourceSession({ project_key: "warp-remote-dev" });
  const firstTurn = turn({
    commands_seen: ["git add --all && git commit -m", "git push -u origin main"],
    user_prompt: 'git add --all && git commit -m "chore: initial commit" && gh repo create',
  });

  const learnings = extractLearnings({
    events: [],
    sourceSession: source,
    turns: [firstTurn],
  });

  assert.deepEqual(learnings.project, []);
});

test("suppresses redundant raw done-block learnings when same-turn verified fix exists", () => {
  const source = sourceSession();
  const firstTurn = turn({
    commands_seen: ["./scripts/qa"],
    files_touched: ["pre_production/show_prep/runner.py"],
    user_prompt: "fix hot-reload path",
  });
  const events = [
    event(
      firstTurn.turn_id,
      "fix",
      "**Done:** Hot-reload is fixed. The CLI now runs real pipeline logic instead of only parsing args. **Verified:** `./scripts/qa` — 1750 passed, 0 failed.",
      {
        event_id: `${firstTurn.turn_id}:fix:000001`,
      },
    ),
    event(
      firstTurn.turn_id,
      "failure",
      "Summary of what was done: **1. Tests** - Runner handles download failures and marks the input failed.",
      {
        event_id: `${firstTurn.turn_id}:failure:000002`,
      },
    ),
    event(
      firstTurn.turn_id,
      "verification",
      "Verification noted: All checks passed with `./scripts/qa`.",
      {
        event_id: `${firstTurn.turn_id}:verification:000003`,
        payload_small: {
          matched_rule: "verified",
          verification_command: "./scripts/qa",
        },
      },
    ),
  ];

  const learnings = extractLearnings({
    events,
    sourceSession: source,
    turns: [firstTurn],
  });

  assert.equal(learnings.project.length, 1);
  assert.equal(learnings.project[0].kind, "workflow");
  assert.equal(
    learnings.project[0].statement,
    "Fixed hot-reload is fixed. The CLI now runs real pipeline logic instead of only parsing args; verified with `./scripts/qa`.",
  );
});

test("does not promote process narration as decisions or failures", () => {
  const source = sourceSession();
  const firstTurn = turn();
  const events = [
    event(
      firstTurn.turn_id,
      "decision",
      "Handler names would be like `shared.integrations.printing.on_pre_production_complete`; I can detect printing vs acuity by checking the handler name.",
      {
        event_id: `${firstTurn.turn_id}:decision:000001`,
      },
    ),
    event(
      firstTurn.turn_id,
      "failure",
      "Generation runs, but the normalize command failed due an invalid ast-grep flag in this environment. I’m checking the correct non-interactive fix flag.",
      {
        event_id: `${firstTurn.turn_id}:failure:000002`,
      },
    ),
  ];

  const learnings = extractLearnings({
    events,
    sourceSession: source,
    turns: [firstTurn],
  });

  assert.deepEqual(learnings.project, []);
});

test("normalizes duplicated fixed prefixes and what-changed clauses", () => {
  const source = sourceSession();
  const firstTurn = turn({
    commands_seen: ["cargo check"],
    user_prompt: "fix failed fetch emails",
  });
  const events = [
    event(
      firstTurn.turn_id,
      "fix",
      'Fixed "Failed to fetch emails" by forwarding Gmail credentials from the repo-root `.env` file to the Python subprocess in both Tauri commands.',
      {
        event_id: `${firstTurn.turn_id}:fix:000001`,
      },
    ),
    event(firstTurn.turn_id, "verification", "Verification noted: `cargo check` passes.", {
      event_id: `${firstTurn.turn_id}:verification:000002`,
      payload_small: {
        matched_rule: "verified",
        verification_command: "cargo check",
      },
    }),
  ];

  const learnings = extractLearnings({
    events,
    sourceSession: source,
    turns: [firstTurn],
  });

  assert.ok(
    learnings.project.some(
      (learning) =>
        learning.statement ===
        'fixed "Failed to fetch emails" by forwarding Gmail credentials from the repo-root `.env` file to the Python subprocess in both Tauri commands; verified with `cargo check`.',
    ),
  );
});

test("does not promote chat-summary decision prose", () => {
  const source = sourceSession({ project_key: "agent-workflows" });
  const firstTurn = turn();
  const events = [
    event(
      firstTurn.turn_id,
      "decision",
      "Now I have the full picture. Gaps vs skill-rules.json: - Missing registrations: design-md, enhance-prompt - Stale key names: redesign-skill.",
      {
        event_id: `${firstTurn.turn_id}:decision:000001`,
      },
    ),
    event(
      firstTurn.turn_id,
      "decision",
      "Clean. Here's a summary of every fix: fixed stale key names, registered missing skills, and updated references.",
      {
        event_id: `${firstTurn.turn_id}:decision:000002`,
      },
    ),
  ];

  const learnings = extractLearnings({
    events,
    sourceSession: source,
    turns: [firstTurn],
  });

  assert.deepEqual(learnings.project, []);
});

test("does not promote markdown-heavy code review summaries", () => {
  const source = sourceSession({ project_key: "studio-prep" });
  const firstTurn = turn();
  const events = [
    event(
      firstTurn.turn_id,
      "failure",
      "## Pragmatic Code Review: `feat/studio-prep-bridge` **Scope:** PR #133 merge. ### Must-fix 1. QA failure — import order. ### Nice-to-have 1. Split tests.",
      {
        event_id: `${firstTurn.turn_id}:failure:000001`,
      },
    ),
  ];

  const learnings = extractLearnings({
    events,
    sourceSession: source,
    turns: [firstTurn],
  });

  assert.deepEqual(learnings.project, []);
});

test("keeps explicit durable decisions", () => {
  const source = sourceSession({ project_key: "studio-tools" });
  const firstTurn = turn();
  const events = [
    event(
      firstTurn.turn_id,
      "decision",
      "Keep the pre-commit rule and fix bindings generation because callers require a single Result error channel.",
      {
        event_id: `${firstTurn.turn_id}:decision:000001`,
      },
    ),
  ];

  const learnings = extractLearnings({
    events,
    sourceSession: source,
    turns: [firstTurn],
  });

  assert.equal(learnings.project.length, 1);
  assert.equal(learnings.project[0].kind, "decision");
  assert.equal(
    learnings.project[0].statement,
    "Keep the pre-commit rule and fix bindings generation because callers require a single Result error channel.",
  );
});

test("normalizes completion workflow summaries before promotion", () => {
  const source = sourceSession();
  const firstTurn = turn({
    commands_seen: ["./scripts/qa"],
  });
  const events = [
    event(
      firstTurn.turn_id,
      "fix",
      "Completed implemented all QA cycle-time optimizations from the plan. **Changes:** | File | Change | |------|--------| | `desktop/vitest.config.ts` | Disable React compiler when `VITEST` is set; `pool: 'threads'`; pre-bundle dependencies.",
      {
        event_id: `${firstTurn.turn_id}:fix:000001`,
      },
    ),
    event(firstTurn.turn_id, "verification", "Verification noted: `./scripts/qa` passes.", {
      event_id: `${firstTurn.turn_id}:verification:000002`,
      payload_small: {
        matched_rule: "verified",
        verification_command: "./scripts/qa",
      },
    }),
  ];

  const learnings = extractLearnings({
    events,
    sourceSession: source,
    turns: [firstTurn],
  });

  assert.ok(
    learnings.project.some(
      (learning) =>
        learning.statement ===
        "implemented all QA cycle-time optimizations from the plan; verified with `./scripts/qa`.",
    ),
  );
});

test("does not promote generic todo bookkeeping decisions", () => {
  const source = sourceSession();
  const firstTurn = turn();
  const events = [
    event(
      firstTurn.turn_id,
      "decision",
      "Created to-dos in two places: 1. **Plan file** ([.cursor/plans/qa_cycle_time_under_40s_78795645.plan.md](.cursor/plans/qa_cycle_time_under_40s_78795645.plan.md)) – frontmatter `todos` list with 7 items aligned to the plan sections. 2. **Task tracker** entries for follow-up work.",
      {
        event_id: `${firstTurn.turn_id}:decision:000001`,
      },
    ),
  ];

  const learnings = extractLearnings({
    events,
    sourceSession: source,
    turns: [firstTurn],
  });

  assert.deepEqual(learnings.project, []);
});

test("normalizes verified workflow summaries into concise action statements", () => {
  const source = sourceSession();
  const firstTurn = turn({
    commands_seen: ["./scripts/qa"],
  });
  const events = [
    event(
      firstTurn.turn_id,
      "fix",
      "Completed added i18n, toasts, and stale indicator polish to the pre-production inbox UI — all hardcoded strings now use `t()` with keys in `en.json`. **Summary:** - Updated locale keys - Added warning toasts",
      {
        event_id: `${firstTurn.turn_id}:fix:000001`,
      },
    ),
    event(firstTurn.turn_id, "verification", "Verification noted: `./scripts/qa` passes.", {
      event_id: `${firstTurn.turn_id}:verification:000002`,
      payload_small: {
        matched_rule: "verified",
        verification_command: "./scripts/qa",
      },
    }),
  ];

  const learnings = extractLearnings({
    events,
    sourceSession: source,
    turns: [firstTurn],
  });

  assert.ok(
    learnings.project.some(
      (learning) =>
        learning.statement ===
        "added i18n, toasts, and stale indicator polish to the pre-production inbox UI — all hardcoded strings now use `t()` with keys in `en.json`; verified with `./scripts/qa`.",
    ),
  );
});

test("strips delivered sections from verified workflow summaries", () => {
  const source = sourceSession();
  const firstTurn = turn({
    commands_seen: ["./scripts/qa"],
  });
  const events = [
    event(
      firstTurn.turn_id,
      "fix",
      "Completed pre-Production E2E test scenarios are implemented according to the plan. **Delivered:** 1. **Jeff-style fixture** — `tests/fixtures/preproduction_jeff_e2e.json` 2. **Verification script** — `scripts/verify_preprod_e2e.py`",
      {
        event_id: `${firstTurn.turn_id}:fix:000001`,
      },
    ),
    event(firstTurn.turn_id, "verification", "Verification noted: `./scripts/qa` passes.", {
      event_id: `${firstTurn.turn_id}:verification:000002`,
      payload_small: {
        matched_rule: "verified",
        verification_command: "./scripts/qa",
      },
    }),
  ];

  const learnings = extractLearnings({
    events,
    sourceSession: source,
    turns: [firstTurn],
  });

  assert.ok(
    learnings.project.some(
      (learning) =>
        learning.statement ===
        "pre-Production E2E test scenarios are implemented according to the plan; verified with `./scripts/qa`.",
    ),
  );
});

test("rejects verified workflow summaries that remain markdown-heavy", () => {
  const source = sourceSession();
  const firstTurn = turn({
    commands_seen: ["./scripts/qa"],
  });
  const events = [
    event(
      firstTurn.turn_id,
      "fix",
      "Completed **Summary:** - First change - Second change - Third change",
      {
        event_id: `${firstTurn.turn_id}:fix:000001`,
      },
    ),
    event(firstTurn.turn_id, "verification", "Verification noted: `./scripts/qa` passes.", {
      event_id: `${firstTurn.turn_id}:verification:000002`,
      payload_small: {
        matched_rule: "verified",
        verification_command: "./scripts/qa",
      },
    }),
  ];

  const learnings = extractLearnings({
    events,
    sourceSession: source,
    turns: [firstTurn],
  });

  assert.deepEqual(learnings.project, []);
});

test("suppresses duplicate same-turn error resolution when verified workflow covers the fix", () => {
  const source = sourceSession();
  const firstTurn = turn({
    commands_seen: ["./scripts/qa"],
  });
  const events = [
    event(
      firstTurn.turn_id,
      "failure",
      "Added a Re-extract button to each draft episode card in the pre-production inbox",
      {
        event_id: `${firstTurn.turn_id}:failure:000001`,
      },
    ),
    event(
      firstTurn.turn_id,
      "fix",
      "Completed added a Re-extract button to each draft episode card in the pre-production inbox.",
      {
        event_id: `${firstTurn.turn_id}:fix:000002`,
      },
    ),
    event(
      firstTurn.turn_id,
      "verification",
      "Verification noted: all 91 tests pass. Run full QA: `./scripts/qa`.",
      {
        event_id: `${firstTurn.turn_id}:verification:000003`,
        payload_small: {
          matched_rule: "verified",
          verification_command: "./scripts/qa",
        },
      },
    ),
  ];

  const learnings = extractLearnings({
    events,
    sourceSession: source,
    turns: [firstTurn],
  });

  assert.deepEqual(
    learnings.project.map((learning) => learning.kind),
    ["workflow"],
  );
  assert.equal(
    learnings.project[0].statement,
    "added a Re-extract button to each draft episode card in the pre-production inbox; verified with `./scripts/qa`.",
  );
});

test("dedupes later error-resolution candidates covered by earlier verified workflow", () => {
  const source = sourceSession();
  const firstTurn = turn({
    commands_seen: ["./scripts/qa"],
  });
  const secondTurn = turn({
    index: 1,
    turn_id: "project-learning-session:turn-0001",
  });
  const events = [
    event(
      firstTurn.turn_id,
      "fix",
      "Completed added a Re-extract button to each draft episode card in the pre-production inbox.",
      {
        event_id: `${firstTurn.turn_id}:fix:000001`,
      },
    ),
    event(firstTurn.turn_id, "verification", "Verification noted: `./scripts/qa` passes.", {
      event_id: `${firstTurn.turn_id}:verification:000002`,
      payload_small: {
        matched_rule: "verified",
        verification_command: "./scripts/qa",
      },
    }),
    event(
      secondTurn.turn_id,
      "failure",
      "Added a Re-extract button to each draft episode card in the pre-production inbox",
      {
        event_id: `${secondTurn.turn_id}:failure:000001`,
      },
    ),
    event(secondTurn.turn_id, "fix", "All 91 tests pass. Run full QA: `./scripts/qa`.", {
      event_id: `${secondTurn.turn_id}:fix:000002`,
    }),
  ];

  const learnings = extractLearnings({
    events,
    sourceSession: source,
    turns: [firstTurn, secondTurn],
  });

  assert.deepEqual(
    learnings.project.map((learning) => learning.statement),
    [
      "added a Re-extract button to each draft episode card in the pre-production inbox; verified with `./scripts/qa`.",
    ],
  );
});

test("dedupes overlapping failure-mode candidates in favor of verified workflow", () => {
  const source = sourceSession();
  const firstTurn = turn({
    commands_seen: ["./scripts/qa"],
  });
  const secondTurn = turn({
    index: 1,
    turn_id: "project-learning-session:turn-0001",
  });
  const events = [
    event(
      firstTurn.turn_id,
      "fix",
      "Completed added a Re-extract button to each draft episode card in the pre-production inbox.",
      {
        event_id: `${firstTurn.turn_id}:fix:000001`,
      },
    ),
    event(firstTurn.turn_id, "verification", "Verification noted: `./scripts/qa` passes.", {
      event_id: `${firstTurn.turn_id}:verification:000002`,
      payload_small: {
        matched_rule: "verified",
        verification_command: "./scripts/qa",
      },
    }),
    event(
      secondTurn.turn_id,
      "failure",
      "Error after adding a Re-extract button to each draft episode card in the pre-production inbox.",
      {
        event_id: `${secondTurn.turn_id}:failure:000001`,
      },
    ),
  ];

  const learnings = extractLearnings({
    events,
    sourceSession: source,
    turns: [firstTurn, secondTurn],
  });

  assert.deepEqual(
    learnings.project.map((learning) => learning.statement),
    [
      "added a Re-extract button to each draft episode card in the pre-production inbox; verified with `./scripts/qa`.",
    ],
  );
});

test("promotes verification workflow when command is only in the summary text", () => {
  const source = sourceSession();
  const firstTurn = turn();
  const events = [
    event(firstTurn.turn_id, "verification", "Verification noted: `cargo check` passes.", {
      event_id: `${firstTurn.turn_id}:verification:000001`,
    }),
  ];

  const learnings = extractLearnings({
    events,
    sourceSession: source,
    turns: [firstTurn],
  });

  assert.equal(learnings.project.length, 1);
  assert.equal(learnings.project[0].kind, "verification_rule");
  assert.equal(
    learnings.project[0].statement,
    "Run cargo check when verifying changes in studio-tools.",
  );
});

test("promotes durable decision even when wrapped in explanatory framing", () => {
  const source = sourceSession({ project_key: "studio-tools" });
  const firstTurn = turn();
  const events = [
    event(
      firstTurn.turn_id,
      "decision",
      "Here's what we decided: keep the pre-commit rule and fix bindings generation because callers require a single Result error channel.",
      {
        event_id: `${firstTurn.turn_id}:decision:000001`,
      },
    ),
  ];

  const learnings = extractLearnings({
    events,
    sourceSession: source,
    turns: [firstTurn],
  });

  assert.equal(learnings.project.length, 1);
  assert.equal(learnings.project[0].kind, "decision");
  assert.ok(
    learnings.project[0].statement.includes("keep the pre-commit rule and fix bindings generation"),
  );
});

test("derives project workflow from turn commands when no events are extracted", () => {
  const source = sourceSession();
  const firstTurn = turn({
    commands_seen: ["./scripts/hot-reload-fix"],
    user_prompt: "fix hot-reload path",
  });

  const learnings = extractLearnings({
    events: [],
    sourceSession: source,
    turns: [firstTurn],
  });

  assert.equal(learnings.project.length, 1);
  assert.equal(learnings.project[0].kind, "workflow");
  assert.equal(
    learnings.project[0].statement,
    "Use `./scripts/hot-reload-fix` for fix hot-reload path in studio-tools.",
  );
});

test("derives file-scoped workflow from turn files and commands when no events are extracted", () => {
  const source = sourceSession();
  const firstTurn = turn({
    commands_seen: ["./scripts/apply-review-follow-ups"],
    files_touched: ["src/lib/auth.ts"],
    user_prompt: "Apply code-review follow-ups for the admin auth gate",
  });

  const learnings = extractLearnings({
    events: [],
    sourceSession: source,
    turns: [firstTurn],
  });

  assert.equal(learnings.project.length, 1);
  assert.equal(learnings.project[0].kind, "workflow");
  assert.ok(learnings.project[0].statement.includes("src/lib/auth.ts"));
  assert.ok(learnings.project[0].statement.includes("./scripts/apply-review-follow-ups"));
});

test("does not promote verification command from failed verification summary without payload", () => {
  const source = sourceSession();
  const firstTurn = turn();
  const events = [
    event(
      firstTurn.turn_id,
      "verification",
      "Verification attempt failed: `npm test` errored with 4 failures.",
      {
        event_id: `${firstTurn.turn_id}:verification:000001`,
      },
    ),
  ];

  const learnings = extractLearnings({
    events,
    sourceSession: source,
    turns: [firstTurn],
  });

  assert.deepEqual(learnings.project, []);
});

test("derives file-only workflow from turn files when no commands and no events are extracted", () => {
  const source = sourceSession();
  const firstTurn = turn({
    commands_seen: [],
    files_touched: ["src/lib/auth.ts"],
    user_prompt: "Apply code-review follow-ups for the admin auth gate",
  });

  const learnings = extractLearnings({
    events: [],
    sourceSession: source,
    turns: [firstTurn],
  });

  assert.equal(learnings.project.length, 1);
  assert.equal(learnings.project[0].kind, "workflow");
  assert.ok(learnings.project[0].statement.includes("src/lib/auth.ts"));
  assert.ok(learnings.project[0].statement.includes("admin auth gate"));
});

test("does not derive file-only workflow from non-concrete prompt", () => {
  const source = sourceSession();
  const firstTurn = turn({
    commands_seen: [],
    files_touched: ["src/lib/auth.ts"],
    user_prompt: "What do you think about the current auth setup?",
  });

  const learnings = extractLearnings({
    events: [],
    sourceSession: source,
    turns: [firstTurn],
  });

  assert.deepEqual(learnings.project, []);
});

test("rejects raw JSON reviewer findings as project learning", () => {
  const source = sourceSession();
  const firstTurn = turn();
  const events = [
    event(
      firstTurn.turn_id,
      "decision",
      '{"findings":[{"severity":"high","file":"src/a.ts","line":12}]}',
      {
        event_id: `${firstTurn.turn_id}:decision:000001`,
      },
    ),
  ];

  const learnings = extractLearnings({
    events,
    sourceSession: source,
    turns: [firstTurn],
  });

  assert.deepEqual(learnings.project, []);
});

test("rejects stack-trace and multi-line error dumps as project learning", () => {
  const source = sourceSession();
  const firstTurn = turn();
  const events = [
    event(
      firstTurn.turn_id,
      "failure",
      "Error: connect ECONNRESET\n    at TCPConnectWrap.afterConnect [as oncomplete] (net.js:1141:16)",
      {
        event_id: `${firstTurn.turn_id}:failure:000001`,
      },
    ),
  ];

  const learnings = extractLearnings({
    events,
    sourceSession: source,
    turns: [firstTurn],
  });

  assert.deepEqual(learnings.project, []);
});

test("rejects skill wrapper and skill doc text as project learning", () => {
  const source = sourceSession();
  const firstTurn = turn();
  const events = [
    event(
      firstTurn.turn_id,
      "fix",
      [
        "Base directory for this skill: /Users/dev/.claude/skills/example",
        "Reference: /SKILL.md",
        "Use when: debugging skill installation",
      ].join("\n"),
      {
        event_id: `${firstTurn.turn_id}:fix:000001`,
      },
    ),
  ];

  const learnings = extractLearnings({
    events,
    sourceSession: source,
    turns: [firstTurn],
  });

  assert.deepEqual(learnings.project, []);
});

test("rejects long assistant narrative dumps without a concise imperative rule", () => {
  const source = sourceSession();
  const firstTurn = turn();
  const events = [
    event(
      firstTurn.turn_id,
      "decision",
      [
        "Here's what we decided: after reviewing the available options we concluded that the current approach is reasonable for the immediate term.",
        "There are several factors to consider, including compatibility with existing callers, migration cost, and the long-term maintainability of the codebase.",
        "We will keep an eye on the metrics and revisit if the situation changes significantly in the next development cycle.",
      ].join(" "),
      {
        event_id: `${firstTurn.turn_id}:decision:000001`,
      },
    ),
  ];

  const learnings = extractLearnings({
    events,
    sourceSession: source,
    turns: [firstTurn],
  });

  assert.deepEqual(learnings.project, []);
});

test("derives workflow learning from concrete turn when only low-signal events exist", () => {
  const source = sourceSession();
  const firstTurn = turn({
    commands_seen: ["git commit -m 'fix: bindings'"],
    user_prompt: "commit atomically changed files",
  });
  const events = [
    event(firstTurn.turn_id, "next_step", "Next, commit the changes.", {
      event_id: `${firstTurn.turn_id}:next_step:000001`,
    }),
  ];

  const learnings = extractLearnings({
    events,
    sourceSession: source,
    turns: [firstTurn],
  });

  assert.equal(learnings.project.length, 1);
  assert.equal(learnings.project[0].kind, "workflow");
  assert.ok(learnings.project[0].statement.includes("git commit"));
});

test("derives workflow learning from concrete turn alongside unrelated process events", () => {
  const source = sourceSession();
  const firstTurn = turn({
    commands_seen: ["./scripts/qa"],
    files_touched: ["src/lib/auth.ts"],
    user_prompt: "Apply code-review follow-ups for the admin auth gate",
  });
  const events = [
    event(firstTurn.turn_id, "next_step", "Next, reviewed auth setup.", {
      event_id: `${firstTurn.turn_id}:next_step:000001`,
    }),
  ];

  const learnings = extractLearnings({
    events,
    sourceSession: source,
    turns: [firstTurn],
  });

  assert.equal(learnings.project.length, 1);
  assert.equal(learnings.project[0].kind, "workflow");
  assert.ok(learnings.project[0].statement.includes("src/lib/auth.ts"));
  assert.ok(learnings.project[0].statement.includes("./scripts/qa"));
});

test("does not derive workflow from skill-search wrapper prompt even when events exist", () => {
  const source = sourceSession();
  const firstTurn = turn({
    commands_seen: [],
    files_touched: [],
    user_prompt: [
      "Find the skill for CI debugging.",
      "Base directory for this skill: /Users/dev/.claude/skills/ci-debug",
      "Reference: /SKILL.md",
      "Use when: CI failures need triage",
    ].join("\n"),
  });
  const events = [
    event(firstTurn.turn_id, "next_step", "Reviewed skill index.", {
      event_id: `${firstTurn.turn_id}:next_step:000001`,
    }),
  ];

  const learnings = extractLearnings({
    events,
    sourceSession: source,
    turns: [firstTurn],
  });

  assert.deepEqual(learnings.project, []);
});

test("compresses markdown-heavy same-turn fix and verification into workflow learning", () => {
  const source = sourceSession();
  const firstTurn = turn({
    files_touched: ["desktop/vitest.config.ts"],
    user_prompt: "Implement the Vitest performance optimization plan",
  });
  const markdownFixSummary =
    "Summary of changes: ## Implemented **Vitest config** ([`desktop/vitest.config.ts`](desktop/vitest.config.ts)) - " +
    "`pool: 'threads'` – use worker threads instead of forks - `environment: 'happy-dom'` – lighter DOM env than jsdom";
  const events = [
    event(firstTurn.turn_id, "fix", markdownFixSummary, {
      event_id: `${firstTurn.turn_id}:fix:000001`,
    }),
    event(firstTurn.turn_id, "verification", "Verification noted: all tests pass", {
      event_id: `${firstTurn.turn_id}:verification:000002`,
      payload_small: {
        verification_command: "npm test",
      },
    }),
  ];

  const learnings = extractLearnings({
    events,
    sourceSession: source,
    turns: [firstTurn],
  });

  assert.equal(learnings.project.length, 1);
  assert.equal(learnings.project[0].kind, "workflow");
  assert.ok(learnings.project[0].statement.includes("desktop/vitest.config.ts"));
  assert.ok(learnings.project[0].statement.includes("use worker threads"));
});

test("compresses markdown-heavy fix into file-scoped pattern learning", () => {
  const source = sourceSession();
  const firstTurn = turn({
    files_touched: ["desktop/vitest.config.ts"],
    user_prompt: "Speed up the Vitest suite",
  });
  const markdownFixSummary =
    "Summary of changes: ## Implemented **Vitest config** ([`desktop/vitest.config.ts`](desktop/vitest.config.ts)) - " +
    "`pool: 'threads'` – use worker threads instead of forks - `environment: 'happy-dom'` – lighter DOM env than jsdom";
  const events = [
    event(firstTurn.turn_id, "fix", markdownFixSummary, {
      event_id: `${firstTurn.turn_id}:fix:000001`,
    }),
  ];

  const learnings = extractLearnings({
    events,
    sourceSession: source,
    turns: [firstTurn],
  });

  assert.equal(learnings.project.length, 1);
  assert.equal(learnings.project[0].kind, "pattern");
  assert.ok(learnings.project[0].statement.includes("desktop/vitest.config.ts"));
  assert.ok(learnings.project[0].statement.includes("use worker threads"));
});

test("still rejects markdown-heavy summary without recoverable file and action", () => {
  const source = sourceSession();
  const firstTurn = turn();
  const events = [
    event(
      firstTurn.turn_id,
      "fix",
      "## Changes\n- first unrelated item\n- second unrelated item\n- third unrelated item",
      {
        event_id: `${firstTurn.turn_id}:fix:000001`,
      },
    ),
  ];

  const learnings = extractLearnings({
    events,
    sourceSession: source,
    turns: [firstTurn],
  });

  assert.deepEqual(learnings.project, []);
});

test("sanitizes markdown table from decision learning statement", () => {
  const source = sourceSession({ project_key: "studio-tools" });
  const firstTurn = turn();
  const events = [
    event(
      firstTurn.turn_id,
      "decision",
      "Given how far behind main the branches are, **cherry-picking onto fresh branches from main** is usually better than rebasing. ## Rebase vs cherry-pick vs fresh start\n| Approach | Effort | Risk | Best when |\n|----------|--------|------|-----------|\n| rebase   | high   | high | short-lived branch |",
      {
        event_id: `${firstTurn.turn_id}:decision:000001`,
      },
    ),
  ];

  const learnings = extractLearnings({
    events,
    sourceSession: source,
    turns: [firstTurn],
  });

  assert.equal(learnings.project.length, 1);
  assert.equal(learnings.project[0].kind, "decision");
  assert.ok(!learnings.project[0].statement.includes("|"), "table pipes should be removed");
  assert.ok(!learnings.project[0].statement.includes("Approach"), "table header should be removed");
  assert.match(learnings.project[0].statement, /cherry-picking onto fresh branches from main/);
});

test("sanitizes bold emphasis and framing from decision learning statement", () => {
  const source = sourceSession({ project_key: "cohost-ai-studio" });
  const firstTurn = turn();
  const events = [
    event(
      firstTurn.turn_id,
      "decision",
      "**Verdict: Approved** The spec is internally consistent: storage abstraction, `blob_ref` vs `file_path` precedence, worker materialize/write-back contract.",
      {
        event_id: `${firstTurn.turn_id}:decision:000001`,
      },
    ),
  ];

  const learnings = extractLearnings({
    events,
    sourceSession: source,
    turns: [firstTurn],
  });

  assert.equal(learnings.project.length, 1);
  assert.equal(learnings.project[0].kind, "decision");
  assert.ok(!learnings.project[0].statement.includes("**"), "bold markers should be removed");
  assert.ok(
    learnings.project[0].statement.startsWith("Approved "),
    "framing token should be removed",
  );
});

test("does not derive workflow from prompt-instruction turn", () => {
  const source = sourceSession();
  const firstTurn = turn({
    commands_seen: [],
    files_touched: [
      "cohost-ai-studio/trigger-real-video-validation/docs/specs/2026-03-30-cloud-mode-design.md",
    ],
    user_prompt: "Re-read and review ONLY this file (updated after first review):",
  });

  const learnings = extractLearnings({
    events: [],
    sourceSession: source,
    turns: [firstTurn],
  });

  assert.deepEqual(learnings.project, []);
});
test("caps project learnings per session at default 12", () => {
  const source = sourceSession();
  const turns = [];
  for (let i = 0; i < 20; i++) {
    turns.push(
      turn({
        commands_seen: ["./scripts/qa"],
        files_touched: [`desktop/src/feature-${i}.ts`],
        index: i,
        session_id: source.session_id,
        turn_id: `${source.session_id}:turn-${String(i).padStart(4, "0")}`,
        user_prompt: "Fix the project issue.",
        verification_seen: true,
      }),
    );
  }

  const events = [];
  for (let i = 0; i < 20; i++) {
    const turnId = `${source.session_id}:turn-${String(i).padStart(4, "0")}`;
    events.push(
      event(turnId, "fix", `Fixed issue ${i} in desktop/src/feature-${i}.ts; verified.`, {
        event_id: `${turnId}:fix:001`,
      }),
    );
    events.push(
      event(turnId, "verification", `Verification ${i}: tests pass.`, {
        event_id: `${turnId}:verification:001`,
        payload_small: { matched_rule: "verification", verification_command: "./scripts/qa" },
      }),
    );
  }

  const result = extractLearnings({ events, sourceSession: source, turns });
  assert.equal(result.project.length, 12);
  assert.equal(result.project[0].kind, "workflow");
  assert.equal(result.project[11].kind, "workflow");
});

test("respects ASD_MAX_PROJECT_LEARNINGS override", () => {
  const original = process.env.ASD_MAX_PROJECT_LEARNINGS;
  process.env.ASD_MAX_PROJECT_LEARNINGS = "5";
  try {
    const source = sourceSession();
    const turns = [];
    for (let i = 0; i < 10; i++) {
      turns.push(
        turn({
          commands_seen: ["./scripts/qa"],
          files_touched: [`desktop/src/feature-${i}.ts`],
          index: i,
          session_id: source.session_id,
          turn_id: `${source.session_id}:turn-${String(i).padStart(4, "0")}`,
          user_prompt: "Fix the project issue.",
          verification_seen: true,
        }),
      );
    }

    const events = [];
    for (let i = 0; i < 10; i++) {
      const turnId = `${source.session_id}:turn-${String(i).padStart(4, "0")}`;
      events.push(
        event(turnId, "fix", `Fixed issue ${i} in desktop/src/feature-${i}.ts; verified.`, {
          event_id: `${turnId}:fix:001`,
        }),
      );
      events.push(
        event(turnId, "verification", `Verification ${i}: tests pass.`, {
          event_id: `${turnId}:verification:001`,
          payload_small: { matched_rule: "verification", verification_command: "./scripts/qa" },
        }),
      );
    }

    const result = extractLearnings({ events, sourceSession: source, turns });
    assert.equal(result.project.length, 5);
  } finally {
    if (original === undefined) {
      delete process.env.ASD_MAX_PROJECT_LEARNINGS;
    } else {
      process.env.ASD_MAX_PROJECT_LEARNINGS = original;
    }
  }
});

test("invalid ASD_MAX_PROJECT_LEARNINGS falls back to default cap", () => {
  const original = process.env.ASD_MAX_PROJECT_LEARNINGS;
  process.env.ASD_MAX_PROJECT_LEARNINGS = "invalid";
  try {
    const source = sourceSession();
    const turns = [];
    for (let i = 0; i < 15; i++) {
      turns.push(
        turn({
          commands_seen: ["./scripts/qa"],
          files_touched: [`desktop/src/feature-${i}.ts`],
          index: i,
          session_id: source.session_id,
          turn_id: `${source.session_id}:turn-${String(i).padStart(4, "0")}`,
          user_prompt: "Fix the project issue.",
          verification_seen: true,
        }),
      );
    }

    const events = [];
    for (let i = 0; i < 15; i++) {
      const turnId = `${source.session_id}:turn-${String(i).padStart(4, "0")}`;
      events.push(
        event(turnId, "fix", `Fixed issue ${i} in desktop/src/feature-${i}.ts; verified.`, {
          event_id: `${turnId}:fix:001`,
        }),
      );
      events.push(
        event(turnId, "verification", `Verification ${i}: tests pass.`, {
          event_id: `${turnId}:verification:001`,
          payload_small: { matched_rule: "verification", verification_command: "./scripts/qa" },
        }),
      );
    }

    const result = extractLearnings({ events, sourceSession: source, turns });
    assert.equal(result.project.length, 12);
  } finally {
    if (original === undefined) {
      delete process.env.ASD_MAX_PROJECT_LEARNINGS;
    } else {
      process.env.ASD_MAX_PROJECT_LEARNINGS = original;
    }
  }
});
