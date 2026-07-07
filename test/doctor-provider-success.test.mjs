import assert from "node:assert/strict";
import test from "node:test";

import { executeDoctorProvider } from "../dist/commands/doctor-provider.js";
import { withRuntimeRoot } from "./helpers/with-runtime-root.mjs";

// executeDoctorProvider (the `doctor provider` CLI command) does not thread a
// fetchImpl through to assessProviderPreflight -- only apiKey/maxPer/maxUsd/
// model are forwarded -- so the only network seam reachable from this layer
// is the process-global fetch that assessProviderPreflight falls back to.
// Swapping it here still genuinely exercises executeDoctorProvider's real
// code path (option parsing, delegating to assessProviderPreflight, exit-code
// mapping, JSON/plain-text rendering); only the OpenRouter HTTP boundary is
// stubbed, matching the existing unit-level success coverage in
// test/provider-preflight.test.mjs.
function installMockFetch() {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;

    if (href.endsWith("/api/v1/models")) {
      return new Response(JSON.stringify({ data: [{ id: "openai/gpt-5-nano" }] }), {
        status: 200,
      });
    }

    if (href.endsWith("/api/v1/chat/completions")) {
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
      });
    }

    throw new Error(`unexpected fetch url in doctor-provider success test: ${href}`);
  };

  return () => {
    globalThis.fetch = previousFetch;
  };
}

function makeContext(args) {
  const infoLines = [];
  const errorLines = [];
  return {
    context: {
      args,
      commandPath: ["doctor", "provider"],
      output: {
        error: (message) => errorLines.push(message),
        info: (message) => infoLines.push(message),
      },
    },
    errorLines,
    infoLines,
  };
}

test("doctor provider exits 0 and reports a healthy summary when credential/catalog/route/budget all pass", async () => {
  await withRuntimeRoot(async () => {
    const restoreFetch = installMockFetch();
    const previousApiKey = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;

    try {
      const { context, infoLines } = makeContext([
        "--api-key",
        "test-key",
        "--model",
        "openai/gpt-5-nano",
        "--max-per",
        "999/24h",
        "--max-usd",
        "999/24h",
      ]);

      const exitCode = await executeDoctorProvider(context);

      assert.equal(exitCode, 0);
      assert.equal(infoLines.length, 1);
      assert.match(infoLines[0], /OPENROUTER_API_KEY is set/);
      assert.match(infoLines[0], /\[ok\] credential/);
      assert.match(infoLines[0], /\[ok\] model_catalog/);
      assert.match(infoLines[0], /\[ok\] route/);
      assert.match(infoLines[0], /\[ok\] count_budget/);
      assert.match(infoLines[0], /\[ok\] usd_budget/);
    } finally {
      restoreFetch();
      if (previousApiKey === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = previousApiKey;
      }
    }
  });
});

test("doctor provider --json exits 0 with an ok:true report on the healthy path", async () => {
  await withRuntimeRoot(async () => {
    const restoreFetch = installMockFetch();
    const previousApiKey = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;

    try {
      const { context, infoLines } = makeContext([
        "--json",
        "--api-key",
        "test-key",
        "--model",
        "openai/gpt-5-nano",
        "--max-per",
        "999/24h",
        "--max-usd",
        "999/24h",
      ]);

      const exitCode = await executeDoctorProvider(context);

      assert.equal(exitCode, 0);
      assert.equal(infoLines.length, 1);
      const report = JSON.parse(infoLines[0]);
      assert.equal(report.ok, true);
      assert.equal(report.route_blocked_by_data_policy, false);
      assert.equal(report.model, "openai/gpt-5-nano");
      assert.deepEqual(
        report.checks.map((check) => check.id),
        ["credential", "model_catalog", "route", "count_budget", "usd_budget"],
      );
      assert.ok(report.checks.every((check) => check.status === "pass"));
    } finally {
      restoreFetch();
      if (previousApiKey === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = previousApiKey;
      }
    }
  });
});
