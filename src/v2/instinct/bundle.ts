import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { projectSessionsDir } from "../project/resolve.js";
import { applyDeltas, finalizeInstinct, type InstinctMap } from "./apply-delta.js";
import type { SessionBundle } from "./schema.js";
import { parseSessionBundleYaml, serializeSessionBundle } from "./yaml-io.js";

export function sessionBundlePath(
  projectId: string,
  sessionId: string,
): string {
  return join(projectSessionsDir(projectId), `${sessionId}.yaml`);
}

export async function saveSessionBundle(bundle: SessionBundle): Promise<void> {
  await mkdir(projectSessionsDir(bundle.project_id), { recursive: true });
  const target = sessionBundlePath(bundle.project_id, bundle.session_id);
  const temp = `${target}.tmp`;
  await writeFile(temp, serializeSessionBundle(bundle), "utf8");
  await rename(temp, target);
}

export async function loadSessionBundle(
  projectId: string,
  sessionId: string,
): Promise<SessionBundle | null> {
  try {
    const contents = await readFile(
      sessionBundlePath(projectId, sessionId),
      "utf8",
    );
    return parseSessionBundleYaml(contents);
  } catch {
    return null;
  }
}

export async function listSessionBundleIds(
  projectId: string,
): Promise<string[]> {
  try {
    const entries = await readdir(projectSessionsDir(projectId));
    return entries
      .filter((name) => name.endsWith(".yaml"))
      .map((name) => name.replace(/\.yaml$/u, ""));
  } catch {
    return [];
  }
}

export async function loadAllSessionBundles(
  projectId: string,
): Promise<SessionBundle[]> {
  const bundles: SessionBundle[] = [];
  for (const sessionId of await listSessionBundleIds(projectId)) {
    const bundle = await loadSessionBundle(projectId, sessionId);
    if (bundle) {
      bundles.push(bundle);
    }
  }
  return bundles.sort((left, right) =>
    left.ingested_at.localeCompare(right.ingested_at),
  );
}

export async function replayBundles(projectId: string): Promise<InstinctMap> {
  const bundles = await loadAllSessionBundles(projectId);
  let instincts: InstinctMap = new Map();
  let latestNow = "1970-01-01T00:00:00.000Z";

  for (const bundle of bundles) {
    const bundleNow = bundle.reviewed_at ?? bundle.ingested_at;
    if (bundleNow > latestNow) {
      latestNow = bundleNow;
    }
    instincts = applyDeltas(instincts, bundle.deltas, {
      now: bundleNow,
      sessionId: bundle.session_id,
    });
  }

  for (const [id, instinct] of instincts) {
    instincts.set(id, finalizeInstinct(instinct, projectId, latestNow));
  }

  return instincts;
}
