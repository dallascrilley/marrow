import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getRuntimePath } from "../config/paths.js";

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
