import assert from "node:assert/strict";
import test from "node:test";

import {
  assessProviderPreflight,
  providerPreflightExitCode,
  resolveOpenRouterReviewModel,
} from "../dist/pipeline/provider-preflight.js";

test("resolveOpenRouterReviewModel prefers explicit model then env default", () => {
  const previous = process.env.OPENROUTER_MODEL;
  process.env.OPENROUTER_MODEL = "custom/model";

  try {
    assert.equal(resolveOpenRouterReviewModel("override/model"), "override/model");
    assert.equal(resolveOpenRouterReviewModel(), "custom/model");
  } finally {
    if (previous === undefined) {
      delete process.env.OPENROUTER_MODEL;
    } else {
      process.env.OPENROUTER_MODEL = previous;
    }
  }
});

test("assessProviderPreflight reports missing credential and skips remote checks", async () => {
  const report = await assessProviderPreflight({
    apiKey: "",
    fetchImpl: notReachableFetch,
  });

  assert.equal(report.ok, false);
  assert.equal(report.checks.find((check) => check.id === "credential")?.status, "fail");
  assert.equal(report.checks.find((check) => check.id === "model_catalog")?.status, "warn");
  assert.equal(providerPreflightExitCode(report), 1);
});

test("assessProviderPreflight passes when catalog and route succeed", async () => {
  const report = await assessProviderPreflight({
    apiKey: "test-key",
    fetchImpl: createMockFetch({
      catalogIds: ["openai/gpt-5-nano"],
      routeStatus: 200,
    }),
    maxPer: "999/24h",
    maxUsd: "999/24h",
    model: "openai/gpt-5-nano",
  });

  assert.equal(report.ok, true);
  assert.equal(report.route_blocked_by_data_policy, false);
  assert.equal(providerPreflightExitCode(report), 0);
});

test("assessProviderPreflight exit code 2 for data-policy route block", async () => {
  const report = await assessProviderPreflight({
    apiKey: "test-key",
    fetchImpl: createMockFetch({
      catalogIds: ["openai/gpt-5-nano"],
      routeError:
        "No endpoints available matching your guardrail restrictions and data policy. Configure: https://openrouter.ai/settings/privacy",
      routeStatus: 404,
    }),
    maxPer: "999/24h",
    maxUsd: "999/24h",
    model: "openai/gpt-5-nano",
  });

  assert.equal(report.ok, false);
  assert.equal(report.route_blocked_by_data_policy, true);
  assert.equal(providerPreflightExitCode(report), 2);
  assert.match(report.summary, /settings\/privacy/);
});

test("assessProviderPreflight uses exit code 1 for non-policy route failures", async () => {
  const report = await assessProviderPreflight({
    apiKey: "test-key",
    fetchImpl: createMockFetch({
      catalogIds: ["openai/gpt-5-nano"],
      routeError: "Invalid API key",
      routeStatus: 401,
    }),
    maxPer: "999/24h",
    maxUsd: "999/24h",
    model: "openai/gpt-5-nano",
  });

  assert.equal(report.route_blocked_by_data_policy, false);
  assert.equal(providerPreflightExitCode(report), 1);
});

test("assessProviderPreflight reports checks in credential → catalog → route → budget order", async () => {
  const report = await assessProviderPreflight({
    apiKey: "test-key",
    fetchImpl: createMockFetch({
      catalogIds: ["openai/gpt-5-nano"],
      routeStatus: 200,
    }),
    maxPer: "999/24h",
    maxUsd: "999/24h",
    model: "openai/gpt-5-nano",
  });

  assert.deepEqual(
    report.checks.map((check) => check.id),
    ["credential", "model_catalog", "route", "count_budget", "usd_budget"],
  );
});

function notReachableFetch() {
  throw new Error("fetch should not be called when credential is missing");
}

function createMockFetch(input) {
  return async (url) => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;

    if (href.endsWith("/api/v1/models")) {
      return new Response(
        JSON.stringify({
          data: input.catalogIds.map((id) => ({ id })),
        }),
        { status: 200 },
      );
    }

    if (href.endsWith("/api/v1/chat/completions")) {
      if (input.routeStatus >= 400) {
        return new Response(
          JSON.stringify({
            error: { message: input.routeError ?? "route failed" },
          }),
          { status: input.routeStatus },
        );
      }

      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
      });
    }

    throw new Error(`unexpected fetch url: ${href}`);
  };
}
