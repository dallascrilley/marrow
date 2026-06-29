import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { CommandContext } from "../cli.js";
import { vaultProjectPath } from "../config/vault-paths.js";
import { appendRecallEvent } from "../v2/metrics/recall-events.js";
import { resolveProjectId } from "../v2/project/resolve.js";
import { GLOBAL_ROLLUP_ID } from "../v2/vault/render-memory.js";

const DEFAULT_MAX_BYTES = 4000;

// Curated MEMORY.md plus the ADR-0004 topic overflow files, in the order they
// should appear in injected session context. MEMORY.md leads; topics follow.
const TOPIC_FILES = [
  "workflow.md",
  "tooling.md",
  "pitfalls.md",
  "debugging.md",
  "preferences.md",
] as const;

type RecallOptions = {
  cwd: string;
  vaultRoot: string;
  maxBytes: number;
};

/**
 * Read-back command (ADR-0010): resolve the current project's id, read its
 * curated vault memory, and print a compact block to stdout for a SessionStart
 * hook to inject. Fails open — a missing vault or file prints nothing and
 * exits 0 so it never blocks session start.
 */
export async function executeRecall(context: CommandContext): Promise<number> {
  const options = parseRecallOptions(context.args);

  let projectId: string;
  try {
    const resolved = await resolveProjectId({ workspacePath: options.cwd });
    projectId = resolved.id;
  } catch {
    return 0;
  }

  const sections: string[] = [];

  // Cross-project global rollup leads — these instincts apply in every session.
  // It carries its own `# Global memory (curated)` header, so push its stripped
  // body verbatim. Only surface it when it holds at least one instinct bullet.
  const globalMemory = await readVaultFile(options.vaultRoot, GLOBAL_ROLLUP_ID, "MEMORY.md");
  if (globalMemory) {
    const globalBody = stripFrontmatter(globalMemory).trim();
    if (hasInstinctBullet(globalBody)) {
      sections.push(globalBody);
    }
  }

  const memory = await readVaultFile(options.vaultRoot, projectId, "MEMORY.md");
  if (memory) {
    sections.push(stripFrontmatter(memory).trim());
  }

  for (const topic of TOPIC_FILES) {
    const content = await readVaultFile(options.vaultRoot, projectId, topic);
    if (content) {
      const heading = topic.replace(/\.md$/, "");
      sections.push(`## ${heading}\n${stripFrontmatter(content).trim()}`);
    }
  }

  // A rendered MEMORY.md always carries the heading + boilerplate, even for a
  // project with zero reachable instincts. Topic files only ever hold spillover
  // *beyond* the MEMORY.md line cap, so the absence of any instinct bullet means
  // there is genuinely nothing curated to surface. Treat that as fail-open
  // rather than injecting (and logging as "delivered") a content-free header.
  const assembled = sections.join("\n\n");
  if (sections.length === 0 || !hasInstinctBullet(assembled)) {
    await appendRecallEvent({
      ts: new Date().toISOString(),
      project_id: projectId,
      delivered: false,
      bytes: 0,
      sections: 0,
    });
    return 0;
  }

  const block = capToBytes(assembled, options.maxBytes);
  context.output.info(block);
  await appendRecallEvent({
    ts: new Date().toISOString(),
    project_id: projectId,
    delivered: true,
    bytes: Buffer.byteLength(block, "utf8"),
    sections: sections.length,
  });
  return 0;
}

export function parseRecallOptions(args: readonly string[]): RecallOptions {
  let cwd = process.cwd();
  let vaultRoot = process.env.ASD_VAULT_ROOT?.trim() || join(homedir(), "vault");
  let maxBytes = DEFAULT_MAX_BYTES;

  for (let i = 0; i < args.length; i += 1) {
    const current = args[i];
    if (current === undefined) {
      continue;
    }
    const [flag, inlineValue] = splitFlag(current);
    const readValue = (): string => {
      if (inlineValue !== undefined) {
        return inlineValue;
      }
      const next = args[i + 1];
      if (next === undefined) {
        throw new Error(`Missing value for ${flag}`);
      }
      i += 1;
      return next;
    };

    switch (flag) {
      case "--cwd":
        cwd = readValue();
        break;
      case "--vault-root":
        vaultRoot = readValue();
        break;
      case "--max-bytes": {
        const raw = readValue();
        const parsed = Number.parseInt(raw, 10);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new Error(`Invalid --max-bytes value: ${raw}`);
        }
        maxBytes = parsed;
        break;
      }
      default:
        throw new Error(`Unknown option for recall: ${flag}`);
    }
  }

  return { cwd, vaultRoot, maxBytes };
}

function splitFlag(arg: string): [string, string | undefined] {
  const eq = arg.indexOf("=");
  if (arg.startsWith("--") && eq !== -1) {
    return [arg.slice(0, eq), arg.slice(eq + 1)];
  }
  return [arg, undefined];
}

async function readVaultFile(
  vaultRoot: string,
  projectId: string,
  relativePath: string,
): Promise<string | null> {
  let path: string;
  try {
    path = vaultProjectPath(vaultRoot, projectId, relativePath);
  } catch {
    return null;
  }

  try {
    await access(path);
  } catch {
    return null;
  }

  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * True when the text contains at least one rendered instinct bullet (a line
 * beginning with `- `). The curated MEMORY.md heading and boilerplate never
 * start with `- `, so this distinguishes real content from an empty rollup.
 */
export function hasInstinctBullet(text: string): boolean {
  return /^- /mu.test(text);
}

/** Strip a leading YAML frontmatter block (`---` … `---`) if present. */
export function stripFrontmatter(content: string): string {
  if (!content.startsWith("---")) {
    return content;
  }
  const end = content.indexOf("\n---", 3);
  if (end === -1) {
    return content;
  }
  const afterClose = content.indexOf("\n", end + 1);
  return afterClose === -1 ? "" : content.slice(afterClose + 1);
}

/** Truncate to a byte budget at a line boundary, marking the cut. */
export function capToBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return text;
  }
  const marker = "\n…(truncated)";
  const budget = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8"));
  const lines = text.split("\n");
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const lineBytes = Buffer.byteLength(`${line}\n`, "utf8");
    if (used + lineBytes > budget) {
      break;
    }
    kept.push(line);
    used += lineBytes;
  }
  return `${kept.join("\n")}${marker}`;
}
