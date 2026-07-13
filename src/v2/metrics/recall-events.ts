import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { getRuntimePath } from "../../config/paths.js";

/** One line is appended per `asd recall` invocation. */
export type RecallEvent = {
  /** ISO-8601 fire time. */
  ts: string;
  /** Resolved project id the recall ran for. */
  project_id: string;
  /** Whether any curated memory was surfaced (false = fail-open empty). */
  delivered: boolean;
  /** Bytes emitted to stdout (0 when nothing delivered). */
  bytes: number;
  /** Number of memory sections (MEMORY.md + topic files) included. */
  sections: number;
};

export type RecallEventsSummary = {
  total_fires: number;
  fires_delivered: number;
  distinct_projects: number;
  last_delivered_at: string | null;
  last_fire_at: string | null;
};

export function getRecallEventsPath(): string {
  return join(getRuntimePath("reports"), "recall-events.jsonl");
}

/**
 * Append one recall event. Fail-open: recall must never break session start,
 * so a logging failure is swallowed.
 */
export async function appendRecallEvent(event: RecallEvent): Promise<void> {
  try {
    await mkdir(getRuntimePath("reports"), { recursive: true });
    await appendFile(getRecallEventsPath(), `${JSON.stringify(event)}\n`, "utf8");
  } catch {
    // Observability is best-effort; never surface to the caller.
  }
}

export async function summarizeRecallEvents(): Promise<RecallEventsSummary> {
  let contents: string;
  try {
    contents = await readFile(getRecallEventsPath(), "utf8");
  } catch {
    return {
      total_fires: 0,
      fires_delivered: 0,
      distinct_projects: 0,
      last_delivered_at: null,
      last_fire_at: null,
    };
  }

  const projects = new Set<string>();
  let total = 0;
  let delivered = 0;
  let lastDeliveredAt: string | null = null;
  let lastFireAt: string | null = null;

  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let event: Partial<RecallEvent>;
    try {
      event = JSON.parse(trimmed) as Partial<RecallEvent>;
    } catch {
      continue;
    }
    total += 1;
    if (event.delivered === true) {
      delivered += 1;
      if (
        typeof event.ts === "string" &&
        (lastDeliveredAt === null || event.ts > lastDeliveredAt)
      ) {
        lastDeliveredAt = event.ts;
      }
    }
    if (typeof event.project_id === "string") projects.add(event.project_id);
    if (typeof event.ts === "string" && (lastFireAt === null || event.ts > lastFireAt)) {
      lastFireAt = event.ts;
    }
  }

  return {
    total_fires: total,
    fires_delivered: delivered,
    distinct_projects: projects.size,
    last_delivered_at: lastDeliveredAt,
    last_fire_at: lastFireAt,
  };
}
