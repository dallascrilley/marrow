import type { CursorTrackingDbEnrichment } from "./intermediate.js";
import { collectAttribution, readCursorKvRowsReadOnly } from "./sqlite-enrichment.js";

export type EnrichCursorTrackingDbOptions = {
  databasePath: string;
};

export function enrichCursorTrackingDb(
  options: EnrichCursorTrackingDbOptions,
): CursorTrackingDbEnrichment | null {
  try {
    const attribution = collectAttribution(readCursorKvRowsReadOnly(options.databasePath));

    return {
      activeComposerIds: [...attribution.activeComposerIds],
      matchedKeys: attribution.matchedKeys,
      requestIds: [...attribution.requestIds],
      sessionIds: [...attribution.sessionIds],
      workspaceIds: [...attribution.workspaceIds],
      workspacePaths: [...attribution.workspacePaths],
      workspaceStorageIds: [...attribution.workspaceStorageIds],
    };
  } catch {
    return null;
  }
}
