import type { CommandContext } from "../cli.js";
import {
  assessLlmBudget,
  assessUsdBudget,
  getDefaultMaxPerWindow,
  getDefaultMaxUsd,
  recordLlmBudgetUse,
} from "../pipeline/llm-budget.js";
import { openRouterApiKeyEnvVar } from "../pipeline/llm-learning-review.js";
import { loadGlobalInstinctIds, saveGlobalInstinct } from "../v2/instinct/global-store.js";
import { instinctSchema } from "../v2/instinct/schema.js";
import { loadInstinct } from "../v2/instinct/store.js";
import { judgeGlobalApplicability, resolveJudgeModel } from "../v2/promotion/judge.js";
import { detectGlobalJudgeCandidates, type GlobalJudgeCandidate } from "../v2/promotion/queue.js";

const DEFAULT_LIMIT = 20;
const DEFAULT_MIN_VERDICT_CONFIDENCE = 0.6;

type PromoteJudgeOptions = {
  limit: number;
  minVerdictConfidence: number;
  model: string | undefined;
  maxPer: string | undefined;
  maxUsd: string | undefined;
  dryRun: boolean;
};

type PromotedEntry = {
  instinct_id: string;
  domain: GlobalJudgeCandidate["domain"];
  confidence: number;
  source_project: string;
  verdict_confidence: number;
  reason: string;
};

/**
 * U10 — LLM-judged global promotion. Surfaces high-confidence single-project
 * instincts (the multi-project gate never fires) and asks an LLM whether each is
 * globally applicable; approved ones are written to the global instinct store as
 * `scope: global` and flow into `_global/MEMORY.md` via the U7 renderer. Bounded
 * by --limit and the shared LLM count/USD budgets; fails open without a key.
 */
export async function executePromoteJudge(context: CommandContext): Promise<number> {
  const options = parseOptions(context.args);
  const now = new Date().toISOString();

  const apiKey = process.env[openRouterApiKeyEnvVar];
  if (!options.dryRun && (apiKey === undefined || apiKey.trim().length === 0)) {
    context.output.info(
      JSON.stringify(
        { skipped: true, skip_reason: "missing_openrouter_key", promoted: [], judged: 0 },
        null,
        2,
      ),
    );
    return 0;
  }

  const alreadyGlobal = new Set(await loadGlobalInstinctIds());
  const allCandidates = await detectGlobalJudgeCandidates(alreadyGlobal);
  const candidates = allCandidates.slice(0, options.limit);

  if (candidates.length === 0) {
    context.output.info(
      JSON.stringify(
        { candidates_total: allCandidates.length, judged: 0, promoted: [], skipped: false },
        null,
        2,
      ),
    );
    return 0;
  }

  const maxPer = options.maxPer ?? getDefaultMaxPerWindow();
  const maxUsd = options.maxUsd ?? getDefaultMaxUsd();
  const model = resolveJudgeModel(options.model);

  const promoted: PromotedEntry[] = [];
  let judged = 0;
  let rejected = 0;
  let totalCost = 0;
  let stoppedReason: string | null = null;

  for (const candidate of candidates) {
    // Re-check both budgets before every paid call so a mid-run exhaustion stops
    // cleanly rather than overspending. Dry-run still judges (it costs calls) but
    // writes nothing.
    const budget = await assessLlmBudget(maxPer);
    const usdBudget = await assessUsdBudget(maxUsd);
    if (!budget.allowed || !usdBudget.allowed) {
      stoppedReason = budget.allowed ? "usd_budget_exhausted" : "count_budget_exhausted";
      break;
    }

    let result: Awaited<ReturnType<typeof judgeGlobalApplicability>>;
    try {
      result = await judgeGlobalApplicability({
        instinct: candidate,
        model,
        apiKey,
      });
    } catch (error) {
      stoppedReason = `judge_error: ${(error as Error).message}`;
      break;
    }
    await recordLlmBudgetUse(maxPer);
    judged += 1;
    totalCost += result.usage.cost ?? 0;

    const { verdict } = result;
    const approved = verdict.global && verdict.confidence >= options.minVerdictConfidence;
    if (!approved) {
      rejected += 1;
      continue;
    }

    if (!options.dryRun) {
      const source = await loadInstinct(candidate.project_id, candidate.instinct_id);
      if (source === null) {
        rejected += 1;
        continue;
      }
      const globalInstinct = instinctSchema.parse({
        ...source,
        scope: "global",
        project_id: "",
        last_promoted_at: now,
      });
      await saveGlobalInstinct(globalInstinct);
    }

    promoted.push({
      instinct_id: candidate.instinct_id,
      domain: candidate.domain,
      confidence: candidate.confidence,
      source_project: candidate.project_id,
      verdict_confidence: verdict.confidence,
      reason: verdict.reason,
    });
  }

  context.output.info(
    JSON.stringify(
      {
        model,
        dry_run: options.dryRun,
        candidates_total: allCandidates.length,
        candidates_considered: candidates.length,
        judged,
        promoted_count: promoted.length,
        rejected,
        total_cost_usd: Number(totalCost.toFixed(6)),
        stopped_reason: stoppedReason,
        promoted,
      },
      null,
      2,
    ),
  );
  return 0;
}

function parseOptions(args: readonly string[]): PromoteJudgeOptions {
  return {
    limit: parseIntFlag(args, "--limit") ?? DEFAULT_LIMIT,
    minVerdictConfidence:
      parseFloatFlag(args, "--min-verdict-confidence") ?? DEFAULT_MIN_VERDICT_CONFIDENCE,
    model: parseStringFlag(args, "--model"),
    maxPer: parseStringFlag(args, "--max-per"),
    maxUsd: parseStringFlag(args, "--max-usd"),
    dryRun: args.includes("--dry-run"),
  };
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function parseStringFlag(args: readonly string[], flag: string): string | undefined {
  return flagValue(args, flag);
}

function parseIntFlag(args: readonly string[], flag: string): number | undefined {
  const raw = flagValue(args, flag);
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${flag} value: ${raw}`);
  }
  return parsed;
}

function parseFloatFlag(args: readonly string[], flag: string): number | undefined {
  const raw = flagValue(args, flag);
  if (raw === undefined) return undefined;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`Invalid ${flag} value (expected 0..1): ${raw}`);
  }
  return parsed;
}
