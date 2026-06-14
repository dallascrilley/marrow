import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createLedger,
  transitionPhase,
  upsertDeletionCandidate,
  upsertSourceSession,
} from "../dist/db/ledger.js";
import { sourceSessionFixture, summaryFixture } from "../dist/models/canonical.js";
import { auditQuality } from "../dist/pipeline/quality-audit.js";
import { auditTopicDistribution } from "../dist/pipeline/topic-distribution.js";
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
        source_hash: "sha256:good",
      }).sourceSession;
      const noisySession = upsertSourceSession(database, {
        ...sourceSessionFixture,
        project_key: "agent-session-distillery",
        session_id: "noisy-session",
        source_hash: "sha256:noisy",
      }).sourceSession;

      transitionPhase(database, {
        phaseName: "deletion_candidate",
        phaseState: "completed",
        sourceHash: goodSession.source_hash,
        sourceSessionId: goodSession.id,
      });
      transitionPhase(database, {
        phaseName: "deletion_candidate",
        phaseState: "completed",
        sourceHash: noisySession.source_hash,
        sourceSessionId: noisySession.id,
      });

      await writeSessionSummary({
        ...summaryFixture,
        files_of_interest: ["src/pipeline/summarize.ts"],
        next_step: "No open next step recorded.",
        project_learnings: ["Verified completion outcomes are promoted conservatively."],
        session_id: "good-session",
        useful_commands: ["npm test"],
        what_worked: ["Completed quality fixes; verified with `npm test`."],
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
                turn_id: null,
              },
            ],
            statement: "Verified completion outcomes are promoted conservatively.",
            title: "Verified completion",
          },
        ],
        sessionId: goodSession.session_id,
        userLearnings: [],
      });
      await writeSessionSummary({
        ...summaryFixture,
        files_of_interest: [],
        next_step: "Done: implemented and verified all work.",
        project_learnings: [],
        session_id: "noisy-session",
        topic: "Let me inspect the repo first.",
        useful_commands: [],
        what_worked: ["Let me verify this before finishing."],
      });

      upsertDeletionCandidate(database, {
        candidateState: "ready",
        currentLifecycleState: "deletion_candidate",
        projectKey: goodSession.project_key,
        reason: "All required retention artifacts are present.",
        safeToDelete: true,
        sessionId: goodSession.session_id,
        sourceHash: goodSession.source_hash,
        sourceSessionId: goodSession.id,
      });
      upsertDeletionCandidate(database, {
        candidateState: "pending_artifacts",
        currentLifecycleState: "deletion_candidate",
        projectKey: noisySession.project_key,
        reason: "no_durable_learnings: No project or user learnings have been written yet.",
        safeToDelete: false,
        sessionId: noisySession.session_id,
        sourceHash: noisySession.source_hash,
        sourceSessionId: noisySession.id,
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
      assert.equal(report.recommendations[0].issue, "blocked_deletion");
      assert.equal(report.recommendations[0].affected_sessions, 1);
      assert.deepEqual(
        report.sessions.find((session) => session.session_id === "good-session")
          .knowledge_artifacts,
        {
          project: true,
          user: false,
        },
      );
      assert.equal(report.worst_sessions[0].session_id, "noisy-session");
    } finally {
      database.close();
    }
  });
});

test("quality audit reports project-learning distribution statistics", async () => {
  await withRuntimeRoot(async () => {
    const database = await createLedger();

    try {
      const counts = [0, 1, 3, 10];

      for (const [index, count] of counts.entries()) {
        const sessionId = `distribution-session-${index}`;
        const sourceSession = upsertSourceSession(database, {
          ...sourceSessionFixture,
          project_key: "agent-session-distillery",
          session_id: sessionId,
          source_hash: `sha256:distribution-${index}`,
        }).sourceSession;

        await writeSessionSummary({
          ...summaryFixture,
          files_of_interest: ["src/pipeline/quality-audit.ts"],
          next_step: "No open next step recorded.",
          project_learnings: count === 0 ? [] : [`Summary fallback learning ${index}`],
          session_id: sessionId,
          useful_commands: ["npm test"],
          what_worked: ["Generated distribution fixture data."],
        });

        await writeKnowledgeArtifacts({
          projectLearnings: Array.from({ length: count }, (_, learningIndex) => ({
            confidence: "medium",
            evidence: [`Distribution evidence ${index}.${learningIndex}`],
            kind: "workflow",
            learning_id: `${sessionId}:project:${learningIndex}`,
            promotion_basis: "Distribution test fixture",
            scope: "project",
            scope_key: sourceSession.project_key,
            source_refs: [
              {
                event_id: null,
                line: null,
                session_id: sourceSession.session_id,
                source_hash: sourceSession.source_hash,
                source_path: sourceSession.source_path,
                turn_id: null,
              },
            ],
            statement: `Distribution learning ${index}.${learningIndex}`,
            title: `Distribution learning ${index}.${learningIndex}`,
          })),
          sessionId,
          userLearnings: [],
        });
      }

      const report = await auditQuality(database);

      assert.equal(report.learning_distribution.sessions_with_project_learnings, 3);
      assert.equal(report.learning_distribution.total_project_learnings, 14);
      assert.equal(report.learning_distribution.max_project_learnings, 10);
      assert.equal(report.learning_distribution.percentiles.p50, 3);
      assert.equal(report.learning_distribution.percentiles.p90, 10);
      assert.equal(report.learning_distribution.buckets.gt_10, 0);
      assert.equal(report.learning_distribution.buckets.gte_10, 1);
      assert.deepEqual(report.learning_distribution.top_sessions.slice(0, 2), [
        { project_learning_count: 10, session_id: "distribution-session-3" },
        { project_learning_count: 3, session_id: "distribution-session-2" },
      ]);
      assert.equal(
        report.sessions.find((session) => session.session_id === "distribution-session-3")
          .project_learning_count,
        10,
      );
    } finally {
      database.close();
    }
  });
});

test("topic distribution aggregates low-signal, wrapper leaks, and llm rescue coverage", async () => {
  await withRuntimeRoot(async () => {
    const database = await createLedger();

    try {
      const goodSession = upsertSourceSession(database, {
        ...sourceSessionFixture,
        project_key: "agent-session-distillery",
        session_id: "topic-good-session",
        source_hash: "sha256:topic-good",
      }).sourceSession;
      const noisySession = upsertSourceSession(database, {
        ...sourceSessionFixture,
        project_key: "agent-session-distillery",
        session_id: "topic-noisy-session",
        source_hash: "sha256:topic-noisy",
      }).sourceSession;
      const rescuedSession = upsertSourceSession(database, {
        ...sourceSessionFixture,
        project_key: "other-project",
        session_id: "topic-rescued-session",
        source_hash: "sha256:topic-rescued",
      }).sourceSession;
      upsertSourceSession(database, {
        ...sourceSessionFixture,
        project_key: "other-project",
        session_id: "topic-missing-session",
        source_hash: "sha256:topic-missing",
      });

      await writeSessionSummary({
        ...summaryFixture,
        session_id: goodSession.session_id,
        topic: "Fix quality audit topic distribution",
        topic_source: "deterministic",
      });
      await writeSessionSummary({
        ...summaryFixture,
        session_id: noisySession.session_id,
        topic: "brainstorming",
        topic_source: "deterministic",
      });
      await writeSessionSummary({
        ...summaryFixture,
        session_id: rescuedSession.session_id,
        topic: "Recover topic quality with LLM rescue",
        topic_source: "llm",
      });

      const report = await auditTopicDistribution(database);

      assert.equal(report.totals.sessions, 4);
      assert.equal(report.totals.missing_summaries, 1);
      assert.equal(report.totals.low_signal_topics, 1);
      assert.equal(report.totals.wrapper_leak_topics, 1);
      assert.equal(report.totals.deterministic_topics, 2);
      assert.equal(report.totals.llm_rescued_topics, 1);
      assert.deepEqual(report.remediation.commands, [
        "npm run corpus:resummarize:dry-run",
        "npm run corpus:resummarize",
      ]);
      assert.equal(report.remediation.resummarize_candidate_count, 1);

      const mainProject = report.by_project.find(
        (project) => project.project_key === "agent-session-distillery",
      );
      assert.ok(mainProject);
      assert.equal(mainProject.sessions, 2);
      assert.equal(mainProject.low_signal_topics, 1);
      assert.equal(mainProject.low_signal_rate, 0.5);
      assert.equal(mainProject.wrapper_leak_topics, 1);
      assert.equal(mainProject.deterministic_topics, 2);
      assert.equal(mainProject.llm_rescued_topics, 0);

      const otherProject = report.by_project.find(
        (project) => project.project_key === "other-project",
      );
      assert.ok(otherProject);
      assert.equal(otherProject.sessions, 2);
      assert.equal(otherProject.missing_summaries, 1);
      assert.equal(otherProject.llm_rescued_topics, 1);
      assert.equal(
        report.by_project[0].project_key,
        "agent-session-distillery",
        "projects sort by highest low-signal rate first",
      );
    } finally {
      database.close();
    }
  });
});
