import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { getRuntimePath, getRuntimeRoot } from "../../config/paths.js";
import { domainSchema, type Instinct, type Maturity, maturitySchema } from "../instinct/schema.js";
import { loadAllInstincts } from "../instinct/store.js";
import { maturityStateFrom, proposedMaturity } from "../math/decay.js";

export const PROMOTION_QUEUE_FILENAME = "promote-queue.json";
export const PROMOTION_MIN_PROJECTS = 2;
export const PROMOTION_MIN_AVG_CONFIDENCE = 0.8;
export const PROMOTION_MIN_AGE_DAYS = 14;
const PROMOTION_ELIGIBLE_MATURITIES: readonly Maturity[] = ["established", "proven"];

export type PromotionProjectEvidence = {
  project_id: string;
  confidence: number;
  maturity: Maturity;
  created_at: string;
  updated_at: string;
};

type PromotionProjectSnapshot = PromotionProjectEvidence & {
  observations: Instinct["source"]["observations"];
};

export type PromotionQueueEntry = {
  instinct_id: string;
  trigger: string;
  finding: string;
  domain: Instinct["domain"];
  detected_at: string;
  avg_confidence: number;
  project_count: number;
  projects: PromotionProjectEvidence[];
  thresholds: {
    min_projects: number;
    min_avg_confidence: number;
    min_age_days: number;
  };
};

// Validates the persisted promote-queue.json at the read boundary. The shape
// mirrors PromotionQueueEntry; unknown keys are stripped (forward-compatible).
const promotionProjectEvidenceSchema = z.object({
  project_id: z.string(),
  confidence: z.number(),
  maturity: maturitySchema,
  created_at: z.string(),
  updated_at: z.string(),
});

const promotionQueueEntrySchema = z.object({
  instinct_id: z.string(),
  trigger: z.string(),
  finding: z.string(),
  domain: domainSchema,
  detected_at: z.string(),
  avg_confidence: z.number(),
  project_count: z.number(),
  projects: z.array(promotionProjectEvidenceSchema),
  thresholds: z.object({
    min_projects: z.number(),
    min_avg_confidence: z.number(),
    min_age_days: z.number(),
  }),
});

const promotionQueueFileSchema = z.object({
  entries: z.array(promotionQueueEntrySchema).default([]),
});

export function getPromotionQueuePath(): string {
  return join(getRuntimeRoot(), PROMOTION_QUEUE_FILENAME);
}

export async function refreshPromotionQueue(
  now = new Date().toISOString(),
): Promise<PromotionQueueEntry[]> {
  const entries = await detectPromotionCandidates(now);
  await writePromotionQueue(entries);
  return entries;
}

export async function detectPromotionCandidates(
  now = new Date().toISOString(),
): Promise<PromotionQueueEntry[]> {
  // TODO(perf): full scan — loads every instinct of every project on each run.
  // Fine at current scale; revisit with an incremental/indexed pass if the
  // instinct store grows large enough for this to dominate refresh latency.
  const buckets = new Map<
    string,
    {
      exemplar: Pick<Instinct, "trigger" | "finding" | "domain">;
      projects: PromotionProjectSnapshot[];
    }
  >();

  for (const projectId of await listProjectIds()) {
    const instincts = await loadAllInstincts(projectId);
    for (const instinct of instincts.values()) {
      if (instinct.scope !== "project") continue;
      if (instinct.maturity === "deprecated") continue;
      const evidence: PromotionProjectSnapshot = {
        project_id: projectId,
        confidence: instinct.confidence,
        maturity: instinct.maturity,
        created_at: instinct.created_at,
        updated_at: instinct.updated_at,
        observations: instinct.source.observations,
      };
      const bucket = buckets.get(instinct.id) ?? {
        exemplar: {
          trigger: instinct.trigger,
          finding: instinct.finding,
          domain: instinct.domain,
        },
        projects: [],
      };
      bucket.projects.push(evidence);
      buckets.set(instinct.id, bucket);
    }
  }

  return [...buckets.entries()]
    .map(([instinctId, bucket]) =>
      buildQueueEntry(instinctId, bucket.exemplar, dedupeProjects(bucket.projects), now),
    )
    .filter((entry): entry is PromotionQueueEntry => entry !== null)
    .sort(compareQueueEntries);
}

export async function readPromotionQueue(
  path = getPromotionQueuePath(),
): Promise<PromotionQueueEntry[]> {
  try {
    const contents = await readFile(path, "utf8");
    const parsed = promotionQueueFileSchema.safeParse(JSON.parse(contents));
    return parsed.success ? parsed.data.entries : [];
  } catch {
    return [];
  }
}

export async function writePromotionQueue(
  entries: readonly PromotionQueueEntry[],
  path = getPromotionQueuePath(),
): Promise<void> {
  await mkdir(getRuntimeRoot(), { recursive: true });
  await writeFile(path, `${JSON.stringify({ entries }, null, 2)}\n`, "utf8");
}

async function listProjectIds(): Promise<string[]> {
  try {
    const entries = await readdir(getRuntimePath("instinctsProjects"), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function buildQueueEntry(
  instinctId: string,
  exemplar: Pick<Instinct, "trigger" | "finding" | "domain">,
  projects: PromotionProjectSnapshot[],
  now: string,
): PromotionQueueEntry | null {
  if (projects.length < PROMOTION_MIN_PROJECTS) {
    return null;
  }

  const avgConfidence =
    projects.reduce((sum, project) => sum + project.confidence, 0) / projects.length;
  if (avgConfidence < PROMOTION_MIN_AVG_CONFIDENCE) {
    return null;
  }

  if (!projects.some((project) => isAgeEligible(project, now))) {
    return null;
  }

  return {
    instinct_id: instinctId,
    trigger: exemplar.trigger,
    finding: exemplar.finding,
    domain: exemplar.domain,
    detected_at: now,
    avg_confidence: Number(avgConfidence.toFixed(4)),
    project_count: projects.length,
    projects: projects
      .sort(compareProjects)
      .map(({ observations: _observations, ...project }) => project),
    thresholds: {
      min_projects: PROMOTION_MIN_PROJECTS,
      min_avg_confidence: PROMOTION_MIN_AVG_CONFIDENCE,
      min_age_days: PROMOTION_MIN_AGE_DAYS,
    },
  };
}

function dedupeProjects(projects: PromotionProjectSnapshot[]): PromotionProjectSnapshot[] {
  const map = new Map<string, PromotionProjectSnapshot>();
  for (const project of projects) {
    const existing = map.get(project.project_id);
    if (!existing || project.updated_at > existing.updated_at) {
      map.set(project.project_id, project);
    }
  }
  return [...map.values()];
}

// Age is measured from when the project FIRST reached *any* eligible maturity
// (established/proven), not from instinct creation — so a long-established
// instinct qualifies as soon as it has held an eligible maturity for
// PROMOTION_MIN_AGE_DAYS, regardless of when it was originally created.
function isAgeEligible(project: PromotionProjectSnapshot, now: string): boolean {
  const reachedEligibleMaturityAt = eligibleMaturityReachedAt(project);
  if (reachedEligibleMaturityAt === null) {
    return false;
  }

  const eligibleAt = Date.parse(reachedEligibleMaturityAt);
  const detectedAt = Date.parse(now);
  if (Number.isNaN(eligibleAt) || Number.isNaN(detectedAt)) {
    return false;
  }

  const ageDays = (detectedAt - eligibleAt) / (24 * 60 * 60 * 1000);
  return ageDays >= PROMOTION_MIN_AGE_DAYS;
}

function eligibleMaturityReachedAt(project: PromotionProjectSnapshot): string | null {
  if (!PROMOTION_ELIGIBLE_MATURITIES.includes(project.maturity)) {
    return null;
  }

  const observations = [...project.observations].sort((left, right) =>
    left.at.localeCompare(right.at),
  );
  if (observations.length === 0) {
    return null;
  }

  let current: Maturity = "candidate";
  const seen: Instinct["source"]["observations"] = [];
  for (const observation of observations) {
    seen.push(observation);
    current = proposedMaturity(current, maturityStateFrom(seen, observation.at));
    if (PROMOTION_ELIGIBLE_MATURITIES.includes(current)) {
      return observation.at;
    }
  }

  return null;
}

function compareProjects(left: PromotionProjectEvidence, right: PromotionProjectEvidence): number {
  if (right.confidence !== left.confidence) {
    return right.confidence - left.confidence;
  }
  return left.project_id.localeCompare(right.project_id);
}

function compareQueueEntries(left: PromotionQueueEntry, right: PromotionQueueEntry): number {
  if (right.avg_confidence !== left.avg_confidence) {
    return right.avg_confidence - left.avg_confidence;
  }
  if (right.project_count !== left.project_count) {
    return right.project_count - left.project_count;
  }
  return left.instinct_id.localeCompare(right.instinct_id);
}
