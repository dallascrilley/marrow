import assert from "node:assert/strict";
import test from "node:test";

import {
  confidenceFromObservations,
  maturityStateFrom,
  proposedMaturity,
} from "../dist/v2/math/decay.js";

test("confidenceFromObservations increases with reinforcing observations", () => {
  const now = "2026-05-19T12:00:00Z";
  const sparse = confidenceFromObservations(
    [{ session: "s1", reinforcing: true, at: "2026-05-19T11:00:00Z" }],
    now,
  );
  const dense = confidenceFromObservations(
    [
      { session: "s1", reinforcing: true, at: "2026-05-10T11:00:00Z" },
      { session: "s2", reinforcing: true, at: "2026-05-12T11:00:00Z" },
      { session: "s3", reinforcing: true, at: "2026-05-18T11:00:00Z" },
    ],
    now,
  );

  assert.ok(dense > sparse);
});

test("confidenceFromObservations starts from the persisted floor", () => {
  const now = "2026-05-19T12:00:00Z";
  const oneObs = [{ session: "s1", reinforcing: true, at: "2026-05-19T11:00:00Z" }];

  // Default floor (legacy): a single observation pins to the 0.54 noise floor.
  const legacy = confidenceFromObservations(oneObs, now);
  assert.ok(Math.abs(legacy - 0.54) < 1e-3, `expected ~0.54, got ${legacy}`);

  // A high-signal floor (0.7) survives finalize: one observation lands >= 0.7.
  const high = confidenceFromObservations(oneObs, now, 0.7);
  assert.ok(high >= 0.7, `expected >= 0.7, got ${high}`);

  // A low-signal floor (0.4) still resolves >= 0.4.
  const low = confidenceFromObservations(oneObs, now, 0.4);
  assert.ok(low >= 0.4, `expected >= 0.4, got ${low}`);
});

test("a correction after reinforcement drops a floored instinct below the established bar", () => {
  const now = "2026-05-19T12:00:00Z";
  const observations = [
    { session: "s1", reinforcing: true, at: "2026-05-17T11:00:00Z" },
    { session: "s2", reinforcing: true, at: "2026-05-18T11:00:00Z" },
    { session: "s3", reinforcing: false, at: "2026-05-19T11:00:00Z" },
  ];
  // Floor 0.55 (medium): 0.55 + 0.04 + 0.04 - 0.16 ≈ 0.47 < 0.6 established bar.
  const conf = confidenceFromObservations(observations, now, 0.55);
  assert.ok(conf < 0.6, `expected < 0.6, got ${conf}`);
});

test("proposedMaturity reaches established with enough reinforcement", () => {
  const now = "2026-05-19T12:00:00Z";
  const state = maturityStateFrom(
    [
      { session: "s1", reinforcing: true, at: "2026-05-01T11:00:00Z" },
      { session: "s2", reinforcing: true, at: "2026-05-08T11:00:00Z" },
      { session: "s3", reinforcing: true, at: "2026-05-15T11:00:00Z" },
    ],
    now,
  );

  assert.equal(proposedMaturity("candidate", state), "established");
});
