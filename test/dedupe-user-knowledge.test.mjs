import assert from "node:assert/strict";
import test from "node:test";

import { dedupeUserRecords } from "../scripts/dedupe-user-knowledge.mjs";

test("dedupeUserRecords collapses normalized user preference variants", () => {
  const result = dedupeUserRecords([
    { kind: "preference", scope_key: "operator", statement: "Always run tests." },
    { kind: "preference", scope_key: "operator", statement: " always   run tests! " },
    { kind: "workflow", scope_key: "operator", statement: "Always run tests." },
  ]);

  assert.equal(result.inputCount, 3);
  assert.equal(result.outputCount, 2);
  assert.equal(result.duplicateCount, 1);
  assert.equal(result.duplicate_rate, undefined);
});
