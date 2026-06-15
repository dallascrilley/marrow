import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getRuntimePath } from "../config/paths.js";
import { getLlmTelemetryPath, type LlmTelemetryRecord } from "./llm-telemetry.js";

export type MaxPerWindow = {
  max: number;
  unit: "h" | "m";
  windowAmount: number;
  windowMs: number;
};

export type LlmBudgetStatus = {
  allowed: boolean;
  max_per_window: string;
  remaining: number;
  state_path: string;
  used_in_window: number;
  window_ms: number;
  window_started_at: string;
};

type BudgetState = {
  uses: string[];
};

const defaultMaxPer = "5/24h";

export function parseMaxPerWindow(spec: string): MaxPerWindow {
  const match = /^(\d+)\/(\d+)(h|m)$/.exec(spec.trim());
  if (!match) {
    throw new Error(
      `Invalid max-per window "${spec}". Expected N/Tu where Tu is hours (h) or minutes (m), e.g. 5/24h`,
    );
  }

  const max = Number(match[1]);
  const windowAmount = Number(match[2]);
  const unit = match[3] as "h" | "m";

  if (!Number.isInteger(max) || max < 0) {
    throw new Error(`Invalid max-per count in "${spec}"`);
  }

  if (!Number.isInteger(windowAmount) || windowAmount <= 0) {
    throw new Error(`Invalid max-per window amount in "${spec}"`);
  }

  const windowMs = unit === "h" ? windowAmount * 60 * 60 * 1000 : windowAmount * 60 * 1000;
  return { max, unit, windowAmount, windowMs };
}

export function getDefaultMaxPerWindow(): string {
  const fromEnv = process.env.ASD_LLM_MAX_PER?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : defaultMaxPer;
}

export function getLlmBudgetStatePath(): string {
  return join(getRuntimePath("reports"), "llm-budget.json");
}

export async function assessLlmBudget(
  maxPerSpec: string = getDefaultMaxPerWindow(),
): Promise<LlmBudgetStatus> {
  const window = parseMaxPerWindow(maxPerSpec);
  const statePath = getLlmBudgetStatePath();
  const state = await readBudgetState(statePath);
  const now = Date.now();
  const windowStart = now - window.windowMs;
  const usesInWindow = state.uses.filter((iso) => Date.parse(iso) >= windowStart);
  const usedInWindow = usesInWindow.length;
  const remaining = Math.max(0, window.max - usedInWindow);

  return {
    allowed: remaining > 0,
    max_per_window: maxPerSpec,
    remaining,
    state_path: statePath,
    used_in_window: usedInWindow,
    window_ms: window.windowMs,
    window_started_at: new Date(windowStart).toISOString(),
  };
}

export async function recordLlmBudgetUse(
  maxPerSpec: string = getDefaultMaxPerWindow(),
): Promise<LlmBudgetStatus> {
  const statePath = getLlmBudgetStatePath();
  const state = await readBudgetState(statePath);
  state.uses.push(new Date().toISOString());
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return assessLlmBudget(maxPerSpec);
}

// --- USD spend ceiling (U5) -------------------------------------------------

export type MaxUsdWindow = {
  maxUsd: number;
  unit: "h" | "m";
  windowAmount: number;
  windowMs: number;
};

export type LlmUsdBudgetStatus = {
  allowed: boolean;
  max_usd_per_window: string;
  max_usd: number;
  spent_usd: number;
  remaining_usd: number;
  state_path: string;
  window_ms: number;
  window_started_at: string;
};

// Conservative default for the $5 BYOK test key: cap each trailing-24h drain at
// roughly a third of the key before it can run away.
const defaultMaxUsd = "1/24h";

export function getDefaultMaxUsd(): string {
  const fromEnv = process.env.ASD_LLM_MAX_USD?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : defaultMaxUsd;
}

// Same `N/Tu` window grammar as the count budget, but the amount is USD and may
// be fractional (e.g. 0.50/24h).
export function parseMaxUsdWindow(spec: string): MaxUsdWindow {
  const match = /^(\d+(?:\.\d+)?)\/(\d+)(h|m)$/.exec(spec.trim());
  if (!match) {
    throw new Error(
      `Invalid max-usd window "${spec}". Expected U/Tu where Tu is hours (h) or minutes (m), e.g. 1/24h or 0.50/24h`,
    );
  }

  const maxUsd = Number(match[1]);
  const windowAmount = Number(match[2]);
  const unit = match[3] as "h" | "m";

  if (!Number.isFinite(maxUsd) || maxUsd < 0) {
    throw new Error(`Invalid max-usd amount in "${spec}"`);
  }

  if (!Number.isInteger(windowAmount) || windowAmount <= 0) {
    throw new Error(`Invalid max-usd window amount in "${spec}"`);
  }

  const windowMs = unit === "h" ? windowAmount * 60 * 60 * 1000 : windowAmount * 60 * 1000;
  return { maxUsd, unit, windowAmount, windowMs };
}

/**
 * Assess the hard USD ceiling by summing the *effective* (upstream-aware) cost
 * of known-cost telemetry receipts in the trailing window. Budgets on effective
 * cost so it still triggers for BYOK keys whose OpenRouter `usage.cost` is 0.
 * Unknown-cost calls are not counted (we never estimate spend).
 */
export async function assessUsdBudget(
  maxUsdSpec: string = getDefaultMaxUsd(),
  options: { now?: number; telemetryPath?: string } = {},
): Promise<LlmUsdBudgetStatus> {
  const window = parseMaxUsdWindow(maxUsdSpec);
  const telemetryPath = options.telemetryPath ?? getLlmTelemetryPath();
  const now = options.now ?? Date.now();
  const windowStart = now - window.windowMs;

  const records = await readTelemetryRecords(telemetryPath);
  let spent = 0;
  let unknownCostInWindow = 0;
  for (const record of records) {
    const timestamp = Date.parse(record["asd.created_at"]);
    if (Number.isNaN(timestamp) || timestamp < windowStart) {
      continue;
    }
    const cost = record["gen_ai.usage.cost"];
    // A receipt only contributes when it carries a real number. `cost_is_known`
    // should imply a non-null cost, but guard the amount directly so a malformed
    // receipt (known-cost flag with a null/NaN cost) is surfaced, not silently
    // counted as $0 — which would let real spend slip past the gate.
    if (record["gen_ai.usage.cost_is_known"] === true && typeof cost === "number") {
      spent += cost;
    } else {
      unknownCostInWindow += 1;
    }
  }
  if (unknownCostInWindow > 0) {
    console.warn(
      `[asd] usd-budget: ${unknownCostInWindow} in-window receipt(s) had no usable cost and were excluded; spend may be understated.`,
    );
  }

  const remaining = Math.max(0, window.maxUsd - spent);
  return {
    allowed: spent < window.maxUsd,
    max_usd_per_window: maxUsdSpec,
    max_usd: window.maxUsd,
    spent_usd: roundUsd(spent),
    remaining_usd: roundUsd(remaining),
    state_path: telemetryPath,
    window_ms: window.windowMs,
    window_started_at: new Date(windowStart).toISOString(),
  };
}

function roundUsd(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

async function readTelemetryRecords(path: string): Promise<LlmTelemetryRecord[]> {
  try {
    const contents = await readFile(path, "utf8");
    return contents
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as LlmTelemetryRecord);
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }

    throw error;
  }
}

async function readBudgetState(path: string): Promise<BudgetState> {
  try {
    const contents = await readFile(path, "utf8");
    const parsed = JSON.parse(contents) as Partial<BudgetState>;
    if (!Array.isArray(parsed.uses)) {
      return { uses: [] };
    }

    return {
      uses: parsed.uses.filter((value): value is string => typeof value === "string"),
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return { uses: [] };
    }

    throw error;
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
