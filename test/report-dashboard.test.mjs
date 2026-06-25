import assert from "node:assert/strict";
import test from "node:test";

import { buildDashboardData, renderDashboardHtml } from "../dist/report/dashboard.js";

function makeSession(id, { turnBody, summaryTopic }) {
  return {
    lifecycle_state: "active",
    detail: {
      index: {
        asd_session_id: id,
        topic: `topic ${id}`,
        topic_source: "deterministic",
        next_step: `next ${id}`,
        source_tool: "claude-code",
        // Constant timestamp; buildDashboardData breaks ties on asd_session_id,
        // so order stays deterministic without per-id date juggling.
        updated_at: "2026-06-20T00:00:00.000Z",
      },
      summary: {
        topic: summaryTopic,
        topic_source: "deterministic",
        next_step: "n",
        deletion_readiness: "retain",
        what_worked: [],
        what_failed: [],
        what_was_decided: [],
        useful_commands: [],
        files_of_interest: [],
        project_learnings: [],
        user_learnings: [],
      },
      reduced_turns: [
        {
          index: 0,
          user_prompt: turnBody,
          assistant_summary: turnBody,
          verification_seen: false,
          tool_stub_count: 0,
          files_touched: [],
          commands_seen: [],
        },
      ],
    },
  };
}

const emptyPipeline = {
  totalSessions: 0,
  reviewQueue: {},
  deletionCandidates: {},
  sessionsByLifecycle: {},
  blockedReasons: {},
};
const emptyKnowledge = { projects: [], instincts: [], total_learnings: 0, total_instincts: 0 };
const emptyHarness = {
  by_source_tool: [],
  totals: { sessions: 0, project_learnings: 0, total_cost_usd: 0 },
};

function render(sessions) {
  return renderDashboardHtml(
    buildDashboardData(sessions, emptyPipeline, emptyKnowledge, emptyHarness, []),
  );
}

// The eager `data` payload is the single line `const data = {...};`.
function eagerPayloadLine(html) {
  const line = html.split("\n").find((l) => l.trimStart().startsWith("const data ="));
  assert.ok(line, "expected an eager `const data =` payload line");
  return line;
}

test("heavy turn bodies are lazy-loaded, not inlined in the eager payload", () => {
  const marker = "UNIQUE_TURN_BODY_a1b2c3";
  const html = render([
    makeSession("s1", { turnBody: marker, summaryTopic: "summary one" }),
    makeSession("s22", { turnBody: "other body", summaryTopic: "summary two" }),
  ]);

  // Heavy reduced-turn body must NOT appear in the eagerly parsed list payload.
  assert.ok(
    !eagerPayloadLine(html).includes(marker),
    "reduced-turn body leaked into the eager payload",
  );

  // It must appear inside a per-session lazy detail block.
  assert.match(html, /<script type="application\/json" class="asd-detail" data-session-id="s1">/);
  assert.ok(html.includes(marker), "turn body missing from lazy detail blocks");

  // One detail block per session.
  const blockCount = (html.match(/class="asd-detail"/g) ?? []).length;
  assert.equal(blockCount, 2);
});

test("list payload keeps the fields the sidebar needs (index + lifecycle + summary topic)", () => {
  const html = render([makeSession("s1", { turnBody: "b", summaryTopic: "searchable-topic" })]);
  const line = eagerPayloadLine(html);
  assert.ok(line.includes('"summary_topic":"searchable-topic"'), "summary_topic absent from list");
  assert.ok(line.includes('"asd_session_id":"s1"'), "index absent from list");
  assert.ok(line.includes('"lifecycle_state":"active"'), "lifecycle_state absent from list");
});

test("script-terminating sequences in data are neutralized", () => {
  const html = render([
    makeSession("s1", { turnBody: "</script><img src=x>", summaryTopic: "</script>" }),
  ]);
  // No raw `</script>` may originate from session data (only the literal block closers).
  const closers = (html.match(/<\/script>/g) ?? []).length;
  const openers = (html.match(/<script/g) ?? []).length;
  assert.equal(closers, openers, "unbalanced script tags — data broke out of a block");
  assert.ok(html.includes("\\u003c/script>"), "expected `<` in data to be escaped to \\u003c");
});
