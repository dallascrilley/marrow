import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseSkillEvidenceOptions } from "../dist/commands/skill-evidence.js";
import { findSkillEvidenceInSummary, resolveSkillPath } from "../dist/skill/resolve-skill.js";

test("findSkillEvidenceInSummary matches skill id in summary fields", () => {
  const fields = findSkillEvidenceInSummary("git", {
    session_id: "s1",
    topic: "Branch cleanup with git skill",
    what_worked: [],
    what_failed: [],
    what_was_decided: [],
    useful_commands: ["td start git-workflow"],
    files_of_interest: [],
    next_step: "Continue",
    project_learnings: [],
    user_learnings: [],
  });

  assert.deepEqual(fields.sort(), ["topic", "useful_commands"].sort());
});

test("resolveSkillPath checks extraRoots before home layout", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "asd-skill-root-"));
  const skillsRoot = join(sandbox, "skills");
  await mkdir(join(skillsRoot, "demo-skill"), { recursive: true });
  await writeFile(join(skillsRoot, "demo-skill", "SKILL.md"), "# demo-skill\n", "utf8");

  try {
    const path = await resolveSkillPath("demo-skill", { extraRoots: [skillsRoot] });
    assert.equal(path, join(skillsRoot, "demo-skill", "SKILL.md"));
  } finally {
    await rm(sandbox, { force: true, recursive: true });
  }
});

test("parseSkillEvidenceOptions parses skill id and flags", () => {
  assert.deepEqual(parseSkillEvidenceOptions(["demo-skill", "--json", "--limit", "5"]), {
    skillId: "demo-skill",
    json: true,
    limit: 5,
    skillRoots: [],
  });
});
