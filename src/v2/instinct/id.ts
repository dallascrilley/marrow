import { createHash } from "node:crypto";

import { STOPWORDS, slugFromFinding } from "./schema.js";

export function instinctIdFromTriggerFinding(trigger: string, finding: string): string {
  const slug = slugFromFinding(finding || trigger);
  const hash = createHash("sha256")
    .update(`${trigger}|${finding}`, "utf8")
    .digest("hex")
    .slice(0, 8);
  const base = slug.length > 0 ? slug : "instinct";
  const id = `${base}-${hash}`;
  return id.length <= 80 ? id : `${id.slice(0, 72)}-${hash}`;
}

// Light, deterministic stem: fold the most common English plural/tense
// variants so "run tests" and "running the test" share a canonical token.
// Intentionally conservative — over-stemming over-merges distinct insights,
// which the U5a spike's discard criteria guards against.
function stem(token: string): string {
  let t = token;
  if (t.length > 4 && t.endsWith("ing")) t = t.slice(0, -3);
  else if (t.length > 4 && t.endsWith("ed")) t = t.slice(0, -2);
  else if (t.length > 3 && t.endsWith("es")) t = t.slice(0, -2);
  else if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) t = t.slice(0, -1);
  return t;
}

/**
 * Order-independent merge discriminator for cross-session reinforcement.
 * Two learnings asserting the same insight in different words collapse to the
 * same key: lowercase, strip punctuation, drop stopwords, light-stem, then
 * dedupe + sort tokens. This is the *merge* key only; the addressing id
 * (instinctIdFromTriggerFinding) stays the exact content hash.
 */
export function canonicalKey(trigger: string, finding: string): string {
  const tokens = `${trigger} ${finding}`
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0 && !STOPWORDS.has(w))
    .map(stem)
    .filter((w) => w.length > 0 && !STOPWORDS.has(w));
  return Array.from(new Set(tokens)).sort().join("-");
}
