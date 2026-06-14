import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createLedger,
  transitionPhase,
  upsertDeletionCandidate,
  upsertSourceSession,
} from "../../dist/db/ledger.js";
import { eventSchema, sourceSessionFixture, turnSchema } from "../../dist/models/canonical.js";
import { extractLearnings } from "../../dist/pipeline/extract.js";
import { evaluateRetentionReadiness } from "../../dist/pipeline/retention.js";
import { summarizeSession } from "../../dist/pipeline/summarize.js";
import {
  getProjectKnowledgeSessionPath,
  getUserKnowledgeSessionPath,
  writeKnowledgeArtifacts,
} from "../../dist/writers/knowledge-writer.js";
import { writeSessionManifest } from "../../dist/writers/manifest-writer.js";
import {
  getRetentionReceiptPath,
  writeRetentionBatchReport,
  writeRetentionReceipt,
} from "../../dist/writers/report-writer.js";
import { writeSessionSummary } from "../../dist/writers/summary-writer.js";

const runtimeOverrideEnvVar = "AGENT_SESSION_DISTILLERY_ROOT";

async function withRuntimeRoot(run) {
  const sandboxBase = await mkdtemp(join(tmpdir(), "asd-artifacts-"));
  const runtimeRoot = join(sandboxBase, "runtime-root");
  const previousOverride = process.env[runtimeOverrideEnvVar];

  process.env[runtimeOverrideEnvVar] = runtimeRoot;

  try {
    await run(runtimeRoot);
  } finally {
    if (previousOverride === undefined) {
      delete process.env[runtimeOverrideEnvVar];
    } else {
      process.env[runtimeOverrideEnvVar] = previousOverride;
    }

    await rm(sandboxBase, { force: true, recursive: true });
  }
}

function buildSourceSession() {
  return {
    ...sourceSessionFixture,
    conversation_id: "conversation-task7",
    project_key: "agent-session-distillery",
    session_id: "session-task7",
    source_hash: "sha256:task7",
    source_path: "/tmp/source/session-task7.jsonl",
    started_at: "2026-05-16T09:00:00Z",
    updated_at: "2026-05-16T09:05:00Z",
  };
}

function buildTurns(sessionId) {
  return [
    turnSchema.parse({
      assistant_summary: "Added summary and retention artifact generation.",
      commands_seen: ["npm run build", "npm test"],
      ended_at: "2026-05-16T09:05:00Z",
      files_touched: [
        "src/pipeline/summarize.ts",
        "src/pipeline/extract.ts",
        "src/pipeline/retention.ts",
        "src/writers/summary-writer.ts",
      ],
      index: 0,
      session_id: sessionId,
      started_at: "2026-05-16T09:00:00Z",
      tool_stub_count: 1,
      turn_id: `${sessionId}:turn-0000`,
      user_prompt: [
        "Implement Task 7 for artifact generation.",
        "Do not revert edits made by others.",
        "Final response format: verification-first closeout.",
      ].join("\n"),
      verification_seen: true,
    }),
  ];
}

function buildEvents(turnId) {
  return [
    eventSchema.parse({
      confidence: "medium",
      event_id: `${turnId}:fix:000001`,
      payload_small: {
        matched_rule: "fixed",
      },
      source_offsets: {
        end_line: 21,
        start_line: 21,
      },
      summary: "Fixed the session writer to emit both markdown and JSON outputs.",
      turn_id: turnId,
      type: "fix",
    }),
    eventSchema.parse({
      confidence: "high",
      event_id: `${turnId}:decision:000002`,
      payload_small: {
        matched_rule: "decided",
      },
      source_offsets: {
        end_line: 24,
        start_line: 24,
      },
      summary: "Kept retention readiness tied to concrete artifact presence.",
      turn_id: turnId,
      type: "decision",
    }),
    eventSchema.parse({
      confidence: "high",
      event_id: `${turnId}:verification:000003`,
      payload_small: {
        matched_rule: "verification_command",
        verification_command: "npm test",
      },
      source_offsets: {
        end_line: 28,
        start_line: 28,
      },
      summary: "Ran verification command: npm test",
      turn_id: turnId,
      type: "verification",
    }),
    eventSchema.parse({
      confidence: "medium",
      event_id: `${turnId}:next_step:000004`,
      payload_small: {
        matched_rule: "next_step",
      },
      source_offsets: {
        end_line: 30,
        start_line: 30,
      },
      summary: "Next step is wiring the batch retention report into the CLI.",
      turn_id: turnId,
      type: "next_step",
    }),
    eventSchema.parse({
      confidence: "low",
      event_id: `${turnId}:decision:000005`,
      payload_small: {
        matched_rule: "decided",
      },
      source_offsets: {
        end_line: 33,
        start_line: 33,
      },
      summary: "Maybe keep a temporary fallback path for later.",
      turn_id: turnId,
      type: "decision",
    }),
  ];
}

test("retention blocks deletion until summary, learnings, manifest, and receipt exist", async () => {
  await withRuntimeRoot(async () => {
    const database = await createLedger();

    try {
      const sourceSession = buildSourceSession();
      const inserted = upsertSourceSession(database, sourceSession);
      const turns = buildTurns(sourceSession.session_id);
      const events = buildEvents(turns[0].turn_id);
      const learnings = extractLearnings({
        events,
        sourceSession,
        turns,
      });
      const summary = summarizeSession({
        events,
        projectLearnings: learnings.project,
        sourceSession,
        turns,
        userLearnings: learnings.user,
      });

      assert.deepEqual(
        learnings.project
          .map((learning) => learning.kind)
          .sort((left, right) => left.localeCompare(right)),
        ["decision", "pattern", "verification_rule"],
      );
      assert.equal(learnings.user.length, 2);

      const summaryResult = await writeSessionSummary(summary);
      transitionPhase(database, {
        phaseName: "summarized",
        phaseState: "completed",
        sourceSessionId: inserted.sourceSession.id,
      });

      const afterSummary = await evaluateRetentionReadiness({
        currentLifecycleState: "summarized",
        sourceSession,
        sourceSessionId: inserted.sourceSession.id,
      });
      const firstCandidate = upsertDeletionCandidate(database, afterSummary.candidate);
      assert.equal(afterSummary.receipt.safe_to_delete, false);
      assert.match(afterSummary.receipt.reason_if_not, /No project or user learnings/);
      assert.equal(firstCandidate.safe_to_delete, 0);

      const knowledgeResult = await writeKnowledgeArtifacts({
        projectLearnings: learnings.project,
        sessionId: sourceSession.session_id,
        userLearnings: learnings.user,
      });
      transitionPhase(database, {
        phaseName: "extracted",
        phaseState: "completed",
        sourceSessionId: inserted.sourceSession.id,
      });

      const expectedProjectPath = getProjectKnowledgeSessionPath(
        sourceSession.project_key,
        sourceSession.session_id,
      );
      const expectedUserPath = getUserKnowledgeSessionPath("operator", sourceSession.session_id);
      assert.equal(knowledgeResult.project.path, expectedProjectPath);
      assert.equal(knowledgeResult.user.path, expectedUserPath);
      const firstProjectKnowledge = await readFile(expectedProjectPath, "utf8");
      const firstUserKnowledge = await readFile(expectedUserPath, "utf8");
      const secondKnowledgeResult = await writeKnowledgeArtifacts({
        projectLearnings: learnings.project,
        sessionId: sourceSession.session_id,
        userLearnings: learnings.user,
      });
      assert.equal(secondKnowledgeResult.project.path, expectedProjectPath);
      assert.equal(secondKnowledgeResult.user.path, expectedUserPath);
      assert.equal(await readFile(expectedProjectPath, "utf8"), firstProjectKnowledge);
      assert.equal(await readFile(expectedUserPath, "utf8"), firstUserKnowledge);

      const receiptPath = getRetentionReceiptPath(sourceSession.session_id);
      const manifestResult = await writeSessionManifest({
        artifactPaths: {
          project_knowledge_jsonl_path: knowledgeResult.project.path,
          retention_receipt_path: receiptPath,
          summary_json_path: summaryResult.summaryPath,
          summary_markdown_path: summaryResult.markdownPath,
          user_knowledge_jsonl_path: knowledgeResult.user.path,
        },
        events,
        sourceSession,
        turns,
      });
      assert.equal(manifestResult.created, true);

      const afterManifest = await evaluateRetentionReadiness({
        currentLifecycleState: "extracted",
        sourceSession,
        sourceSessionId: inserted.sourceSession.id,
      });
      const secondCandidate = upsertDeletionCandidate(database, afterManifest.candidate);
      assert.equal(afterManifest.receipt.safe_to_delete, false);
      assert.match(
        afterManifest.receipt.reason_if_not,
        /Retention receipt has not been written yet/,
      );
      assert.equal(secondCandidate.safe_to_delete, 0);

      await writeRetentionReceipt(afterManifest.receipt);

      const afterReceipt = await evaluateRetentionReadiness({
        currentLifecycleState: "extracted",
        sourceSession,
        sourceSessionId: inserted.sourceSession.id,
      });
      const finalCandidate = upsertDeletionCandidate(database, afterReceipt.candidate);
      assert.equal(afterReceipt.receipt.safe_to_delete, true);
      assert.equal(afterReceipt.receipt.reason_if_not, "");
      assert.equal(finalCandidate.safe_to_delete, 1);
      assert.equal(finalCandidate.reason, "All required retention artifacts are present.");

      const reportResult = await writeRetentionBatchReport(
        [afterSummary, afterManifest, afterReceipt],
        "task7",
      );
      assert.equal(reportResult.report.ready_count, 1);
      assert.equal(reportResult.report.blocked_count, 2);

      await Promise.all([
        access(summaryResult.summaryPath),
        access(summaryResult.markdownPath),
        access(manifestResult.path),
        access(receiptPath),
        access(reportResult.jsonPath),
        access(reportResult.markdownPath),
      ]);

      const projectKnowledgeLines = (await readFile(expectedProjectPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.deepEqual(
        projectKnowledgeLines
          .map((entry) => entry.kind)
          .sort((left, right) => left.localeCompare(right)),
        ["decision", "pattern", "verification_rule"],
      );
      assert.ok(projectKnowledgeLines.every((entry) => entry.confidence !== "low"));
      assert.ok(
        projectKnowledgeLines.some(
          (entry) =>
            entry.statement === "Run npm test when verifying changes in agent-session-distillery.",
        ),
      );

      const userKnowledgeLines = (await readFile(expectedUserPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.deepEqual(
        userKnowledgeLines.map((entry) => entry.statement),
        [
          "Do not revert concurrent edits made by others; adapt to the current workspace state.",
          "Honor explicit final response formatting instructions when they are provided.",
        ],
      );

      const parsedSummary = JSON.parse(await readFile(summaryResult.summaryPath, "utf8"));
      assert.equal(
        parsedSummary.next_step,
        "Next step is wiring the batch retention report into the CLI.",
      );
      assert.equal(parsedSummary.project_learnings.length, 3);
      assert.equal(parsedSummary.user_learnings.length, 2);

      const parsedManifest = JSON.parse(await readFile(manifestResult.path, "utf8"));
      assert.equal(parsedManifest.source_span.turn_count, 1);
      assert.equal(parsedManifest.artifact_paths.retention_receipt_path, receiptPath);
      assert.equal(parsedManifest.source_span.line_start, 21);
      assert.equal(parsedManifest.source_span.line_end, 33);

      const parsedReceipt = JSON.parse(await readFile(receiptPath, "utf8"));
      assert.equal(parsedReceipt.summary_written, true);
      assert.equal(parsedReceipt.project_learnings_written, true);
      assert.equal(parsedReceipt.user_learnings_written, true);
      assert.equal(parsedReceipt.archive_copy_written, true);
      assert.equal(parsedReceipt.safe_to_delete, false);

      const refreshedReceipt = afterReceipt.receipt;
      assert.equal(refreshedReceipt.safe_to_delete, true);
    } finally {
      database.close();
    }
  });
});
