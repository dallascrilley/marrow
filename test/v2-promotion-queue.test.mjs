import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { executeQualityApplyLearningReview } from "../dist/commands/quality-apply-learning-review.js";
import { createLedger, upsertSourceSession } from "../dist/db/ledger.js";
import { learningFixture, sourceSessionFixture } from "../dist/models/canonical.js";
import { saveInstinct } from "../dist/v2/instinct/store.js";
import { syncReviewedLearningsToInstinctStore } from "../dist/v2/learning/sync-reviewed.js";
import {
  detectPromotionCandidates,
  getPromotionQueuePath,
  readPromotionQueue,
  refreshPromotionQueue,
} from "../dist/v2/promotion/queue.js";
import { getProjectKnowledgeSessionPath } from "../dist/writers/knowledge-writer.js";

const runtimeOverrideEnvVar = "AGENT_SESSION_DISTILLERY_ROOT";
const fixedNow = "2026-06-25T00:00:00.000Z";
const oldCreatedAt = "2026-06-01T00:00:00.000Z";
const matureObservations = [
  { session: "sess-1", reinforcing: true, at: "2026-05-20T00:00:00.000Z" },
  { session: "sess-2", reinforcing: true, at: "2026-05-28T00:00:00.000Z" },
  { session: "sess-3", reinforcing: true, at: "2026-06-05T00:00:00.000Z" },
];
const recentEstablishedObservations = [
  { session: "sess-1", reinforcing: true, at: "2026-06-10T00:00:00.000Z" },
  { session: "sess-2", reinforcing: true, at: "2026-06-18T00:00:00.000Z" },
  { session: "sess-3", reinforcing: true, at: "2026-06-24T00:00:00.000Z" },
];

function makeInstinct(projectId, overrides = {}) {
  return {
    schema_version: 1,
    id: "prefer-pnpm-aaaaaaaa",
    trigger: "When installing packages",
    finding: "Use pnpm in this repo.",
    confidence: 0.84,
    domain: "tooling",
    maturity: "established",
    scope: "project",
    project_id: projectId,
    source: {
      first_session: `${projectId}-sess-1`,
      first_observed_at: oldCreatedAt,
      source_refs: [],
      observations: matureObservations,
    },
    related: [],
    created_at: oldCreatedAt,
    updated_at: "2026-06-20T00:00:00.000Z",
    last_promoted_at: null,
    ...overrides,
  };
}

async function withRuntime(run) {
  const root = await mkdtemp(join(tmpdir(), "asd-promote-"));
  const prior = process.env[runtimeOverrideEnvVar];
  process.env[runtimeOverrideEnvVar] = root;
  try {
    await run(root);
  } finally {
    if (prior === undefined) {
      delete process.env[runtimeOverrideEnvVar];
    } else {
      process.env[runtimeOverrideEnvVar] = prior;
    }
    await rm(root, { recursive: true, force: true });
  }
}

function makeSourceSession(projectKey) {
  return {
    ...structuredClone(sourceSessionFixture),
    source_tool: "claude-code",
    source_path: `/tmp/${projectKey}/session.jsonl`,
    workspace_path: `/tmp/${projectKey}`,
    project_key: projectKey,
    session_id: `${projectKey}-session`,
    conversation_id: `${projectKey}-conversation`,
    started_at: "2026-06-24T10:00:00Z",
    updated_at: "2026-06-24T10:05:00Z",
  };
}

function makeReviewedLearning(session, learningId) {
  return {
    ...structuredClone(learningFixture),
    learning_id: learningId,
    title: "Use pnpm in this repo.",
    trigger: "When installing packages",
    statement: "Use pnpm in this repo.",
    confidence: "high",
    scope_key: session.project_key,
    source_refs: [
      {
        source_path: session.source_path,
        source_hash: "sha256:sync-refresh",
        session_id: session.session_id,
        turn_id: null,
        event_id: null,
        line: 1,
      },
    ],
  };
}

async function writeProjectLearning(projectKey, sessionId, learning) {
  const learningPath = getProjectKnowledgeSessionPath(projectKey, sessionId);
  await mkdir(dirname(learningPath), { recursive: true });
  await writeFile(learningPath, `${JSON.stringify(learning)}\n`, "utf8");
}

test("detectPromotionCandidates queues instincts seen in 2 aged projects with avg confidence >= 0.8", async () => {
  await withRuntime(async () => {
    await saveInstinct("proj-alpha001", makeInstinct("proj-alpha001", { confidence: 0.82 }));
    await saveInstinct("proj-beta0002", makeInstinct("proj-beta0002", { confidence: 0.9 }));

    const entries = await detectPromotionCandidates(fixedNow);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].instinct_id, "prefer-pnpm-aaaaaaaa");
    assert.equal(entries[0].trigger, "When installing packages");
    assert.equal(entries[0].finding, "Use pnpm in this repo.");
    assert.equal(entries[0].domain, "tooling");
    assert.equal(entries[0].project_count, 2);
    assert.equal(entries[0].avg_confidence, 0.86);
    assert.deepEqual(
      entries[0].projects.map((project) => project.project_id),
      ["proj-beta0002", "proj-alpha001"],
    );
  });
});

test("detectPromotionCandidates skips instincts that only recently reached established maturity", async () => {
  await withRuntime(async () => {
    await saveInstinct(
      "proj-alpha001",
      makeInstinct("proj-alpha001", {
        confidence: 0.84,
        created_at: "2026-05-20T00:00:00.000Z",
        source: {
          first_session: "proj-alpha001-sess-1",
          first_observed_at: "2026-05-20T00:00:00.000Z",
          source_refs: [],
          observations: recentEstablishedObservations,
        },
      }),
    );
    await saveInstinct(
      "proj-beta0002",
      makeInstinct("proj-beta0002", {
        confidence: 0.88,
        created_at: "2026-05-20T00:00:00.000Z",
        source: {
          first_session: "proj-beta0002-sess-1",
          first_observed_at: "2026-05-20T00:00:00.000Z",
          source_refs: [],
          observations: recentEstablishedObservations,
        },
      }),
    );

    const entries = await detectPromotionCandidates(fixedNow);
    assert.equal(entries.length, 0);
  });
});

// U4 review regression: the eligibility replay must start from the instinct's
// persisted confidence_floor. These three observations reach `established` at
// obs2 (2026-06-01) when floored at 0.7 — clearing the 14-day age gate against
// fixedNow — but only at obs3 (2026-06-20) when floored at the 0.5 default,
// which lands 5 days out and is rejected. Same observations, floor flips it.
const floorSensitiveObservations = [
  { session: "sess-1", reinforcing: true, at: "2026-05-20T00:00:00.000Z" },
  { session: "sess-2", reinforcing: true, at: "2026-06-01T00:00:00.000Z" },
  { session: "sess-3", reinforcing: true, at: "2026-06-20T00:00:00.000Z" },
];

function makeFloorSensitiveInstinct(projectId, confidence, confidenceFloor) {
  return makeInstinct(projectId, {
    confidence,
    confidence_floor: confidenceFloor,
    created_at: "2026-05-20T00:00:00.000Z",
    source: {
      first_session: `${projectId}-sess-1`,
      first_observed_at: "2026-05-20T00:00:00.000Z",
      source_refs: [],
      observations: floorSensitiveObservations,
    },
  });
}

test("detectPromotionCandidates honors a high confidence_floor when timing eligibility", async () => {
  await withRuntime(async () => {
    await saveInstinct("proj-alpha001", makeFloorSensitiveInstinct("proj-alpha001", 0.82, 0.7));
    await saveInstinct("proj-beta0002", makeFloorSensitiveInstinct("proj-beta0002", 0.9, 0.7));

    const entries = await detectPromotionCandidates(fixedNow);
    assert.equal(
      entries.length,
      1,
      "floor 0.7 reaches established at obs2 and clears the 14-day age gate",
    );
  });
});

test("detectPromotionCandidates with the default 0.5 floor rejects the same observations", async () => {
  await withRuntime(async () => {
    await saveInstinct("proj-alpha001", makeFloorSensitiveInstinct("proj-alpha001", 0.82, 0.5));
    await saveInstinct("proj-beta0002", makeFloorSensitiveInstinct("proj-beta0002", 0.9, 0.5));

    const entries = await detectPromotionCandidates(fixedNow);
    assert.equal(
      entries.length,
      0,
      "floor 0.5 only reaches established at obs3, inside the 14d gate",
    );
  });
});

test("detectPromotionCandidates skips instincts that do not meet ADR-0006 thresholds", async () => {
  await withRuntime(async () => {
    await saveInstinct("proj-alpha001", makeInstinct("proj-alpha001", { confidence: 0.79 }));
    await saveInstinct("proj-beta0002", makeInstinct("proj-beta0002", { confidence: 0.8 }));

    const entries = await detectPromotionCandidates(fixedNow);
    assert.equal(entries.length, 0);
  });
});

test("refreshPromotionQueue writes the candidate queue for promote review", async () => {
  await withRuntime(async () => {
    await saveInstinct("proj-alpha001", makeInstinct("proj-alpha001", { confidence: 0.85 }));
    await saveInstinct("proj-beta0002", makeInstinct("proj-beta0002", { confidence: 0.87 }));

    const written = await refreshPromotionQueue(fixedNow);
    const entries = await readPromotionQueue();

    assert.equal(written.length, 1);
    assert.deepEqual(entries, written);
  });
});

test("syncReviewedLearningsToInstinctStore leaves queue refresh to the apply batch", async () => {
  await withRuntime(async () => {
    await saveInstinct("proj-alpha001", makeInstinct("proj-alpha001", { confidence: 0.85 }));
    await saveInstinct("proj-beta0002", makeInstinct("proj-beta0002", { confidence: 0.87 }));
    assert.deepEqual(await readPromotionQueue(), []);

    const session = {
      ...structuredClone(sourceSessionFixture),
      source_tool: "claude-code",
      source_path: "/tmp/claude/session.jsonl",
      workspace_path: null,
      project_key: "sync-refresh-test",
      session_id: "sync-refresh-session",
      conversation_id: "sync-refresh-conversation",
      started_at: "2026-06-24T10:00:00Z",
      updated_at: "2026-06-24T10:05:00Z",
    };
    const learning = makeReviewedLearning(session, "learning-sync-refresh");

    const result = await syncReviewedLearningsToInstinctStore({
      session,
      learnings: [learning],
      sourceAdapter: "claude-code",
      reviewedAt: fixedNow,
      reviewer: "test",
    });

    assert.equal(result.bundleWritten, true);
    assert.deepEqual(await readPromotionQueue(), []);
  });
});

test("apply-learning-review refreshes the promotion queue once after the batch", async () => {
  await withRuntime(async (runtimeRoot) => {
    const database = await createLedger();
    try {
      const sessions = [makeSourceSession("proj-alpha001"), makeSourceSession("proj-beta0002")];
      await saveInstinct("proj-alpha001", makeInstinct("proj-alpha001", { confidence: 0.85 }));
      await saveInstinct("proj-beta0002", makeInstinct("proj-beta0002", { confidence: 0.87 }));
      assert.deepEqual(await readPromotionQueue(), []);

      const sidecarEntries = [];
      for (const session of sessions) {
        upsertSourceSession(database, session);
        const learning = makeReviewedLearning(session, `${session.session_id}:learning-1`);
        await writeProjectLearning(session.project_key, session.session_id, learning);
        sidecarEntries.push({
          durability: "durable",
          keep: true,
          learning_id: learning.learning_id,
          reason: "Durable project rule.",
          scope_key: session.project_key,
          session_id: session.session_id,
          statement: learning.statement,
          suggested_statement: learning.statement,
          trigger: learning.trigger,
          verdict: "keep",
        });
      }

      const sidecarPath = join(runtimeRoot, "reports", "llm-learning-review.jsonl");
      await mkdir(dirname(sidecarPath), { recursive: true });
      await writeFile(
        sidecarPath,
        `${sidecarEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      );

      const exitCode = await executeQualityApplyLearningReview(
        {
          args: ["--input", sidecarPath],
          commandPath: ["quality", "apply-learning-review"],
          output: { error: () => {}, info: () => {} },
        },
        database,
      );

      assert.equal(exitCode, 0);
      const queue = await readPromotionQueue();
      assert.equal(queue.length, 1);
      assert.equal(queue[0].instinct_id, "prefer-pnpm-aaaaaaaa");
      assert.equal(queue[0].project_count, 2);
    } finally {
      database.close();
    }
  });
});

test("readPromotionQueue round-trips a schema-valid file", async () => {
  await withRuntime(async () => {
    await saveInstinct("proj-alpha001", makeInstinct("proj-alpha001", { confidence: 0.85 }));
    await saveInstinct("proj-beta0002", makeInstinct("proj-beta0002", { confidence: 0.87 }));

    const written = await refreshPromotionQueue(fixedNow);
    assert.deepEqual(await readPromotionQueue(), written);
  });
});

test("readPromotionQueue falls back to [] for malformed JSON", async () => {
  await withRuntime(async () => {
    await writeFile(getPromotionQueuePath(), "{ not valid json", "utf8");
    assert.deepEqual(await readPromotionQueue(), []);
  });
});

test("readPromotionQueue falls back to [] when an entry violates the schema", async () => {
  await withRuntime(async () => {
    // Well-formed JSON, but `domain` is not a known enum value and
    // numeric fields are the wrong type — zod must reject the whole queue.
    const corrupt = {
      entries: [
        {
          instinct_id: "x",
          trigger: "t",
          finding: "f",
          domain: "not-a-real-domain",
          detected_at: "2026-06-25T00:00:00.000Z",
          avg_confidence: "high",
          project_count: 2,
          projects: [],
          thresholds: { min_projects: 2, min_avg_confidence: 0.8, min_age_days: 14 },
        },
      ],
    };
    await writeFile(getPromotionQueuePath(), JSON.stringify(corrupt), "utf8");
    assert.deepEqual(await readPromotionQueue(), []);
  });
});

test("readPromotionQueue treats a missing entries key as an empty queue", async () => {
  await withRuntime(async () => {
    await writeFile(getPromotionQueuePath(), JSON.stringify({}), "utf8");
    assert.deepEqual(await readPromotionQueue(), []);
  });
});
