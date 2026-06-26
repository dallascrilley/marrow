import {
  assessLlmBudget,
  assessUsdBudget,
  getDefaultMaxPerWindow,
  getDefaultMaxUsd,
  type LlmBudgetStatus,
  type LlmUsdBudgetStatus,
} from "./llm-budget.js";
import {
  defaultOpenRouterLearningReviewModel,
  openRouterApiKeyEnvVar,
  openRouterModelEnvVar,
} from "./llm-learning-review.js";

export type ProviderPreflightCheckId =
  | "credential"
  | "model_catalog"
  | "route"
  | "count_budget"
  | "usd_budget";

export type ProviderPreflightCheckStatus = "pass" | "fail" | "warn";

export type ProviderPreflightCheck = {
  detail?: Record<string, unknown>;
  id: ProviderPreflightCheckId;
  message: string;
  status: ProviderPreflightCheckStatus;
};

export type ProviderPreflightReport = {
  checks: ProviderPreflightCheck[];
  llm_budget: LlmBudgetStatus;
  model: string;
  ok: boolean;
  route_blocked_by_data_policy: boolean;
  summary: string;
  usd_budget: LlmUsdBudgetStatus;
};

export type ProviderPreflightOptions = {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  maxPer?: string;
  maxUsd?: string;
  model?: string;
};

type FetchLike = typeof fetch;

export function resolveOpenRouterReviewModel(model?: string): string {
  const fromInput = model?.trim();
  if (fromInput && fromInput.length > 0) {
    return fromInput;
  }

  const fromEnv = process.env[openRouterModelEnvVar]?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : defaultOpenRouterLearningReviewModel;
}

export async function assessProviderPreflight(
  options: ProviderPreflightOptions = {},
): Promise<ProviderPreflightReport> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const model = resolveOpenRouterReviewModel(options.model);
  const maxPer = options.maxPer ?? getDefaultMaxPerWindow();
  const maxUsd = options.maxUsd ?? getDefaultMaxUsd();
  const apiKey = options.apiKey ?? process.env[openRouterApiKeyEnvVar];
  const checks: ProviderPreflightCheck[] = [];

  if (apiKey === undefined || apiKey.trim().length === 0) {
    checks.push({
      id: "credential",
      message: `${openRouterApiKeyEnvVar} is not set`,
      status: "fail",
    });
    checks.push({
      id: "model_catalog",
      message: "Skipped model catalog check (missing credential)",
      status: "warn",
    });
    checks.push({
      id: "route",
      message: "Skipped route probe (missing credential)",
      status: "warn",
    });
  } else {
    checks.push({
      id: "credential",
      message: `${openRouterApiKeyEnvVar} is set`,
      status: "pass",
      detail: { source: options.apiKey === undefined ? "environment" : "option" },
    });
    checks.push(await checkModelCatalog(fetchImpl, apiKey, model));
    checks.push(await checkRoute(fetchImpl, apiKey, model));
  }

  const llmBudget = await assessLlmBudget(maxPer);
  checks.push({
    id: "count_budget",
    message: llmBudget.allowed
      ? `Count budget allows ${llmBudget.remaining} more call(s) in ${maxPer}`
      : `Count budget exhausted for ${maxPer}`,
    status: llmBudget.allowed ? "pass" : "fail",
    detail: {
      max_per_window: llmBudget.max_per_window,
      remaining: llmBudget.remaining,
      used_in_window: llmBudget.used_in_window,
    },
  });

  const usdBudget = await assessUsdBudget(maxUsd);
  checks.push({
    id: "usd_budget",
    message: usdBudget.allowed
      ? `USD budget allows $${usdBudget.remaining_usd.toFixed(4)} more in ${maxUsd}`
      : `USD budget exhausted for ${maxUsd}`,
    status: usdBudget.allowed ? "pass" : "fail",
    detail: {
      max_usd_per_window: usdBudget.max_usd_per_window,
      remaining_usd: usdBudget.remaining_usd,
      spent_usd: usdBudget.spent_usd,
    },
  });

  const routeBlocked = checks.some(
    (check) => check.id === "route" && check.detail?.data_policy_block === true,
  );
  const hardFail = checks.some((check) => check.status === "fail");
  const ok = !hardFail && !routeBlocked;
  const summary = buildSummary(checks, model, routeBlocked);

  return {
    checks,
    llm_budget: llmBudget,
    model,
    ok,
    route_blocked_by_data_policy: routeBlocked,
    summary,
    usd_budget: usdBudget,
  };
}

async function checkModelCatalog(
  fetchImpl: FetchLike,
  apiKey: string,
  model: string,
): Promise<ProviderPreflightCheck> {
  try {
    const response = await fetchImpl("https://openrouter.ai/api/v1/models", {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });
    const body = (await response.json()) as {
      data?: Array<{ id?: string }>;
      error?: { message?: string };
    };

    if (!response.ok) {
      return {
        id: "model_catalog",
        message: `Model catalog request failed (${response.status})`,
        status: "fail",
        detail: { status: response.status, error: body.error?.message ?? null },
      };
    }

    const ids = new Set((body.data ?? []).map((entry) => entry.id).filter(Boolean));
    if (!ids.has(model)) {
      return {
        id: "model_catalog",
        message: `Model "${model}" not found in OpenRouter catalog`,
        status: "fail",
        detail: { model },
      };
    }

    return {
      id: "model_catalog",
      message: `Model "${model}" is listed in OpenRouter catalog`,
      status: "pass",
      detail: { model },
    };
  } catch (error) {
    return {
      id: "model_catalog",
      message: `Model catalog request failed: ${formatError(error)}`,
      status: "fail",
    };
  }
}

async function checkRoute(
  fetchImpl: FetchLike,
  apiKey: string,
  model: string,
): Promise<ProviderPreflightCheck> {
  try {
    const response = await fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
      body: JSON.stringify({
        max_tokens: 1,
        messages: [{ content: "hi", role: "user" }],
        model,
      }),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });

    const bodyText = await response.text();
    let body: { error?: { message?: string } } = {};
    try {
      body = JSON.parse(bodyText) as { error?: { message?: string } };
    } catch {
      body = {};
    }

    if (response.ok) {
      return {
        id: "route",
        message: "OpenRouter route probe succeeded",
        status: "pass",
        detail: { model, status: response.status },
      };
    }

    const errorMessage = body.error?.message ?? bodyText.slice(0, 240);
    const dataPolicyBlock =
      response.status === 404 && /data policy|guardrail restrictions/i.test(errorMessage);

    return {
      id: "route",
      message: dataPolicyBlock
        ? "OpenRouter account data-policy guardrail blocks all routes for this model"
        : `OpenRouter route probe failed (${response.status})`,
      status: "fail",
      detail: {
        data_policy_block: dataPolicyBlock,
        error: errorMessage,
        model,
        status: response.status,
      },
    };
  } catch (error) {
    return {
      id: "route",
      message: `OpenRouter route probe failed: ${formatError(error)}`,
      status: "fail",
    };
  }
}

function buildSummary(
  checks: readonly ProviderPreflightCheck[],
  model: string,
  routeBlocked: boolean,
): string {
  const lines = [`Provider preflight for ${model}:`];
  for (const check of checks) {
    const marker = check.status === "pass" ? "[ok]" : check.status === "warn" ? "[warn]" : "[fail]";
    lines.push(`  ${marker} ${check.id}: ${check.message}`);
  }

  if (routeBlocked) {
    lines.push(
      "  Fix: adjust OpenRouter privacy/data-policy at https://openrouter.ai/settings/privacy",
    );
  }

  return lines.join("\n");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function providerPreflightExitCode(report: ProviderPreflightReport): number {
  if (report.route_blocked_by_data_policy) {
    return 2;
  }

  return report.ok ? 0 : 1;
}
