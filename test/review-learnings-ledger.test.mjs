import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { executeQualityReviewLearnings } from "../dist/commands/quality-review-learnings.js";
import { createLedger, upsertSourceSession } from "../dist/db/ledger.js";
import { learningFixture, sourceSessionFixture } from "../dist/models/canonical.js";
import { getProjectKnowledgeSessionPath } from "../dist/writers/knowledge-writer.js";

const runtimeOverrideEnvVar = "AGENT_SESSION_DISTILLERY_ROOT";

async function withRuntimeRoot(run) {
  const sandboxBase = await mkdtemp(join(tmpdir(), "asd-review-ledger-"));
  const runtimeRoot = join(sandboxBase, "runtime-root");
  const previousOverride = process.env[runtimeOverrideEnvVar];
  const previousKey = process.env.OPENROUTER_API_KEY;

  process.env[runtimeOverrideEnvVar] = runtimeRoot;
  process.env.OPENROUTER_API_KEY = "test-key";

  try {
    await run(runtimeRoot);
  } finally {
    if (previousOverride === undefined) {
      delete process.env[runtimeOverrideEnvVar];
    } else {
      process.env[runtimeOverrideEnvVar] = previousOverride;
    }
    if (previousKey === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = previousKey;
    }

    await rm(sandboxBase, { force: true, recursive: true });
  }
}

function makeSession(index) {
  return {
    ...sourceSessionFixture,
    project_key: "agent-session-distillery",
    session_id: `ledger-session-${index}`,
    conversation_id: `ledger-conversation-${index}`,
    source_path: `/tmp/ledger-session-${index}.jsonl`,
    source_hash: `sha256:ledger-session-${index}`,
    updated_at: `2026-05-16T08:3${index}:00Z`,
  };
}

function makeLearning(session, index) {
  return {
    ...learningFixture,
    learning_id: `${session.session_id}:learning-${index}`,
    scope_key: session.project_key,
    statement: `Use durable ledger regression learning ${session.session_id} number ${index}.`,
    source_refs: learningFixture.source_refs.map((sourceRef) => ({
      ...sourceRef,
      session_id: session.session_id,
      source_hash: session.source_hash,
      source_path: session.source_path,
    })),
  };
}

test("review-learnings excludes ledgered ids before caps and appends all verdicts", async () => {
  await withRuntimeRoot(async (runtimeRoot) => {
    const database = await createLedger();
    const messages = [];
    const previousFetch = globalThis.fetch;
    const requestedIds = [];

    try {
      const sessions = [makeSession(1), makeSession(2)];
      for (const session of sessions) {
        upsertSourceSession(database, session);
        const learningPath = getProjectKnowledgeSessionPath(
          session.project_key,
          session.session_id,
        );
        await mkdir(dirname(learningPath), { recursive: true });
        await writeFile(
          learningPath,
          `${[1, 2, 3].map((index) => JSON.stringify(makeLearning(session, index))).join("\n")}\n`,
          "utf8",
        );
      }

      const ledgerPath = join(runtimeRoot, "reports", "llm-learning-review-ledger.jsonl");
      await mkdir(dirname(ledgerPath), { recursive: true });
      await writeFile(
        ledgerPath,
        `${JSON.stringify({
          learning_id: "ledger-session-1:learning-1",
          verdict: "keep",
          reviewed_at: "2026-07-06T00:00:00.000Z",
          session_id: "ledger-session-1",
        })}\n${JSON.stringify({
          learning_id: "ledger-session-1:learning-2",
          verdict: "rewrite",
          reviewed_at: "2026-07-06T00:00:01.000Z",
          session_id: "ledger-session-1",
        })}\n`,
        "utf8",
      );

      globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(String(init.body));
        const userMessage = body.messages.find((message) => message.role === "user");
        const payload = JSON.parse(userMessage.content);
        const ids = payload.learnings.map((learning) => learning.id);
        requestedIds.push(...ids);

        return {
          ok: true,
          status: 200,
          async json() {
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      reviews: ids.map((id) => {
                        const rejected = id === "ledger-session-2:learning-1";
                        return {
                          id,
                          durability: rejected ? "transient" : "durable",
                          keep: !rejected,
                          reason: `Reviewed ${id}.`,
                          statement: `Reviewed statement for ${id}.`,
                          trigger: `When applying reviewed trigger for ${id}.`,
                          verdict: rejected ? "reject" : "rewrite",
                        };
                      }),
                    }),
                  },
                },
              ],
              usage: {
                prompt_tokens: 100,
                completion_tokens: 20,
                total_tokens: 120,
                cost: 0.00042,
              },
            };
          },
          async text() {
            return "";
          },
        };
      };

      const exitCode = await executeQualityReviewLearnings(
        {
          args: ["--no-cache", "--max-total-learnings", "2"],
          commandPath: ["quality", "review-learnings"],
          output: {
            error: (message) => messages.push(message),
            info: (message) => messages.push(message),
          },
        },
        database,
      );

      assert.equal(exitCode, 0);
      assert.deepEqual(requestedIds, [
        "ledger-session-1:learning-3",
        "ledger-session-2:learning-1",
      ]);

      const payload = JSON.parse(messages.find((message) => message.includes('"count"')));
      assert.equal(payload.generated_batch, true);
      assert.match(payload.batch_id, /^sha256:[a-f0-9]{64}$/);
      const batch = JSON.parse(await readFile(payload.batch_path, "utf8"));
      assert.equal(batch.status, "generated");

      const latestPointer = JSON.parse(await readFile(payload.latest_pointer, "utf8"));
      assert.equal(latestPointer.batch_id, payload.batch_id);
      assert.equal(latestPointer.batch_path, payload.batch_path);
      assert.deepEqual(
        batch.reviews.map((entry) => entry.learning_id),
        ["ledger-session-1:learning-3", "ledger-session-2:learning-1"],
      );
      assert.equal(
        batch.reviews[0].trigger,
        "When applying reviewed trigger for ledger-session-1:learning-3.",
      );
      assert.deepEqual(batch.source_ledger_watermark, {
        entry_count: 2,
        last_learning_id: "ledger-session-1:learning-2",
        last_reviewed_at: "2026-07-06T00:00:01.000Z",
      });

      const ledgerLines = (await readFile(ledgerPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.deepEqual(
        ledgerLines.map((entry) => entry.learning_id),
        [
          "ledger-session-1:learning-1",
          "ledger-session-1:learning-2",
          "ledger-session-1:learning-3",
          "ledger-session-2:learning-1",
        ],
      );
      assert.equal(ledgerLines.at(-1).verdict, "reject");
      assert.equal(ledgerLines.at(-1).session_id, "ledger-session-2");
      assert.match(ledgerLines.at(-1).reviewed_at, /^\d{4}-\d{2}-\d{2}T/);
      const appendedLedgerLines = ledgerLines.slice(-2);
      assert.deepEqual(
        appendedLedgerLines.map((entry) => entry.batch_id),
        [payload.batch_id, payload.batch_id],
      );
      assert.deepEqual(
        appendedLedgerLines.map((entry) => entry.reviewed_at),
        [batch.created_at, batch.created_at],
      );

      assert.equal(payload.count, 2);
      assert.equal(payload.rejected, 1);
      assert.equal(payload.total_reviewed_learnings, 2);
    } finally {
      globalThis.fetch = previousFetch;
      database.close();
    }
  });
});

test("review-learnings recovers a published batch after the reviewed-id append fails", async () => {
  await withRuntimeRoot(async (runtimeRoot) => {
    const database = await createLedger();
    const messages = [];
    const previousFetch = globalThis.fetch;
    let fetchCount = 0;

    try {
      const session = makeSession(3);
      upsertSourceSession(database, session);
      const learningPath = getProjectKnowledgeSessionPath(session.project_key, session.session_id);
      await mkdir(dirname(learningPath), { recursive: true });
      await writeFile(learningPath, `${JSON.stringify(makeLearning(session, 1))}\n`, "utf8");

      globalThis.fetch = async () => {
        fetchCount += 1;
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      reviews: [
                        {
                          id: `${session.session_id}:learning-1`,
                          durability: "durable",
                          keep: true,
                          reason: "Durable recovery guidance.",
                          statement: "Use the recovered review batch.",
                          trigger: "When a reviewed-id append fails after batch publication.",
                          verdict: "rewrite",
                        },
                      ],
                    }),
                  },
                },
              ],
              usage: {
                prompt_tokens: 100,
                completion_tokens: 20,
                total_tokens: 120,
                cost: 0.00042,
              },
            };
          },
          async text() {
            return "";
          },
        };
      };

      await assert.rejects(
        executeQualityReviewLearnings(
          {
            args: ["--no-cache", "--max-total-learnings", "1"],
            commandPath: ["quality", "review-learnings"],
            output: {
              error: (message) => messages.push(message),
              info: (message) => messages.push(message),
            },
          },
          database,
          {
            appendLedgerEntries: async () => {
              throw new Error("injected reviewed-id append failure");
            },
          },
        ),
        /injected reviewed-id append failure/,
      );

      const batchDir = join(runtimeRoot, "reports", "llm-learning-review-batches");
      assert.equal((await readdir(batchDir)).length, 1);

      const retryMessages = [];
      const retryExitCode = await executeQualityReviewLearnings(
        {
          args: ["--no-cache", "--max-total-learnings", "1"],
          commandPath: ["quality", "review-learnings"],
          output: {
            error: (message) => retryMessages.push(message),
            info: (message) => retryMessages.push(message),
          },
        },
        database,
      );

      assert.equal(retryExitCode, 0);
      assert.equal(fetchCount, 1, "retry reuses the paid batch instead of calling the provider");
      const ledgerLines = (
        await readFile(join(runtimeRoot, "reports", "llm-learning-review-ledger.jsonl"), "utf8")
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.deepEqual(
        ledgerLines.map((entry) => entry.learning_id),
        [`${session.session_id}:learning-1`],
      );
      assert.equal((await readdir(batchDir)).length, 1);

      const budget = JSON.parse(
        await readFile(join(runtimeRoot, "reports", "llm-budget.json"), "utf8"),
      );
      assert.equal(budget.uses.length, 1);
      assert.match(budget.uses[0].id, /^sha256:[a-f0-9]{64}$/);
    } finally {
      globalThis.fetch = previousFetch;
      database.close();
    }
  });
});

test("review-learnings leaves paid work pending when immutable batch publication fails", async () => {
  await withRuntimeRoot(async (runtimeRoot) => {
    const database = await createLedger();
    const previousFetch = globalThis.fetch;
    let fetchCount = 0;

    try {
      const session = makeSession(4);
      upsertSourceSession(database, session);
      const learningPath = getProjectKnowledgeSessionPath(session.project_key, session.session_id);
      await mkdir(dirname(learningPath), { recursive: true });
      await writeFile(learningPath, `${JSON.stringify(makeLearning(session, 1))}\n`, "utf8");

      globalThis.fetch = async () => {
        fetchCount += 1;
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      reviews: [
                        {
                          id: `${session.session_id}:learning-1`,
                          durability: "durable",
                          keep: true,
                          reason: "Durable publication guidance.",
                          statement: "Retry review when publication never became durable.",
                          trigger: "When immutable batch publication fails.",
                          verdict: "rewrite",
                        },
                      ],
                    }),
                  },
                },
              ],
              usage: {
                prompt_tokens: 100,
                completion_tokens: 20,
                total_tokens: 120,
                cost: 0.00042,
              },
            };
          },
          async text() {
            return "";
          },
        };
      };

      await assert.rejects(
        executeQualityReviewLearnings(
          {
            args: ["--no-cache", "--max-total-learnings", "1"],
            commandPath: ["quality", "review-learnings"],
            output: { error: () => {}, info: () => {} },
          },
          database,
          {
            writeBatch: async () => {
              throw new Error("injected immutable batch publication failure");
            },
          },
        ),
        /injected immutable batch publication failure/,
      );

      await assert.rejects(
        readFile(join(runtimeRoot, "reports", "llm-learning-review-ledger.jsonl"), "utf8"),
        (error) => error?.code === "ENOENT",
      );
      await assert.rejects(
        readFile(join(runtimeRoot, "reports", "llm-budget.json"), "utf8"),
        (error) => error?.code === "ENOENT",
      );

      await executeQualityReviewLearnings(
        {
          args: ["--no-cache", "--max-total-learnings", "1"],
          commandPath: ["quality", "review-learnings"],
          output: { error: () => {}, info: () => {} },
        },
        database,
      );
      assert.equal(fetchCount, 2, "non-durable provider result is retried");
    } finally {
      globalThis.fetch = previousFetch;
      database.close();
    }
  });
});
