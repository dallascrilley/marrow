import test from "node:test";
import assert from "node:assert/strict";

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
