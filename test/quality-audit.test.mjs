import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createLedger,
  transitionPhase,
  upsertDeletionCandidate,
  upsertSourceSession
} from "../dist/db/ledger.js";
import { sourceSessionFixture, summaryFixture } from "../dist/models/canonical.js";
import { auditQuality } from "../dist/pipeline/quality-audit.js";
import { writeKnowledgeArtifacts } from "../dist/writers/knowledge-writer.js";
import { writeSessionSummary } from "../dist/writers/summary-writer.js";

const runtimeOverrideEnvVar = "AGENT_SESSION_DISTILLERY_ROOT";

async function withRuntimeRoot(run) {
  const sandboxBase = await mkdtemp(join(tmpdir(), "asd-quality-audit-"));
  const runtimeRoot = join(sandboxBase, "runtime-root");
  const previousOverride = process.env[runtimeOverrideEnvVar];

  process.env[runtimeOverrideEnvVar] = runtimeRoot;

  try {
    await run();
  } finally {
    if (previousOverride === undefined) {
      delete process.env[runtimeOverrideEnvVar];
    } else {
      process.env[runtimeOverrideEnvVar] = previousOverride;
    }

    await rm(sandboxBase, { force: true, recursive: true });
  }
}

test("quality audit ranks summary defects and deletion readiness", async () => {
  await withRuntimeRoot(async () => {
    const database = await createLedger();

    try {
      const goodSession = upsertSourceSession(database, {
        ...sourceSessionFixture,
        project_key: "agent-session-distillery",
        session_id: "good-session",
        source_hash: "sha256:good"
      }).sourceSession;
      const noisySession = upsertSourceSession(database, {
        ...sourceSessionFixture,
        project_key: "agent-session-distillery",
        session_id: "noisy-session",
        source_hash: "sha256:noisy"
      }).sourceSession;

      transitionPhase(database, {
        phaseName: "deletion_candidate",
        phaseState: "completed",
        sourceHash: goodSession.source_hash,
        sourceSessionId: goodSession.id
      });
      transitionPhase(database, {
        phaseName: "deletion_candidate",
        phaseState: "completed",
        sourceHash: noisySession.source_hash,
        sourceSessionId: noisySession.id
      });

      await writeSessionSummary({
        ...summaryFixture,
        files_of_interest: ["src/pipeline/summarize.ts"],
        next_step: "No open next step recorded.",
        project_learnings: ["Verified completion outcomes are promoted conservatively."],
        session_id: "good-session",
        useful_commands: ["npm test"],
        what_worked: ["Completed quality fixes; verified with `npm test`."]
      });
      await writeKnowledgeArtifacts({
        projectLearnings: [
          {
            confidence: "medium",
            evidence: ["Completed quality fixes; verified with `npm test`."],
            kind: "workflow",
            learning_id: "good-session:project:completion",
            promotion_basis: "Test fixture",
            scope: "project",
            scope_key: goodSession.project_key,
            source_refs: [
              {
                event_id: null,
                line: null,
                session_id: goodSession.session_id,
                source_hash: goodSession.source_hash,
                source_path: goodSession.source_path,
                turn_id: null
              }
            ],
            statement: "Verified completion outcomes are promoted conservatively.",
            title: "Verified completion"
          }
        ],
        sessionId: goodSession.session_id,
        userLearnings: []
      });
      await writeSessionSummary({
        ...summaryFixture,
        files_of_interest: [],
        next_step: "Done: implemented and verified all work.",
        project_learnings: [],
        session_id: "noisy-session",
        topic: "Let me inspect the repo first.",
        useful_commands: [],
        what_worked: ["Let me verify this before finishing."]
      });

      upsertDeletionCandidate(database, {
        candidateState: "ready",
        currentLifecycleState: "deletion_candidate",
        projectKey: goodSession.project_key,
        reason: "All required retention artifacts are present.",
        safeToDelete: true,
        sessionId: goodSession.session_id,
        sourceHash: goodSession.source_hash,
        sourceSessionId: goodSession.id
      });
      upsertDeletionCandidate(database, {
        candidateState: "pending_artifacts",
        currentLifecycleState: "deletion_candidate",
        projectKey: noisySession.project_key,
        reason: "no_durable_learnings: No project or user learnings have been written yet.",
        safeToDelete: false,
        sessionId: noisySession.session_id,
        sourceHash: noisySession.source_hash,
        sourceSessionId: noisySession.id
      });

      const report = await auditQuality(database);

      assert.equal(report.totals.audited, 2);
      assert.equal(report.deletion_readiness.ready, 1);
      assert.equal(report.deletion_readiness.blocked, 1);
      assert.equal(report.issue_counts.process_chatter, 1);
      assert.equal(report.issue_counts.no_useful_commands, 1);
      assert.equal(report.issue_counts.no_files_of_interest, 1);
      assert.equal(report.issue_counts.no_project_learnings, 1);
      assert.equal(report.issue_counts.blocked_deletion, 1);
      assert.deepEqual(report.sessions.find((session) => session.session_id === "good-session").knowledge_artifacts, {
        project: true,
        user: false
      });
      assert.equal(report.worst_sessions[0].session_id, "noisy-session");
    } finally {
      database.close();
    }
  });
});
