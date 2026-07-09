import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { executeQualityApplyLearningReview } from "../dist/commands/quality-apply-learning-review.js";
import { createLedger, upsertSourceSession } from "../dist/db/ledger.js";
import { learningFixture, sourceSessionFixture } from "../dist/models/canonical.js";
import { hashToProjectId } from "../dist/v2/project/resolve.js";
import { getProjectKnowledgeSessionPath } from "../dist/writers/knowledge-writer.js";

const runtimeOverrideEnvVar = "AGENT_SESSION_DISTILLERY_ROOT";

test("apply-learning-review persists reconstructed triggers", async () => {
  const sandboxBase = await mkdtemp(join(tmpdir(), "asd-apply-trigger-"));
  const runtimeRoot = join(sandboxBase, "runtime-root");
  const previousOverride = process.env[runtimeOverrideEnvVar];
  process.env[runtimeOverrideEnvVar] = runtimeRoot;

  const database = await createLedger();
  try {
    const session = {
      ...sourceSessionFixture,
      project_key: "agent-session-distillery",
      session_id: "apply-trigger-session",
      conversation_id: "apply-trigger-conversation",
      source_hash: "sha256:apply-trigger",
      source_path: "/tmp/apply-trigger.jsonl",
      workspace_path: "/Users/example/Code/agent-session-distillery",
    };
    upsertSourceSession(database, session);

    const original = {
      ...learningFixture,
      learning_id: "apply-trigger-learning",
      scope_key: session.project_key,
      statement: "Keep raw reviewed statement.",
      trigger: "When a legacy default trigger is still present.",
      source_refs: learningFixture.source_refs.map((sourceRef) => ({
        ...sourceRef,
        session_id: session.session_id,
        source_hash: session.source_hash,
        source_path: session.source_path,
      })),
    };
    const learningPath = getProjectKnowledgeSessionPath(session.project_key, session.session_id);
    await mkdir(dirname(learningPath), { recursive: true });
    await writeFile(learningPath, `${JSON.stringify(original)}\n`, "utf8");

    const sidecarPath = join(runtimeRoot, "reports", "llm-learning-review.jsonl");
    await mkdir(dirname(sidecarPath), { recursive: true });
    await writeFile(
      sidecarPath,
      `${JSON.stringify({
        durability: "durable",
        keep: true,
        learning_id: original.learning_id,
        reason: "Reviewed trigger reconstruction.",
        scope_key: original.scope_key,
        session_id: session.session_id,
        statement: original.statement,
        suggested_statement: "Use reconstructed triggers when applying reviewed learnings.",
        trigger: "When applying reviewed project learnings to the instinct store.",
        verdict: "rewrite",
      })}\n`,
      "utf8",
    );

    const messages = [];
    const exitCode = await executeQualityApplyLearningReview(
      {
        args: ["--input", sidecarPath],
        commandPath: ["quality", "apply-learning-review"],
        output: {
          error: (message) => messages.push(message),
          info: (message) => messages.push(message),
        },
      },
      database,
    );

    assert.equal(exitCode, 0);
    const projectId = hashToProjectId(session.workspace_path);
    const reviewedPath = join(
      runtimeRoot,
      "knowledge",
      "projects-reviewed",
      projectId,
      `${session.session_id}.jsonl`,
    );
    const reviewed = JSON.parse((await readFile(reviewedPath, "utf8")).trim());
    assert.equal(
      reviewed.statement,
      "Use reconstructed triggers when applying reviewed learnings.",
    );
    assert.equal(
      reviewed.trigger,
      "When applying reviewed project learnings to the instinct store.",
    );

    const output = JSON.parse(messages.at(-1));
    assert.equal(output.kept, 1);
    assert.equal(output.rejected, 0);
  } finally {
    database.close();
    if (previousOverride === undefined) {
      delete process.env[runtimeOverrideEnvVar];
    } else {
      process.env[runtimeOverrideEnvVar] = previousOverride;
    }
    await rm(sandboxBase, { force: true, recursive: true });
  }
});
