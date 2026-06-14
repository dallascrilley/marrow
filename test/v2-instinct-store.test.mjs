import assert from "node:assert/strict";
import test from "node:test";
import { instinctSchema } from "../dist/v2/instinct/schema.js";
import { parseInstinctYaml, serializeInstinct } from "../dist/v2/instinct/yaml-io.js";

test("instinct YAML round-trip preserves core fields", () => {
  const instinct = instinctSchema.parse({
    schema_version: 1,
    id: "trust-pnpm-over-npm-a3f9c1b2",
    trigger: "When installing packages",
    finding: "Use pnpm in this repo.",
    confidence: 0.72,
    domain: "tooling",
    maturity: "established",
    scope: "project",
    project_id: "a3f9c1b2d4e5",
    source: {
      first_session: "sess-1",
      first_observed_at: "2026-05-19T10:00:00Z",
      source_refs: [{ kind: "file", path: "package.json", session: "sess-1" }],
      observations: [
        {
          session: "sess-1",
          reinforcing: true,
          at: "2026-05-19T10:00:00Z",
        },
      ],
    },
    related: [],
    created_at: "2026-05-19T10:00:00Z",
    updated_at: "2026-05-19T11:00:00Z",
    last_promoted_at: null,
  });

  const parsed = parseInstinctYaml(serializeInstinct(instinct));
  assert.equal(parsed.id, instinct.id);
  assert.equal(parsed.finding, instinct.finding);
  assert.equal(parsed.domain, instinct.domain);
  assert.equal(parsed.confidence, instinct.confidence);
});

test("instinct schema rejects invalid id suffix", () => {
  assert.throws(() =>
    instinctSchema.parse({
      schema_version: 1,
      id: "bad-id",
      trigger: "t",
      finding: "f",
      confidence: 0.5,
      domain: "workflow",
      maturity: "candidate",
      scope: "project",
      project_id: "abc",
      source: {
        first_session: "s",
        first_observed_at: "2026-05-19T10:00:00Z",
        source_refs: [],
        observations: [{ session: "s", reinforcing: true, at: "2026-05-19T10:00:00Z" }],
      },
      related: [],
      created_at: "2026-05-19T10:00:00Z",
      updated_at: "2026-05-19T10:00:00Z",
      last_promoted_at: null,
    }),
  );
});
