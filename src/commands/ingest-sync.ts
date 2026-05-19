import type { DatabaseSync } from "node:sqlite";

import type { CommandContext } from "../cli.js";
import { runDiscoverPhase } from "../pipeline/discover.js";
import { parseIngestOptions, processDiscoveredSessions } from "./ingest-backfill.js";

export async function executeIngestSync(context: CommandContext, database: DatabaseSync): Promise<number> {
  const options = parseIngestOptions(context.args);
  const discovery = await runDiscoverPhase({
    database,
    ...(options.excludePaths.length > 0 ? { excludePaths: options.excludePaths } : {}),
    ...(options.excludeProjectKeys.length > 0
      ? { excludeProjectKeys: options.excludeProjectKeys }
      : {}),
    ...(options.includeTestSessions ? { includeTestSessions: true } : {}),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    onlyNewOrChanged: true,
    ...(options.since === undefined ? {} : { since: options.since }),
    source: options.source
  });
  const sessions = await processDiscoveredSessions(database, discovery.sessions, options.resume);

  context.output.info(
    JSON.stringify(
      {
        discovered_count: discovery.discoveredCount,
        mode: "incremental",
        processed_count: sessions.length,
        selected_count: discovery.selectedCount,
        sessions,
        source: options.source
      },
      null,
      2
    )
  );

  return 0;
}
