import assert from "node:assert/strict";
import test from "node:test";

import {
  eventFixture,
  eventSchema,
  learningFixture,
  learningSchema,
  retentionReceiptFixture,
  retentionReceiptSchema,
  sourceSessionFixture,
  sourceSessionSchema,
  summaryFixture,
  summarySchema,
  turnFixture,
  turnSchema,
} from "../dist/models/canonical.js";

test("canonical fixtures are frozen stable targets", () => {
  assert.equal(Object.isFrozen(eventFixture), true);
  assert.equal(Object.isFrozen(turnFixture), true);
  assert.equal(Object.isFrozen(learningFixture), true);
  assert.equal(Object.isFrozen(summaryFixture), true);
  assert.equal(Object.isFrozen(retentionReceiptFixture), true);
  assert.equal(Object.isFrozen(sourceSessionFixture), true);
});

test("model schemas accept serialized canonical fixtures", () => {
  const roundTripEvent = JSON.parse(JSON.stringify(eventFixture));
  const roundTripTurn = JSON.parse(JSON.stringify(turnFixture));
  const roundTripLearning = JSON.parse(JSON.stringify(learningFixture));
  const roundTripSummary = JSON.parse(JSON.stringify(summaryFixture));
  const roundTripRetentionReceipt = JSON.parse(JSON.stringify(retentionReceiptFixture));
  const roundTripSourceSession = JSON.parse(JSON.stringify(sourceSessionFixture));

  assert.deepEqual(eventSchema.parse(roundTripEvent), eventFixture);
  assert.deepEqual(turnSchema.parse(roundTripTurn), turnFixture);
  assert.deepEqual(learningSchema.parse(roundTripLearning), learningFixture);
  assert.deepEqual(summarySchema.parse(roundTripSummary), summaryFixture);
  assert.deepEqual(
    retentionReceiptSchema.parse(roundTripRetentionReceipt),
    retentionReceiptFixture,
  );
  assert.deepEqual(sourceSessionSchema.parse(roundTripSourceSession), sourceSessionFixture);
});

test("event schema rejects malformed event payloads", () => {
  const malformed = {
    ...eventFixture,
    type: "bogus",
  };

  assert.throws(() => {
    eventSchema.parse(malformed);
  }, /Invalid option/);
});

test("turn schema rejects negative ordinals", () => {
  const malformed = {
    ...turnFixture,
    index: -1,
  };

  assert.throws(() => {
    turnSchema.parse(malformed);
  }, /Too small/);
});

test("learning schema rejects invalid confidence labels", () => {
  const malformed = {
    ...learningFixture,
    confidence: "certain",
  };

  assert.throws(() => {
    learningSchema.parse(malformed);
  }, /Invalid option/);
});

test("learning schema fills tier-1 defaults for legacy records missing trigger/evidence_type", () => {
  const { trigger, evidence_type, ...legacy } = JSON.parse(JSON.stringify(learningFixture));

  const parsed = learningSchema.parse(legacy);

  assert.equal(
    parsed.trigger,
    "When a similar situation recurs (legacy learning; original trigger not recorded).",
  );
  assert.equal(parsed.evidence_type, "inferred");
});

test("learning schema preserves a real trigger/evidence_type when present", () => {
  const parsed = learningSchema.parse(JSON.parse(JSON.stringify(learningFixture)));

  assert.equal(parsed.trigger, learningFixture.trigger);
  assert.equal(parsed.evidence_type, learningFixture.evidence_type);
});

test("summary schema rejects blank titles", () => {
  const malformed = {
    ...summaryFixture,
    topic: "",
  };

  assert.throws(() => {
    summarySchema.parse(malformed);
  }, /Too small/);
});

test("retention receipt schema rejects invalid retention statuses", () => {
  const malformed = {
    ...retentionReceiptFixture,
    safe_to_delete: "queued",
  };

  assert.throws(() => {
    retentionReceiptSchema.parse(malformed);
  });
});

test("source session schema rejects malformed nested payloads", () => {
  const malformed = {
    ...sourceSessionFixture,
    ingest_status: "queued",
    updated_at: "not-a-timestamp",
  };

  assert.throws(() => {
    sourceSessionSchema.parse(malformed);
  });
});
