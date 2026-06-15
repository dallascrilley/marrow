import assert from "node:assert/strict";
import test from "node:test";
import { parseReextractOptions } from "../dist/commands/pipeline-reextract.js";

test("parseReextractOptions defaults to empty options", () => {
  const options = parseReextractOptions([]);
  assert.deepEqual(options, {});
});

test("parseReextractOptions parses --dry-run", () => {
  const options = parseReextractOptions(["--dry-run"]);
  assert.equal(options.dryRun, true);
});

test("parseReextractOptions parses --over-extracted-only", () => {
  const options = parseReextractOptions(["--over-extracted-only"]);
  assert.equal(options.overExtractedOnly, true);
});

test("parseReextractOptions collects repeatable --session-id", () => {
  const options = parseReextractOptions(["--session-id", "session-a", "--session-id", "session-b"]);
  assert.deepEqual(options.sessionIds, ["session-a", "session-b"]);
});

test("parseReextractOptions rejects unknown options", () => {
  assert.throws(() => parseReextractOptions(["--unknown"]), /Unknown reextract option: --unknown/);
});

test("parseReextractOptions rejects missing --session-id value", () => {
  assert.throws(() => parseReextractOptions(["--session-id"]), /Missing value for --session-id/);
});

test("executePipelineReextract refuses to run without a selector", async () => {
  const { executePipelineReextract } = await import("../dist/commands/pipeline-reextract.js");
  await assert.rejects(
    executePipelineReextract({ args: [], output: { info: () => {}, error: () => {} } }, {}),
    /Refusing to re-extract all sessions without an explicit selector/,
  );
});
