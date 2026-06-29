import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { getRuntimePath } from "../../config/paths.js";
import { vaultProjectDir, vaultProjectPath } from "../../config/vault-paths.js";
import { replayBundles } from "../instinct/bundle.js";
import type { Domain, Instinct } from "../instinct/schema.js";
import { parseInstinctYaml } from "../instinct/yaml-io.js";

export const MEMORY_LINE_CAP = 200;

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

  const lines: string[] = [
    ...frontmatter,
    "",
    "# Project memory (curated)",
    "",
    "Regenerated from atomic instincts. Session-level audit pages live under `asd-learnings/`.",
    "",
  ];

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
  const projectInstincts = [...(await replayBundles(input.projectId)).values()];
  const globalInstincts = await loadGlobalInstincts();
  const selected = selectInstinctsForRollup(projectInstincts, globalInstincts);
  const rendered = renderMemoryMarkdown(selected, input.generatedAt);

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
