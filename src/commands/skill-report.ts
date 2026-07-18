import { readFile } from "node:fs/promises";

import type { DatabaseSync } from "node:sqlite";

import type { CommandContext } from "../cli.js";
import { summarySchema, turnSchema } from "../models/canonical.js";
import { getReducedArtifactPath } from "../pipeline/reduce.js";
import { loadSessionIndexRecords } from "../read/session-index.js";
import { preflightStagingReadRoot } from "../storage/staging.js";
import {
  buildSkillSuggestions,
  parseSkillChecklist,
  reducedSessionText,
  type SessionAdherenceScore,
  scoreSessionAdherence,
} from "../skill/adherence.js";
import { parseSkillCommandOptions } from "../skill/parse-skill-options.js";
import { readSkillMetadata, resolveSkillPath } from "../skill/resolve-skill.js";

export async function executeSkillReport(
  context: CommandContext,
  database: DatabaseSync,
): Promise<number> {
  const options = parseSkillCommandOptions(context.args, "report");
  const skillPath = await resolveSkillPath(options.skillId, {
    extraRoots: options.skillRoots,
  });

  if (!skillPath) {
    context.output.error(
      `Skill "${options.skillId}" not found. Checked ~/.claude/skills, ~/.cursor/skills, and ~/.hub/artifacts/skills.`,
    );
    return 1;
  }

  const skillContents = await readFile(skillPath, "utf8");
  const skill = await readSkillMetadata(skillPath);
  const checklist = parseSkillChecklist(skillContents);
  await preflightStagingReadRoot();
  const records = await loadSessionIndexRecords({ database, fallbackToBuild: true });
  const sessions: SessionAdherenceScore[] = [];

  for (const record of records) {
    const summary = summarySchema.parse(
      JSON.parse(await readFile(record.summary_json_path, "utf8")),
    );
    const reducedText = await loadReducedSessionText(record.asd_session_id);
    const scored = scoreSessionAdherence({
      asdSessionId: record.asd_session_id,
      checklist,
      reducedText,
      skillId: options.skillId,
      summary,
      topic: record.topic,
    });

    if (scored) {
      sessions.push(scored);
    }
  }

  sessions.sort(
    (left, right) =>
      right.score - left.score || left.asd_session_id.localeCompare(right.asd_session_id),
  );

  const limitedSessions = sessions.slice(0, options.limit);
  const adherenceScore =
    sessions.length === 0
      ? 0
      : Number(
          (sessions.reduce((total, session) => total + session.score, 0) / sessions.length).toFixed(
            3,
          ),
        );
  const suggestions = buildSkillSuggestions({ checklist, sessions });

  const payload = {
    adherence_score: adherenceScore,
    checklist_item_count: checklist.length,
    relevant_sessions: sessions.length,
    sessions: limitedSessions,
    sessions_scanned: records.length,
    skill_description: skill.description,
    skill_id: options.skillId,
    skill_path: skill.path,
    suggestions,
  };

  if (options.json) {
    context.output.info(JSON.stringify(payload, null, 2));
    return 0;
  }

  context.output.info(`Skill: ${options.skillId}`);
  context.output.info(`Path: ${skill.path}`);
  context.output.info(`Checklist items: ${checklist.length}`);
  context.output.info(
    `Adherence: ${adherenceScore} across ${sessions.length} relevant session${sessions.length === 1 ? "" : "s"} (${records.length} scanned)`,
  );

  if (limitedSessions.length > 0) {
    context.output.info("Top sessions:");
    for (const session of limitedSessions) {
      context.output.info(
        `${session.asd_session_id}\tscore=${session.score}\tchecklist=${session.checklist_hits.length}/${session.checklist_total}\t${session.topic}`,
      );
    }
  }

  context.output.info("Suggestions:");
  for (const suggestion of suggestions) {
    context.output.info(`- ${suggestion}`);
  }

  return 0;
}

async function loadReducedSessionText(asdSessionId: string): Promise<string> {
  try {
    const parsed = JSON.parse(await readFile(getReducedArtifactPath(asdSessionId), "utf8")) as {
      turns?: unknown[];
    };
    return reducedSessionText((parsed.turns ?? []).map((turn) => turnSchema.parse(turn)));
  } catch {
    return "";
  }
}
