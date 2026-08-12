import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { getRuntimeRoot, readOverrideEnvVar } from "../../dist/config/paths.js";

const CURRENT = "MARROW_ROOT";
const LEGACY = "AGENT_SESSION_DISTILLERY_ROOT";

function withEnv(values, run) {
  const previous = new Map();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("runtime root defaults to ~/.marrow when no override is set", () => {
  withEnv({ [CURRENT]: undefined, [LEGACY]: undefined }, () => {
    assert.equal(getRuntimeRoot(), join(homedir(), ".marrow"));
  });
});

test("the current override env var is honoured", () => {
  withEnv({ [CURRENT]: "/tmp/current-root", [LEGACY]: undefined }, () => {
    assert.equal(getRuntimeRoot(), "/tmp/current-root");
  });
});

test("the pre-rename override env var still works", () => {
  // Marrow was called agent-session-distillery. Anyone who exported the old
  // variable in a shell profile or launch agent keeps working after the rename.
  withEnv({ [CURRENT]: undefined, [LEGACY]: "/tmp/legacy-root" }, () => {
    assert.equal(getRuntimeRoot(), "/tmp/legacy-root");
    assert.equal(readOverrideEnvVar(CURRENT), "/tmp/legacy-root");
  });
});

test("the current override wins when both are set", () => {
  withEnv({ [CURRENT]: "/tmp/current-root", [LEGACY]: "/tmp/legacy-root" }, () => {
    assert.equal(getRuntimeRoot(), "/tmp/current-root");
  });
});

test("an empty override falls through to the next source", () => {
  withEnv({ [CURRENT]: "", [LEGACY]: "/tmp/legacy-root" }, () => {
    assert.equal(getRuntimeRoot(), "/tmp/legacy-root");
  });
});
