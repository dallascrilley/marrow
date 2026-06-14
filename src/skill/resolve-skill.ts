import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export async function resolveSkillPath(
  skillId: string,
  options: { homeDir?: string; extraRoots?: string[] } = {},
): Promise<string | null> {
  const home = options.homeDir ?? homedir();
  const candidates = [
    ...(options.extraRoots ?? []).map((root) => join(root, skillId, "SKILL.md")),
    join(home, ".claude", "skills", skillId, "SKILL.md"),
    join(home, ".cursor", "skills", skillId, "SKILL.md"),
    join(home, ".hub", "artifacts", "skills", skillId, "source", "adapted", "SKILL.md"),
    join(home, ".hub", "artifacts", "skills", skillId, "source", "original", "SKILL.md"),
  ];

  for (const path of candidates) {
    try {
      await access(path);
      return path;
    } catch {}
  }

  return null;
}

export function extractSkillDescription(contents: string): string {
  const withoutFrontmatter = contents.replace(/^---[\s\S]*?---\s*/u, "");
  const firstParagraph = withoutFrontmatter
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .slice(0, 3)
    .join(" ");
  return firstParagraph.slice(0, 280);
}

export type SkillEvidenceMatch = {
  asd_session_id: string;
  fields: string[];
  source_tool: string;
  topic: string;
};

export type SummaryEvidenceInput = {
  session_id: string;
  topic: string;
  what_worked: string[];
  what_failed: string[];
  what_was_decided: string[];
  useful_commands: string[];
  files_of_interest: string[];
  next_step: string;
  project_learnings: string[];
  user_learnings: string[];
};

export function findSkillEvidenceInSummary(
  skillId: string,
  summary: SummaryEvidenceInput,
): string[] {
  const needle = skillId.toLowerCase();
  const fields: Array<[string, string | string[]]> = [
    ["topic", summary.topic],
    ["next_step", summary.next_step],
    ["what_worked", summary.what_worked],
    ["what_failed", summary.what_failed],
    ["what_was_decided", summary.what_was_decided],
    ["useful_commands", summary.useful_commands],
    ["files_of_interest", summary.files_of_interest],
    ["project_learnings", summary.project_learnings],
    ["user_learnings", summary.user_learnings],
  ];

  const matched: string[] = [];
  for (const [name, value] of fields) {
    const haystack = Array.isArray(value) ? value.join("\n") : value;
    if (haystack.toLowerCase().includes(needle)) {
      matched.push(name);
    }
  }

  return matched;
}

export async function readSkillMetadata(skillPath: string): Promise<{
  description: string;
  path: string;
}> {
  const contents = await readFile(skillPath, "utf8");
  return {
    description: extractSkillDescription(contents),
    path: skillPath,
  };
}
