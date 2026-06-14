import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { DatabaseSync } from "node:sqlite";

import type { CommandContext } from "../cli.js";
import { getRuntimePath } from "../config/paths.js";
import { summarySchema } from "../models/canonical.js";
import {
  findSkillEvidenceInSummary,
  readSkillMetadata,
  resolveSkillPath,
  type SkillEvidenceMatch,
} from "../skill/resolve-skill.js";
import {
  buildSessionIndex,
  type SessionIndexRecord,
  sessionIndexRecordSchema,
} from "./export-index.js";

export async function executeSkillEvidence(
  context: CommandContext,
  _database: DatabaseSync,
): Promise<number> {
  const options = parseSkillEvidenceOptions(context.args);
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

export function parseSkillEvidenceOptions(args: string[]): {
  skillId: string;
  json: boolean;
  limit: number;
  skillRoots: string[];
} {
  let json = false;
  let limit = 20;
  const skillRoots: string[] = [];
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--skill-root") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--skill-root requires a directory path");
      }
      skillRoots.push(value);
      index += 1;
      continue;
    }

    if (arg === "--limit") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--limit requires a value");
      }
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed < 1) {
        throw new Error("--limit must be a positive integer");
      }
      limit = parsed;
      index += 1;
      continue;
    }

    if (arg.startsWith("--")) {
      throw new Error(`Unknown flag: ${arg}`);
    }

    positional.push(arg);
  }

  if (positional.length !== 1) {
    throw new Error("skill evidence requires exactly one skill id argument");
  }

  return {
    skillId: positional[0]!,
    json,
    limit,
    skillRoots,
  };
}

async function loadSessionIndexRecords(): Promise<SessionIndexRecord[]> {
  const indexPath = join(getRuntimePath("index"), "session-index.jsonl");

  try {
    await access(indexPath);
    const contents = await readFile(indexPath, "utf8");
    const records: SessionIndexRecord[] = [];
    for (const line of contents.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      records.push(sessionIndexRecordSchema.parse(JSON.parse(trimmed)));
    }
    return records;
  } catch {
    return buildSessionIndex();
  }
}
