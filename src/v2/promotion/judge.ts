import { z } from "zod";

import {
  type ChatMessage,
  completeOpenRouterJson,
  defaultOpenRouterLearningReviewModel,
  type LlmCallUsage,
  openRouterModelEnvVar,
} from "../../pipeline/llm-learning-review.js";
import type { Instinct } from "../instinct/schema.js";

/**
 * LLM-judged global-applicability verdict. Replaces the unsatisfiable
 * "same instinct id observed in >= 2 projects" heuristic (the U5 spike found
 * ~0 cross-project id overlap) with a direct assessment of whether a single
 * high-signal instinct generalises across unrelated software projects.
 */
export const globalJudgeVerdictSchema = z.object({
  global: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1).max(400),
});

export type GlobalJudgeVerdict = z.infer<typeof globalJudgeVerdictSchema>;

export type GlobalJudgeResult = {
  verdict: GlobalJudgeVerdict;
  usage: LlmCallUsage;
};

export function resolveJudgeModel(model?: string): string {
  const fromInput = model?.trim();
  if (fromInput) return fromInput;
  const fromEnv = process.env[openRouterModelEnvVar]?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : defaultOpenRouterLearningReviewModel;
}

function buildSystemPrompt(): string {
  return [
    "You judge whether a single software-engineering instinct should be promoted",
    "to GLOBAL scope — meaning it is a general best-practice that applies across",
    "unrelated codebases, languages, and teams.",
    "",
    "Return global=true ONLY when the instinct is broadly transferable advice",
    "(workflow discipline, tooling habits, testing/debugging/security practices,",
    "code-style principles) that a competent engineer would apply on most",
    "projects. Return global=false when it is specific to one codebase: names of",
    "files, modules, services, env vars, schemas, ports, vendors, or project-",
    "local conventions that would not transfer.",
    "",
    "Be conservative: when in doubt, return global=false. `confidence` is your",
    "certainty in the verdict (0..1). `reason` is one short sentence.",
    "",
    'Respond with ONLY a JSON object: {"global": boolean, "confidence": number, "reason": string}.',
  ].join("\n");
}

function buildUserPrompt(instinct: Pick<Instinct, "trigger" | "finding" | "domain">): string {
  return JSON.stringify(
    { domain: instinct.domain, trigger: instinct.trigger, finding: instinct.finding },
    null,
    2,
  );
}

/** Extract the first JSON object from a model response (tolerates code fences/prose). */
export function parseGlobalJudgeVerdict(content: string): GlobalJudgeVerdict {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`global judge: no JSON object in response: ${content.slice(0, 120)}`);
  }
  const parsed = JSON.parse(content.slice(start, end + 1));
  return globalJudgeVerdictSchema.parse(parsed);
}

export async function judgeGlobalApplicability(input: {
  instinct: Pick<Instinct, "trigger" | "finding" | "domain">;
  model?: string | undefined;
  apiKey?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
}): Promise<GlobalJudgeResult> {
  const model = resolveJudgeModel(input.model);
  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt() },
    { role: "user", content: buildUserPrompt(input.instinct) },
  ];
  const { content, usage } = await completeOpenRouterJson({
    apiKey: input.apiKey,
    errorLabel: "global promotion judge",
    fetchImpl: input.fetchImpl,
    messages,
    model,
  });
  return { verdict: parseGlobalJudgeVerdict(content), usage };
}
