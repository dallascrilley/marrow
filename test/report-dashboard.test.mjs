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

function render(sessions, { knowledge = emptyKnowledge, reviewItems = [] } = {}) {
  return renderDashboardHtml(
    buildDashboardData(sessions, emptyPipeline, knowledge, emptyHarness, reviewItems),
  );
}

function parseEagerPayload(html) {
  const line = html.split("\n").find((l) => l.trimStart().startsWith("const data ="));
  return JSON.parse(
    line
      .trim()
      .replace(/^const data = /, "")
      .replace(/;$/, ""),
  );
}

function makeProject(i) {
  return {
    project_id: `proj-${i}`,
    source: "vault",
    learnings: [{ statement: `learning ${i}` }],
  };
}

function makeInstinct(i) {
  return {
    finding: `finding ${i}`,
    trigger: `trigger ${i}`,
    domain: "general",
    maturity: "emerging",
    confidence: 0.5,
    source: { source_refs: [] },
  };
}

function makeReviewItem(i) {
  return {
    current_lifecycle_state: "active",
    enqueued_at: "2026-06-20T00:00:00.000Z",
    project_key: `project-${i % 3}`,
    queue_state: "queued",
    reason: `reason ${i}`,
    review_kind: i % 2 === 0 ? "summary" : "learning",
    session_id: `rev-${String(i).padStart(3, "0")}`,
    updated_at: "2026-06-20T00:00:00.000Z",
  };
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

test("aggregate panels ship only displayed entries plus precomputed counts", () => {
  const knowledge = {
    projects: Array.from({ length: 30 }, (_, i) => makeProject(i)),
    instincts: Array.from({ length: 40 }, (_, i) => makeInstinct(i)),
    total_learnings: 123,
    total_instincts: 456,
  };
  const reviewItems = Array.from({ length: 50 }, (_, i) => makeReviewItem(i));
  const html = render([makeSession("s1", { turnBody: "b", summaryTopic: "t" })], {
    knowledge,
    reviewItems,
  });
  const data = parseEagerPayload(html);

  // Knowledge: only top-N entries inlined, but full count preserved.
  assert.equal(data.knowledge_snapshot.projects.length, 6);
  assert.equal(data.knowledge_snapshot.instincts.length, 8);
  assert.equal(data.knowledge_snapshot.projects_count, 30);
  assert.equal(data.knowledge_snapshot.total_learnings, 123);
  assert.equal(data.knowledge_snapshot.total_instincts, 456);
  // The full arrays must NOT have been inlined.
  assert.ok(!html.includes("proj-29"), "untrimmed project leaked into payload");
  assert.ok(!html.includes("finding 39"), "untrimmed instinct leaked into payload");

  // Review: only top-12 inlined; stats computed over the full set.
  assert.equal(data.review_items.length, 12);
  assert.equal(data.review_stats.total, 50);
  assert.equal(data.review_stats.kinds, 2); // summary + learning
  assert.equal(data.review_stats.projects, 3); // project-0/1/2
  assert.ok(!html.includes("reason 49"), "untrimmed review item leaked into payload");
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
