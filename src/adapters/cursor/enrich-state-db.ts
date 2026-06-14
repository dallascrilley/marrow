import type { CursorStateDbEnrichment } from "./intermediate.js";
import { collectAttribution, readCursorKvRowsReadOnly } from "./sqlite-enrichment.js";

export type EnrichCursorStateDbOptions = {
  databasePath: string;
};

export function enrichCursorStateDb(options: EnrichCursorStateDbOptions): CursorStateDbEnrichment {
  const attribution = collectAttribution(readCursorKvRowsReadOnly(options.databasePath));

  return {
    activeComposerIds: [...attribution.activeComposerIds],
    conversationIds: [...attribution.conversationIds],
    matchedKeys: attribution.matchedKeys,
    workspaceIds: [...attribution.workspaceIds],
    workspacePaths: [...attribution.workspacePaths],
  };
}
