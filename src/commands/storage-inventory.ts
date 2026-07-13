import type { DatabaseSync } from "node:sqlite";

import type { CommandContext } from "../cli.js";
import {
  isRuntimeInventoryLifecycleState,
  listRuntimeLifecycleInventory,
  type RuntimeInventoryLifecycleState,
  renderRuntimeLifecycleInventory,
} from "../read/lifecycle-inventory.js";

type StorageInventoryOptions = {
  json: boolean;
  olderThanDays: number | undefined;
  state: RuntimeInventoryLifecycleState | undefined;
};

export async function executeStorageInventory(
  context: CommandContext,
  database: DatabaseSync,
): Promise<number> {
  const options = parseStorageInventoryOptions(context.args);
  const report = await listRuntimeLifecycleInventory(database, {
    ...(options.olderThanDays === undefined ? {} : { olderThanDays: options.olderThanDays }),
    ...(options.state === undefined ? {} : { state: options.state }),
  });

  context.output.info(
    options.json ? JSON.stringify(report, null, 2) : renderRuntimeLifecycleInventory(report),
  );
  return 0;
}

function parseStorageInventoryOptions(args: readonly string[]): StorageInventoryOptions {
  let json = false;
  let olderThanDays: number | undefined;
  let state: RuntimeInventoryLifecycleState | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) {
      continue;
    }

    if (argument === "--json") {
      json = true;
      continue;
    }

    if (argument === "--older-than-days") {
      const value = args[index + 1];
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error("storage inventory --older-than-days requires a non-negative integer");
      }
      olderThanDays = parsed;
      index += 1;
      continue;
    }

    if (argument === "--state") {
      const value = args[index + 1];
      if (value === undefined || !isRuntimeInventoryLifecycleState(value)) {
        throw new Error(
          `storage inventory --state requires a lifecycle state, received: ${value ?? ""}`,
        );
      }
      state = value;
      index += 1;
      continue;
    }

    if (argument.startsWith("--")) {
      throw new Error(`Unknown storage inventory flag: ${argument}`);
    }

    throw new Error(`Unexpected storage inventory argument: ${argument}`);
  }

  return { json, olderThanDays, state };
}
