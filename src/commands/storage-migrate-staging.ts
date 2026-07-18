import type { CommandContext } from "../cli.js";
import { runStagingMigration } from "../pipeline/staging-migration.js";

export type StorageMigrateStagingOptions = {
  apply: boolean;
  to: string;
};

export async function executeStorageMigrateStaging(context: CommandContext): Promise<number> {
  const options = parseStorageMigrateStagingOptions(context.args);
  const result = await runStagingMigration(options);
  context.output.info(JSON.stringify(result, null, 2));
  return 0;
}

export function parseStorageMigrateStagingOptions(
  args: readonly string[],
): StorageMigrateStagingOptions {
  let apply = false;
  let to: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--apply") {
      apply = true;
      continue;
    }
    if (argument === "--to") {
      const value = args[index + 1];
      if (value === undefined || value.length === 0) {
        throw new Error("storage migrate-staging --to requires a path");
      }
      to = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown storage migrate-staging option: ${argument ?? ""}`);
  }
  if (to === undefined) {
    throw new Error("storage migrate-staging requires --to <absolute-path>");
  }
  return { apply, to };
}
