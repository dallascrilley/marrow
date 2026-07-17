#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(projectRoot, "dist", "cli.js");

console.error(
  "Deprecated: cleanup-codex-sources now delegates to the verified raw-archive workflow.",
);

const child = spawn(
  process.execPath,
  [cliPath, "delete", "sources", "--source", "codex-cli", ...process.argv.slice(2)],
  { stdio: "inherit" },
);

child.once("exit", (code) => process.exit(code ?? 1));
child.once("error", (error) => {
  console.error(`Failed to launch the distillery CLI: ${error.message}`);
  process.exit(1);
});
