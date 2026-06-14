import { readFile } from "node:fs/promises";

import type { DatabaseSync } from "node:sqlite";

import type { CommandContext } from "../cli.js";
import { summarySchema } from "../models/canonical.js";
import { parseSkillCommandOptions } from "../skill/parse-skill-options.js";
import {
  findSkillEvidenceInSummary,
  readSkillMetadata,
  resolveSkillPath,
  type SkillEvidenceMatch,
} from "../skill/resolve-skill.js";
import { loadSessionIndexRecords } from "../skill/session-index.js";

export async function executeSkillEvidence(
  context: CommandContext,
  _database: DatabaseSync,
): Promise<number> {
  const options = parseSkillCommandOptions(context.args, "evidence");
  const skillPath = await resolveSkillPath(options.skillId, {
    extraRoots: options.skillRoots,
  });

  if (!skillPath) {
    context.output.error(
      `Skill "${options.skillId}" not found. Checked ~/.claude/skills, ~/.cursor/skills, and ~/.hub/artifacts/skills.`,
    );
    return 1;
  }

  const skill = await readSkillMetadata(skillPath);
  const records = await loadSessionIndexRecords();
  const matches: SkillEvidenceMatch[] = [];

  for (const record of records) {
    const summary = summarySchema.parse(
      JSON.parse(await readFile(record.summary_json_path, "utf8")),
    );
    const fields = findSkillEvidenceInSummary(options.skillId, summary);
    if (fields.length === 0) {
      continue;
    }

    matches.push({
      asd_session_id: record.asd_session_id,
      fields,
      source_tool: record.source_tool,
      topic: record.topic,
    });

    if (matches.length >= options.limit) {
      break;
    }
  }

  const payload = {
    matches,
    sessions_scanned: records.length,
    sessions_with_evidence: matches.length,
    skill_description: skill.description,
    skill_id: options.skillId,
    skill_path: skill.path,
  };

  if (options.json) {
    context.output.info(JSON.stringify(payload, null, 2));
    return 0;
  }

  context.output.info(`Skill: ${options.skillId}`);
  context.output.info(`Path: ${skill.path}`);
  if (skill.description.length > 0) {
    context.output.info(`Summary: ${skill.description}`);
  }
  context.output.info(
    `Evidence: ${matches.length} of ${records.length} indexed session${records.length === 1 ? "" : "s"}`,
  );

  if (matches.length === 0) {
    context.output.info("No summary fields mention this skill id. Try export-index after ingest.");
    return 0;
  }

  for (const match of matches) {
    context.output.info(
      `${match.asd_session_id}\t${match.source_tool}\t${match.fields.join(",")}\t${match.topic}`,
    );
  }

  return 0;
}

export { parseSkillCommandOptions as parseSkillEvidenceOptions };
