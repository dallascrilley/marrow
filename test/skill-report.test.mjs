import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildSkillSuggestions,
  parseSkillChecklist,
  reducedSessionText,
  scoreSessionAdherence,
  sessionInvokesSkill,
} from "../dist/skill/adherence.js";
import { parseSkillCommandOptions } from "../dist/skill/parse-skill-options.js";
import { findSkillEvidenceInSummary, resolveSkillPath } from "../dist/skill/resolve-skill.js";

const fixtureSkill = `# demo-skill

- Run verification command before claiming done
- Capture proof in the response message
- Do not commit unless the user explicitly asks
`;

test("parseSkillChecklist extracts actionable bullets", () => {
  const items = parseSkillChecklist(fixtureSkill);
  assert.equal(items.length, 3);
  assert.equal(items[0]?.line, "Run verification command before claiming done");
});

test("scoreSessionAdherence weights invocation, checklist, and failures", () => {
  const checklist = parseSkillChecklist(fixtureSkill);
  const summary = {
    session_id: "s1",
    topic: "demo-skill verification pass",
    what_worked: [],
    what_failed: [],
    what_was_decided: [],
    useful_commands: [],
    files_of_interest: [],
    next_step: "Continue",
    project_learnings: [],
    user_learnings: [],
  };
  const reducedText = reducedSessionText([
    {
      assistant_summary:
        "Ran verification command before claiming done. Captured proof in the response message.",
      commands_seen: ["npm test"],
      ended_at: "2026-06-13T00:00:01.000Z",
      files_touched: [],
      index: 0,
      session_id: "s1",
      started_at: "2026-06-13T00:00:00.000Z",
      tool_stub_count: 0,
      turn_id: "s1:turn-0000",
      user_prompt: "Use demo-skill before marking done.",
      verification_seen: true,
    },
  ]);

  const scored = scoreSessionAdherence({
    asdSessionId: "s1",
    checklist,
    reducedText,
    skillId: "demo-skill",
    summary,
    topic: summary.topic,
  });

  assert.ok(scored);
  assert.equal(scored.invoked_in_transcript, true);
  assert.ok(scored.checklist_hits.length >= 2);
  assert.ok(scored.score >= 0.8);
});

test("buildSkillSuggestions flags never-observed checklist steps", () => {
  const checklist = parseSkillChecklist(fixtureSkill);
  const suggestions = buildSkillSuggestions({
    checklist,
    sessions: [
      {
        asd_session_id: "s1",
        checklist_hits: ["Run verification command before claiming done"],
        checklist_total: 3,
        evidence_fields: ["topic"],
        failures: [],
        invoked_in_transcript: true,
        score: 0.7,
        topic: "demo-skill",
      },
    ],
  });

  assert.ok(suggestions.some((entry) => entry.includes("Never observed")));
});

test("sessionInvokesSkill matches hyphen and space variants", () => {
  assert.equal(sessionInvokesSkill("generic debugging session", "verify-before-complete"), false);
  assert.equal(
    sessionInvokesSkill("follow verify-before-complete before shipping", "verify-before-complete"),
    true,
  );
  assert.equal(
    sessionInvokesSkill("follow verify before complete before shipping", "verify-before-complete"),
    true,
  );
});

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

test("parseSkillCommandOptions parses skill id and flags", () => {
  assert.deepEqual(parseSkillCommandOptions(["demo-skill", "--json", "--limit", "5"], "report"), {
    skillId: "demo-skill",
    json: true,
    limit: 5,
    skillRoots: [],
  });
});
