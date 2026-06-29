import assert from "node:assert/strict";
import test from "node:test";

import { canonicalKey } from "../dist/v2/instinct/id.js";

test("canonicalKey is order- and stopword-independent", () => {
  const a = canonicalKey("When installing packages", "Use pnpm in this repo");
  const b = canonicalKey("packages installing", "repo pnpm use");
  assert.equal(a, b);
});

test("canonicalKey folds simple plurals", () => {
  // The stemmer is deliberately light: it folds trailing -s plurals so
  // "tests"/"test" and "queries"/"query"-ish variants collapse, but does not
  // attempt full morphological stemming (which would risk over-merging).
  assert.equal(canonicalKey("the tests pass", ""), canonicalKey("the test passes", ""));
});

test("canonicalKey keeps genuinely distinct insights apart", () => {
  const a = canonicalKey("When installing packages", "Use pnpm in this repo");
  const b = canonicalKey("When writing SQL", "Always use parameterized queries");
  assert.notEqual(a, b);
});

test("canonicalKey is deterministic and dedupes repeated tokens", () => {
  const key = canonicalKey("test test test", "run the test again");
  assert.equal(key, canonicalKey("test", "run again"));
  // Sorted, deduped, stopword-free token join — no empty segments.
  assert.ok(!key.includes("--"));
  assert.ok(key.length > 0);
});
