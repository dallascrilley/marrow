import assert from "node:assert/strict";
import test from "node:test";

import { topicGenerationTelemetrySink } from "../dist/commands/ingest-backfill.js";

// Regression for the Codex finding on PR #45: the ingest path (ingest sync /
// backfill) must be able to record topic_generation telemetry, not just
// `quality resummarize`. The sink is gated on --llm-topic so no receipt logic
// runs when no paid topic-generation call can happen.
test("topicGenerationTelemetrySink returns undefined when llm-topic is off", () => {
  assert.equal(topicGenerationTelemetrySink(false), undefined);
});

test("topicGenerationTelemetrySink returns a usage sink when llm-topic is on", () => {
  const sink = topicGenerationTelemetrySink(true);
  assert.equal(typeof sink, "function");
});
