import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const runtimeOverrideEnvVar = "MARROW_ROOT";

/**
 * Isolates MARROW_ROOT (and optional extra env vars) for one test.
 * Required because node --test runs files in parallel and process.env is global.
 */
export async function withRuntimeRoot(run, options = {}) {
  const prefix = options.prefix ?? "marrow-runtime-";
  const sandboxBase = await mkdtemp(join(tmpdir(), prefix));
  const runtimeRoot = join(sandboxBase, "runtime-root");
  const extraEnvVars = options.extraEnvVars ?? [];
  const previous = new Map([
    [runtimeOverrideEnvVar, process.env[runtimeOverrideEnvVar]],
    ...extraEnvVars.map((key) => [key, process.env[key]]),
  ]);

  process.env[runtimeOverrideEnvVar] = runtimeRoot;
  if (options.clearExtraEnv) {
    for (const key of extraEnvVars) {
      delete process.env[key];
    }
  }

  try {
    await run(runtimeRoot);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }

    await rm(sandboxBase, { force: true, recursive: true });
  }
}
