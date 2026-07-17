import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildEmuloCorpusExport,
  emuloCorpusSchemaVersion,
  emuloMessageSchemaVersion,
} from "../dist/commands/profile-export-emulo.js";
import { runtimeRootOverrideEnvVar } from "../dist/config/paths.js";
import { createLedger, transitionPhase, upsertSourceSession } from "../dist/db/ledger.js";

function sourceSession(sessionId, sourceTool, updatedAt) {
  return {
    conversation_id: `project:${sessionId}`,
    ingest_status: "archived",
    project_key: "project",
    retention_status: "archived",
    session_id: sessionId,
    source_format: `${sourceTool}-jsonl`,
    source_hash: `sha256:${sessionId}`,
    source_path: `/private/${sessionId}.jsonl`,
    source_tool: sourceTool,
    started_at: updatedAt,
    updated_at: updatedAt,
    workspace_path: "/private/project",
  };
}

function turn(sessionId, index, prompt, startedAt) {
  return {
    assistant_summary: "Private assistant prose that must never be exported.",
    commands_seen: [],
    ended_at: startedAt,
    files_touched: [],
    index,
    session_id: sessionId,
    started_at: startedAt,
    tool_stub_count: 0,
    turn_id: `${sessionId}:turn-${String(index).padStart(4, "0")}`,
    user_prompt: prompt,
    verification_seen: false,
  };
}

async function withFixture(run) {
  const sandbox = await mkdtemp(join(tmpdir(), "asd-emulo-export-"));
  const runtimeRoot = join(sandbox, "runtime");
  process.env[runtimeRootOverrideEnvVar] = runtimeRoot;
  const database = await createLedger();

  try {
    await run({ database, runtimeRoot });
  } finally {
    database.close();
    delete process.env[runtimeRootOverrideEnvVar];
    await rm(sandbox, { force: true, recursive: true });
  }
}

async function seedReducedArtifact(runtimeRoot, source, turns, checkpointHash) {
  const upserted = upsertSourceSession(source.database, source.session);
  transitionPhase(source.database, {
    phaseName: "reduced",
    phaseState: "completed",
    sourceHash: checkpointHash ?? source.session.source_hash,
    sourceSessionId: upserted.sourceSession.id,
  });
  const artifactDirectory = join(runtimeRoot, "staging", source.session.session_id);
  await mkdir(artifactDirectory, { recursive: true });
  await writeFile(
    join(artifactDirectory, "reduced-session.json"),
    `${JSON.stringify({ events: [], turns }, null, 2)}\n`,
    "utf8",
  );
}

async function readExportedRecords(generationRoot) {
  const sessionsRoot = join(generationRoot, "sessions");
  const sourceDirectories = await readdir(sessionsRoot);
  const records = [];

  for (const sourceDirectory of sourceDirectories.sort()) {
    const files = await readdir(join(sessionsRoot, sourceDirectory));
    for (const file of files.sort()) {
      const contents = await readFile(join(sessionsRoot, sourceDirectory, file), "utf8");
      records.push(
        ...contents
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      );
    }
  }

  return records;
}

test("buildEmuloCorpusExport writes only canonical user prompts with ASD provenance", async () => {
  await withFixture(async ({ database, runtimeRoot }) => {
    const codex = sourceSession("codex-session", "codex-cli", "2026-07-16T10:00:00.000Z");
    const claude = sourceSession("claude-session", "claude-code", "2026-07-17T11:00:00.000Z");

    await seedReducedArtifact(runtimeRoot, { database, session: claude }, [
      turn(
        claude.session_id,
        0,
        "<attached_files>secret context</attached_files><user_query>Keep the change narrow.</user_query>",
        claude.started_at,
      ),
      turn(
        claude.session_id,
        1,
        "You are an automated reviewer. Your task is to output only valid JSON.",
        "2026-07-17T11:01:00.000Z",
      ),
    ]);
    await seedReducedArtifact(runtimeRoot, { database, session: codex }, [
      turn(codex.session_id, 0, "Run the proof before calling it done.", codex.started_at),
      turn(codex.session_id, 1, "Now explain the result briefly.", "2026-07-16T10:05:00.000Z"),
    ]);

    const result = await buildEmuloCorpusExport(database);
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    const records = await readExportedRecords(result.generationRoot);

    assert.equal(manifest.schema_version, emuloCorpusSchemaVersion);
    assert.equal(manifest.generated_at, claude.updated_at);
    assert.equal(manifest.session_count, 2);
    assert.equal(manifest.message_count, 3);
    assert.deepEqual(manifest.skipped_sessions, []);
    assert.deepEqual(
      records.map((record) => record.text),
      [
        "Keep the change narrow.",
        "Run the proof before calling it done.",
        "Now explain the result briefly.",
      ],
    );
    assert.equal(
      records.every((record) => record.schema_version === emuloMessageSchemaVersion),
      true,
    );
    assert.equal(
      records.every((record) => record.type === "asd.user_message"),
      true,
    );
    assert.equal(
      records.some((record) => JSON.stringify(record).includes("assistant prose")),
      false,
    );
    assert.deepEqual(
      records.map((record) => record.source_tool),
      ["claude-code", "codex-cli", "codex-cli"],
    );
  });
});

test("buildEmuloCorpusExport is deterministic and reports sessions without reduced artifacts", async () => {
  await withFixture(async ({ database, runtimeRoot }) => {
    const available = sourceSession("available", "pi", "2026-07-17T12:00:00.000Z");
    const missing = sourceSession("missing", "kimi", "2026-07-17T13:00:00.000Z");
    await seedReducedArtifact(runtimeRoot, { database, session: available }, [
      turn(
        available.session_id,
        0,
        "Prefer the smallest maintainable change.",
        available.started_at,
      ),
    ]);
    const missingUpsert = upsertSourceSession(database, missing);
    transitionPhase(database, {
      phaseName: "reduced",
      phaseState: "completed",
      sourceHash: missing.source_hash,
      sourceSessionId: missingUpsert.sourceSession.id,
    });

    const first = await buildEmuloCorpusExport(database);
    const firstManifest = await readFile(first.manifestPath, "utf8");
    const firstRecords = await readExportedRecords(first.generationRoot);
    const firstPointer = await readFile(first.pointerPath, "utf8");
    const second = await buildEmuloCorpusExport(database);
    const secondManifest = await readFile(second.manifestPath, "utf8");
    const secondRecords = await readExportedRecords(second.generationRoot);
    const secondPointer = await readFile(second.pointerPath, "utf8");

    assert.equal(secondManifest, firstManifest);
    assert.deepEqual(secondRecords, firstRecords);
    assert.equal(second.generationRoot, first.generationRoot);
    assert.equal(secondPointer, firstPointer);
    assert.equal(JSON.parse(secondPointer).schema_version, "asd.emulo_pointer.v1");
    const manifest = JSON.parse(secondManifest);
    assert.deepEqual(manifest.skipped_sessions, [
      { reason: "reduced_artifact_missing", session_id: missing.session_id },
    ]);
  });
});

test("buildEmuloCorpusExport skips stale reduced checkpoints instead of mislabeling provenance", async () => {
  await withFixture(async ({ database, runtimeRoot }) => {
    const source = sourceSession("stale-session", "codex-cli", "2026-07-17T13:30:00.000Z");
    await seedReducedArtifact(
      runtimeRoot,
      { database, session: source },
      [
        turn(
          source.session_id,
          0,
          "This artifact belongs to an older revision.",
          source.started_at,
        ),
      ],
      "sha256:older-revision",
    );

    const result = await buildEmuloCorpusExport(database);

    assert.equal(result.manifest.session_count, 0);
    assert.deepEqual(result.manifest.skipped_sessions, [
      { reason: "reduced_checkpoint_missing_or_stale", session_id: source.session_id },
    ]);
  });
});

test("buildEmuloCorpusExport rejects duplicate ledger session ids", async () => {
  await withFixture(async ({ database, runtimeRoot }) => {
    const first = sourceSession("duplicate-session", "codex-cli", "2026-07-17T13:40:00.000Z");
    const second = {
      ...sourceSession("duplicate-session", "claude-code", "2026-07-17T13:41:00.000Z"),
      source_path: "/private/duplicate-session-claude.jsonl",
    };
    await seedReducedArtifact(runtimeRoot, { database, session: first }, [
      turn(first.session_id, 0, "First source.", first.started_at),
    ]);
    const secondUpsert = upsertSourceSession(database, second);
    transitionPhase(database, {
      phaseName: "reduced",
      phaseState: "completed",
      sourceHash: second.source_hash,
      sourceSessionId: secondUpsert.sourceSession.id,
    });

    await assert.rejects(
      buildEmuloCorpusExport(database),
      /duplicate ledger session_id cannot be exported safely: duplicate-session/i,
    );
  });
});

test("buildEmuloCorpusExport rejects reduced artifacts with mismatched session provenance", async () => {
  await withFixture(async ({ database, runtimeRoot }) => {
    const source = sourceSession("expected-session", "cursor", "2026-07-17T14:00:00.000Z");
    await seedReducedArtifact(runtimeRoot, { database, session: source }, [
      turn("wrong-session", 0, "This prompt has the wrong session id.", source.started_at),
    ]);

    await assert.rejects(
      buildEmuloCorpusExport(database),
      /reduced artifact session mismatch.*expected-session.*wrong-session/i,
    );
  });
});
