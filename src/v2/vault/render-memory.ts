import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { getRuntimePath } from "../../config/paths.js";
import { vaultProjectDir, vaultProjectPath } from "../../config/vault-paths.js";
import { replayBundles } from "../instinct/bundle.js";
import type { Domain, Instinct } from "../instinct/schema.js";
import { parseInstinctYaml } from "../instinct/yaml-io.js";

export const MEMORY_LINE_CAP = 200;

/**
 * Reserved project-id for the cross-project global rollup (ADR-0010 / U7).
 * `sanitiseProjectId` preserves the leading underscore, so this resolves to the
 * carve-out path `wiki/projects/_global/MEMORY.md` without a new top-level vault
 * path. Global-scope instincts render here once instead of being duplicated into
 * all 259 per-project silos.
 */
export const GLOBAL_ROLLUP_ID = "_global";

type RollupHeading = { title: string; intro: string };

const PROJECT_HEADING: RollupHeading = {
  title: "Project memory (curated)",
  intro:
    "Regenerated from atomic instincts. Session-level audit pages live under `asd-learnings/`.",
};

const GLOBAL_HEADING: RollupHeading = {
  title: "Global memory (curated)",
  intro:
    "Cross-project instincts promoted to global scope. Surfaced in every session via `asd recall`.",
};

/** Sentinel the `updated_at` reduce seeds with; never emit it as a real time. */
const EPOCH_SEED = "1970-01-01T00:00:00.000Z";

const DOMAIN_TOPIC_FILES: Partial<Record<Domain, string>> = {
  workflow: "workflow.md",
  tooling: "tooling.md",
  "code-style": "preferences.md",
  product: "preferences.md",
  testing: "pitfalls.md",
  git: "pitfalls.md",
  security: "pitfalls.md",
  performance: "pitfalls.md",
  debugging: "debugging.md",
};

export type RenderMemoryResult = {
  memoryPath: string;
  topicFiles: Record<string, string>;
  includedCount: number;
  spilledCount: number;
};

export function selectInstinctsForRollup(
  projectInstincts: readonly Instinct[],
  globalInstincts: readonly Instinct[],
): Instinct[] {
  const selected = new Map<string, Instinct>();

  for (const instinct of [...projectInstincts, ...globalInstincts]) {
    if (!shouldIncludeInRollup(instinct)) continue;
    selected.set(instinct.id, instinct);
  }

  return [...selected.values()].sort(compareInstincts);
}

export function shouldIncludeInRollup(instinct: Instinct): boolean {
  if (instinct.maturity === "deprecated") return false;
  if (instinct.maturity === "proven") return true;
  if (instinct.maturity === "established" && instinct.confidence >= 0.7) {
    return true;
  }
  if (instinct.maturity === "candidate" && instinct.confidence >= 0.6) {
    return true;
  }
  return false;
}

export function compareInstincts(left: Instinct, right: Instinct): number {
  const domainOrder = left.domain.localeCompare(right.domain);
  if (domainOrder !== 0) return domainOrder;
  const confidenceOrder = right.confidence - left.confidence;
  if (confidenceOrder !== 0) return confidenceOrder;
  return left.id.localeCompare(right.id);
}

export function renderMemoryMarkdown(
  instincts: readonly Instinct[],
  generatedAt?: string,
  heading: RollupHeading = PROJECT_HEADING,
): {
  memory: string;
  topics: Record<string, string>;
  includedCount: number;
  spilledCount: number;
} {
  const generated =
    generatedAt ??
    instincts.reduce(
      (latest, instinct) => (instinct.updated_at > latest ? instinct.updated_at : latest),
      EPOCH_SEED,
    );

  // Never stamp the epoch seed: an empty selection (or one with no real
  // `updated_at`) and no explicit clock omits `generated_at` rather than
  // emitting 1970-01-01, which would silently corrupt recency-decay math.
  const frontmatter = ["---", "tags: [asd, memory, curated]"];
  if (generated !== EPOCH_SEED) {
    frontmatter.push(`generated_at: ${generated}`);
  }
  frontmatter.push("---");

  const lines: string[] = [...frontmatter, "", `# ${heading.title}`, "", heading.intro, ""];

  const topicBuckets = new Map<string, string[]>();
  let includedCount = 0;

  for (const instinct of instincts) {
    const bullet = formatInstinctBullet(instinct);
    if (lines.length < MEMORY_LINE_CAP) {
      lines.push(bullet);
      includedCount += 1;
    } else {
      const topicFile = DOMAIN_TOPIC_FILES[instinct.domain] ?? "pitfalls.md";
      const bucket = topicBuckets.get(topicFile) ?? [];
      bucket.push(bullet);
      topicBuckets.set(topicFile, bucket);
    }
  }

  const topics: Record<string, string> = {};
  for (const [filename, bullets] of topicBuckets) {
    if (bullets.length === 0) continue;
    topics[filename] = [
      `# ${filename.replace(/\.md$/u, "")}`,
      "",
      "Spillover from curated MEMORY.md (instincts beyond the line cap).",
      "",
      ...bullets,
      "",
    ].join("\n");
  }

  const spilledCount = instincts.length - includedCount;
  return {
    memory: `${lines.join("\n")}\n`,
    topics,
    includedCount,
    spilledCount,
  };
}

export async function loadGlobalInstincts(): Promise<Instinct[]> {
  const globalDir = getRuntimePath("instinctsGlobal");
  try {
    const entries = await readdir(globalDir);
    const instincts: Instinct[] = [];
    for (const name of entries) {
      if (!name.endsWith(".yaml")) continue;
      const contents = await readFile(join(globalDir, name), "utf8");
      instincts.push(parseInstinctYaml(contents));
    }
    return instincts;
  } catch {
    return [];
  }
}

export async function renderProjectMemoryToVault(input: {
  projectId: string;
  vaultRoot: string;
  /** Render clock (real time). Threaded from the caller's run timestamp. */
  generatedAt?: string;
}): Promise<RenderMemoryResult> {
  // Project files carry project-scope instincts only. Global-scope instincts
  // render once to the `_global` rollup (renderGlobalMemoryToVault) and reach
  // every session through `asd recall`, rather than being duplicated into each
  // per-project MEMORY.md (R4: roll up globally, not 259 silos).
  const projectInstincts = [...(await replayBundles(input.projectId)).values()];
  const selected = selectInstinctsForRollup(projectInstincts, []);
  return writeRollup({
    instincts: selected,
    projectId: input.projectId,
    vaultRoot: input.vaultRoot,
    generatedAt: input.generatedAt,
    heading: PROJECT_HEADING,
  });
}

/**
 * Render the cross-project global rollup (`scope: global` instincts) to
 * `wiki/projects/_global/MEMORY.md`. Called once per pipeline run, independent
 * of any single project. Honors the same inclusion/sort/spill rules as project
 * rollups; the read-back path (`asd recall`) prepends it to every session.
 */
export async function renderGlobalMemoryToVault(input: {
  vaultRoot: string;
  /** Render clock (real time). Threaded from the caller's run timestamp. */
  generatedAt?: string;
}): Promise<RenderMemoryResult> {
  const globalInstincts = await loadGlobalInstincts();
  const selected = selectInstinctsForRollup([], globalInstincts);
  return writeRollup({
    instincts: selected,
    projectId: GLOBAL_ROLLUP_ID,
    vaultRoot: input.vaultRoot,
    generatedAt: input.generatedAt,
    heading: GLOBAL_HEADING,
  });
}

async function writeRollup(input: {
  instincts: readonly Instinct[];
  projectId: string;
  vaultRoot: string;
  generatedAt: string | undefined;
  heading: RollupHeading;
}): Promise<RenderMemoryResult> {
  const rendered = renderMemoryMarkdown(input.instincts, input.generatedAt, input.heading);

  const projectDir = vaultProjectDir(input.vaultRoot, input.projectId);
  await mkdir(projectDir, { recursive: true });

  const memoryPath = vaultProjectPath(input.vaultRoot, input.projectId, "MEMORY.md");
  await writeFile(memoryPath, rendered.memory, "utf8");

  const topicFiles: Record<string, string> = {};
  for (const [filename, content] of Object.entries(rendered.topics)) {
    const topicPath = vaultProjectPath(input.vaultRoot, input.projectId, filename);
    await writeFile(topicPath, content, "utf8");
    topicFiles[filename] = topicPath;
  }

  return {
    memoryPath,
    topicFiles,
    includedCount: rendered.includedCount,
    spilledCount: rendered.spilledCount,
  };
}

function formatInstinctBullet(instinct: Instinct): string {
  const summary = instinct.finding.replace(/\s+/gu, " ").trim();
  return `- **${instinct.domain}** (${instinct.maturity}, ${instinct.confidence.toFixed(2)}): ${summary} \`${instinct.id}\``;
}
