#!/usr/bin/env node
import { readdir, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLedger } from "../dist/db/ledger.js";

const CODEX_SESSIONS_ROOT = join(homedir(), ".codex", "sessions", "2026");
const CODEX_ARCHIVED_ROOT = join(homedir(), ".codex", "archived_sessions");

async function findSourceFile(sessionId) {
  // rollout-YYYY-MM-DDTHH-MM-SS-uuid.jsonl → YYYY/MM/DD
  const year = sessionId.slice(8, 12);
  const month = sessionId.slice(13, 15);
  const day = sessionId.slice(16, 18);
  const patterns = [
    join(CODEX_SESSIONS_ROOT, year, month, day, `${sessionId}.jsonl`),
    join(CODEX_ARCHIVED_ROOT, `${sessionId}.jsonl`),
  ];
  for (const p of patterns) {
    try {
      await stat(p);
      return p;
    } catch {
      /* not found */
    }
  }
  const archivedFiles = await readdir(CODEX_ARCHIVED_ROOT).catch(() => []);
  const match = archivedFiles.find((f) => f.includes(sessionId));
  if (match) return join(CODEX_ARCHIVED_ROOT, match);
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes("--apply");
  const db = await createLedger();
  const ready = db
    .prepare(
      `SELECT dc.session_id, ss.source_tool, dc.candidate_state, dc.reason
       FROM deletion_candidates dc
       JOIN source_sessions ss ON dc.source_session_id = ss.id
       WHERE (dc.candidate_state = 'ready' OR dc.candidate_state = 'discardable_no_signal')
         AND dc.safe_to_delete = 1
         AND ss.source_tool = 'codex-cli'`,
    )
    .all();

  console.log(`Found ${ready.length} codex-cli sessions ready for source deletion`);
  if (dryRun) console.log("(dry run — pass --apply to actually delete)\n");

  let totalBytes = 0;
  let foundCount = 0;
  let missingCount = 0;
  const toDelete = [];

  for (const candidate of ready) {
    const sourcePath = await findSourceFile(candidate.session_id);
    if (!sourcePath) {
      missingCount++;
      continue;
    }
    const { size } = await stat(sourcePath);
    totalBytes += size;
    foundCount++;
    toDelete.push({ sessionId: candidate.session_id, path: sourcePath, size });
  }

  console.log(`Source files found: ${foundCount}`);
  console.log(`Source files missing: ${missingCount}`);
  console.log(`Total reclaimable: ${(totalBytes / (1024 * 1024)).toFixed(1)} MB\n`);

  if (!dryRun) {
    console.log("Deleting source files...");
    let deleted = 0;
    for (const { sessionId, path } of toDelete) {
      try {
        await unlink(path);
        deleted++;
      } catch (e) {
        console.error(`Failed to delete ${sessionId}: ${e.message}`);
      }
    }
    console.log(`Deleted ${deleted} source files.`);
  } else {
    console.log("First 10 files that would be deleted:");
    for (const { sessionId, path, size } of toDelete.slice(0, 10)) {
      console.log(`  ${sessionId} (${(size / 1024).toFixed(1)} KB) → ${path}`);
    }
    if (toDelete.length > 10) {
      console.log(`  ... and ${toDelete.length - 10} more`);
    }
  }

  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
