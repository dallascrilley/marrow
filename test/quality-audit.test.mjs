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
      const manualReviewSession = upsertSourceSession(database, {
        ...sourceSessionFixture,
        project_key: "agent-session-distillery",
        session_id: "manual-review-session",
        source_hash: "sha256:manual-review",
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
      transitionPhase(database, {
        phaseName: "deletion_candidate",
        phaseState: "completed",
        sourceHash: manualReviewSession.source_hash,
        sourceSessionId: manualReviewSession.id,
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
            trigger: "When running the same workflow in the test fixture project.",
            evidence_type: "verified",
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
      await writeSessionSummary({
        ...summaryFixture,
        files_of_interest: ["src/pipeline/extract.ts"],
        next_step: "No open next step recorded.",
        project_learnings: [],
        session_id: "manual-review-session",
        topic: "Review the ingestion quality heuristics.",
        useful_commands: [],
        what_worked: [
          "Now regenerate the registry summary + projections from the corrected description, then check whether the provenance edit survived the update.",
        ],
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
      upsertDeletionCandidate(database, {
        candidateState: "pending_artifacts",
        currentLifecycleState: "deletion_candidate",
        projectKey: manualReviewSession.project_key,
        reason: "no_durable_learnings: No project or user learnings have been written yet.",
        safeToDelete: false,
        sessionId: manualReviewSession.session_id,
        sourceHash: manualReviewSession.source_hash,
        sourceSessionId: manualReviewSession.id,
      });

      const report = await auditQuality(database);

      assert.equal(report.totals.audited, 3);
      assert.equal(report.deletion_readiness.ready, 1);
      assert.equal(report.deletion_readiness.blocked, 2);
      assert.equal(report.issue_counts.process_chatter, 2);
      assert.equal(report.issue_counts.no_useful_commands, 2);
      assert.equal(report.issue_counts.no_files_of_interest, 1);
      assert.equal(report.issue_counts.no_project_learnings, 2);
      assert.equal(report.issue_counts.blocked_deletion, 2);
      assert.equal(report.recommendations[0].issue, "blocked_deletion");
      assert.equal(report.recommendations[0].affected_sessions, 2);
      assert.deepEqual(
        report.sessions.find((session) => session.session_id === "good-session")
          .knowledge_artifacts,
        {
          project: true,
          user: false,
        },
      );
      assert.equal(report.worst_sessions[0].session_id, "noisy-session");
      assert.ok(
        report.sessions
          .find((session) => session.session_id === "manual-review-session")
          .issues.includes("process_chatter"),
      );
    } finally {
      database.close();
    }
  });
});

test("quality audit distinguishes pure process chatter from durable signal with process wording", async () => {
  await withRuntimeRoot(async () => {
    const database = await createLedger();

    try {
      const pureChatterSession = upsertSourceSession(database, {
        ...sourceSessionFixture,
        project_key: "agent-session-distillery",
        session_id: "pure-chatter-session",
        source_hash: "sha256:pure-chatter",
      }).sourceSession;
      const durableSignalSession = upsertSourceSession(database, {
        ...sourceSessionFixture,
        project_key: "agent-session-distillery",
        session_id: "durable-signal-session",
        source_hash: "sha256:durable-signal",
      }).sourceSession;

      transitionPhase(database, {
        phaseName: "deletion_candidate",
        phaseState: "completed",
        sourceHash: pureChatterSession.source_hash,
        sourceSessionId: pureChatterSession.id,
      });
      transitionPhase(database, {
        phaseName: "deletion_candidate",
        phaseState: "completed",
        sourceHash: durableSignalSession.source_hash,
        sourceSessionId: durableSignalSession.id,
      });

      await writeSessionSummary({
        ...summaryFixture,
        files_of_interest: [],
        next_step: "No explicit next step recorded.",
        project_learnings: [],
        session_id: "pure-chatter-session",
        topic: "Let me inspect the repo first.",
        useful_commands: [],
        what_worked: ["Let me verify this before finishing."],
      });
      await writeSessionSummary({
        ...summaryFixture,
        files_of_interest: ["src/pipeline/summarize.ts"],
        next_step: "No open next step recorded.",
        project_learnings: ["Verified completion outcomes are promoted conservatively."],
        session_id: "durable-signal-session",
        topic: "Fix toast infrastructure for desktop-polish.",
        useful_commands: ["npm test"],
        what_worked: [
          "Let me check what toast infrastructure is available: fixed the desktop-polish wiring and verified with `npm test`.",
        ],
      });

      const report = await auditQuality(database);

      const pureChatter = report.sessions.find(
        (session) => session.session_id === "pure-chatter-session",
      );
      const durableSignal = report.sessions.find(
        (session) => session.session_id === "durable-signal-session",
      );

      assert.ok(pureChatter.issues.includes("process_chatter"));
      assert.ok(!durableSignal.issues.includes("process_chatter"));
    } finally {
      database.close();
    }
  });
});

test("quality audit does not flag ready sessions with directory-level file evidence", async () => {
  await withRuntimeRoot(async () => {
    const database = await createLedger();

    try {
      const session = upsertSourceSession(database, {
        ...sourceSessionFixture,
        project_key: "demo",
        session_id: "directory-file-signal-session",
        source_hash: "sha256:directory-signal",
      }).sourceSession;

      transitionPhase(database, {
        phaseName: "deletion_candidate",
        phaseState: "completed",
        sourceHash: session.source_hash,
        sourceSessionId: session.id,
      });

      await writeSessionSummary({
        ...summaryFixture,
        files_of_interest: ["src"],
        next_step: "No open next step recorded.",
        project_learnings: ["Keep the demo's test suite focused on src."],
        session_id: session.session_id,
        topic: "Use npm test to verify the demo before shipping.",
        useful_commands: ["npm test"],
        what_was_decided: ["Keep the demo's test suite focused on src."],
      });

      await writeKnowledgeArtifacts({
        projectLearnings: [
          {
            confidence: "medium",
            evidence: ["Keep the demo's test suite focused on src."],
            kind: "decision",
            learning_id: `${session.session_id}:project:decision:1`,
            promotion_basis: "Test fixture",
            scope: "project",
            scope_key: session.project_key,
            source_refs: [
              {
                event_id: null,
                line: null,
                session_id: session.session_id,
                source_hash: session.source_hash,
                source_path: session.source_path,
                turn_id: null,
              },
            ],
            statement: "Keep the demo's test suite focused on src.",
            title: "Directory signal",
          },
        ],
        sessionId: session.session_id,
        userLearnings: [],
      });

      upsertDeletionCandidate(database, {
        candidateState: "ready",
        currentLifecycleState: "deletion_candidate",
        projectKey: session.project_key,
        reason: "All required retention artifacts are present.",
        safeToDelete: true,
        sessionId: session.session_id,
        sourceHash: session.source_hash,
        sourceSessionId: session.id,
      });

      const report = await auditQuality(database);
      const auditedSession = report.sessions.find(
        (entry) => entry.session_id === session.session_id,
      );

      assert.ok(auditedSession);
      assert.ok(!auditedSession.issues.includes("no_files_of_interest"));
    } finally {
      database.close();
    }
  });
});

test("quality audit distinguishes pure process chatter from durable signal with process wording", async () => {
  await withRuntimeRoot(async () => {
    const database = await createLedger();

    try {
      const pureChatterSession = upsertSourceSession(database, {
        ...sourceSessionFixture,
        project_key: "agent-session-distillery",
        session_id: "pure-chatter-session",
        source_hash: "sha256:pure-chatter",
      }).sourceSession;
      const durableSignalSession = upsertSourceSession(database, {
        ...sourceSessionFixture,
        project_key: "agent-session-distillery",
        session_id: "durable-signal-session",
        source_hash: "sha256:durable-signal",
      }).sourceSession;

      transitionPhase(database, {
        phaseName: "deletion_candidate",
        phaseState: "completed",
        sourceHash: pureChatterSession.source_hash,
        sourceSessionId: pureChatterSession.id,
      });
      transitionPhase(database, {
        phaseName: "deletion_candidate",
        phaseState: "completed",
        sourceHash: durableSignalSession.source_hash,
        sourceSessionId: durableSignalSession.id,
      });

      await writeSessionSummary({
        ...summaryFixture,
        files_of_interest: [],
        next_step: "No explicit next step recorded.",
        project_learnings: [],
        session_id: "pure-chatter-session",
        topic: "Let me inspect the repo first.",
        useful_commands: [],
        what_worked: ["Let me verify this before finishing."],
      });
      await writeSessionSummary({
        ...summaryFixture,
        files_of_interest: ["src/pipeline/summarize.ts"],
        next_step: "No open next step recorded.",
        project_learnings: ["Verified completion outcomes are promoted conservatively."],
        session_id: "durable-signal-session",
        topic: "Fix toast infrastructure for desktop-polish.",
        useful_commands: ["npm test"],
        what_worked: [
          "Let me check what toast infrastructure is available: fixed the desktop-polish wiring and verified with `npm test`.",
        ],
      });

      const report = await auditQuality(database);

      const pureChatter = report.sessions.find(
        (session) => session.session_id === "pure-chatter-session",
      );
      const durableSignal = report.sessions.find(
        (session) => session.session_id === "durable-signal-session",
      );

      assert.ok(pureChatter.issues.includes("process_chatter"));
      assert.ok(!durableSignal.issues.includes("process_chatter"));
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
            trigger: `When running the same workflow in ${sourceSession.project_key}.`,
            evidence_type: "inferred",
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

test("quality audit does not flag discovered sessions as summary_missing", async () => {
  await withRuntimeRoot(async () => {
    const database = await createLedger();

    try {
      upsertSourceSession(database, {
        ...sourceSessionFixture,
        ingest_status: "discovered",
        project_key: "agent-session-distillery",
        retention_status: "kept",
        session_id: "discovered-session",
        source_hash: "sha256:discovered",
      });

      const report = await auditQuality(database);

      const discoveredSession = report.sessions.find(
        (session) => session.session_id === "discovered-session",
      );
      assert.ok(discoveredSession);
      assert.equal(discoveredSession.issue_count, 0);
      assert.deepEqual(discoveredSession.issues, []);
      assert.equal(report.issue_counts.summary_missing, 0);
    } finally {
      database.close();
    }
  });
});

test("low_signal_topic and process_chatter are distinct audit dimensions", async () => {
  await withRuntimeRoot(async () => {
    const database = await createLedger();

    try {
      upsertSourceSession(database, {
        ...sourceSessionFixture,
        project_key: "agent-session-distillery",
        session_id: "topic-chatter",
        source_hash: "sha256:topic-chatter",
      });
      upsertSourceSession(database, {
        ...sourceSessionFixture,
        project_key: "agent-session-distillery",
        session_id: "body-chatter",
        source_hash: "sha256:body-chatter",
      });

      // Chatter-shaped topic, clean body.
      await writeSessionSummary({
        ...summaryFixture,
        session_id: "topic-chatter",
        topic: "I'm getting the following error in my code:",
        what_was_decided: ["Use worker threads instead of forks."],
        what_worked: ["Repaired the retention regression."],
      });
      // Clean topic, chatter in the body.
      await writeSessionSummary({
        ...summaryFixture,
        session_id: "body-chatter",
        topic: "Retention regression fix",
        what_was_decided: ["Let me check the logs now."],
        what_worked: ["Repaired the retention regression."],
      });

      const report = await auditQuality(database);
      const topicSession = report.sessions.find(
        (session) => session.session_id === "topic-chatter",
      );
      const bodySession = report.sessions.find((session) => session.session_id === "body-chatter");

      // Topic chatter is a topic-quality issue, NOT body process_chatter.
      assert.ok(topicSession.issues.includes("low_signal_topic"));
      assert.ok(!topicSession.issues.includes("process_chatter"));

      // Body chatter is process_chatter; its clean topic is not flagged.
      assert.ok(bodySession.issues.includes("process_chatter"));
      assert.ok(!bodySession.issues.includes("low_signal_topic"));
    } finally {
      database.close();
    }
  });
});
