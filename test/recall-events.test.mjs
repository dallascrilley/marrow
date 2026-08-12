import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { appendRecallEvent, summarizeRecallEvents } from "../dist/v2/metrics/recall-events.js";

const runtimeOverrideEnvVar = "MARROW_ROOT";

test("recall summary keeps the newest successful delivery separate from later empty recalls", async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "marrow-recall-events-"));
  const previousRoot = process.env[runtimeOverrideEnvVar];
  process.env[runtimeOverrideEnvVar] = runtimeRoot;

  try {
    await appendRecallEvent({
      bytes: 120,
      delivered: true,
      project_id: "project-a",
      sections: 1,
      ts: "2026-07-12T11:00:00.000Z",
    });
    await appendRecallEvent({
      bytes: 0,
      delivered: false,
      project_id: "project-a",
      sections: 0,
      ts: "2026-07-12T12:00:00.000Z",
    });

    const summary = await summarizeRecallEvents();
    assert.equal(summary.last_fire_at, "2026-07-12T12:00:00.000Z");
    assert.equal(summary.last_delivered_at, "2026-07-12T11:00:00.000Z");
  } finally {
    if (previousRoot === undefined) {
      delete process.env[runtimeOverrideEnvVar];
    } else {
      process.env[runtimeOverrideEnvVar] = previousRoot;
    }
    await rm(runtimeRoot, { force: true, recursive: true });
  }
});
