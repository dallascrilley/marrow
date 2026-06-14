import assert from "node:assert/strict";
import test from "node:test";
import { instinctSchema } from "../dist/v2/instinct/schema.js";
import {
  MEMORY_LINE_CAP,
  renderMemoryMarkdown,
  selectInstinctsForRollup,
  shouldIncludeInRollup,
} from "../dist/v2/vault/render-memory.js";

function instinct(overrides = {}) {
  return instinctSchema.parse({
    schema_version: 1,
    id: "example-instinct-12345678",
    trigger: "When running tests",
    finding: "Run npm test before claiming done.",
    confidence: 0.75,
    domain: "testing",
    maturity: "established",
    scope: "project",
    project_id: "abc123def456",
    source: {
      first_session: "sess-1",
      first_observed_at: "2026-05-19T10:00:00Z",
      source_refs: [],
      observations: [{ session: "sess-1", reinforcing: true, at: "2026-05-19T10:00:00Z" }],
    },
    related: [],
    created_at: "2026-05-19T10:00:00Z",
    updated_at: "2026-05-19T10:00:00Z",
    last_promoted_at: null,
    ...overrides,
  });
}

test("shouldIncludeInRollup follows proven and established thresholds", () => {
  assert.equal(shouldIncludeInRollup(instinct({ maturity: "proven" })), true);
  assert.equal(
    shouldIncludeInRollup(instinct({ maturity: "established", confidence: 0.69 })),
    false,
  );
  assert.equal(
    shouldIncludeInRollup(instinct({ maturity: "established", confidence: 0.71 })),
    true,
  );
  assert.equal(shouldIncludeInRollup(instinct({ maturity: "candidate", confidence: 0.59 })), false);
  assert.equal(shouldIncludeInRollup(instinct({ maturity: "candidate", confidence: 0.61 })), true);
});

test("renderMemoryMarkdown spills when line cap exceeded", () => {
  const instincts = selectInstinctsForRollup(
    Array.from({ length: MEMORY_LINE_CAP + 5 }, (_, index) =>
      instinct({
        id: `instinct-number-${String(index).padStart(8, "0")}`,
        finding: `Finding number ${index} with enough text to consume lines.`,
        domain: index % 2 === 0 ? "workflow" : "testing",
      }),
    ),
    [],
  );

  const rendered = renderMemoryMarkdown(instincts);
  const lineCount = rendered.memory.split("\n").length;

  assert.ok(lineCount <= MEMORY_LINE_CAP + 5);
  assert.ok(rendered.spilledCount > 0);
  assert.ok(Object.keys(rendered.topics).length > 0);
});
