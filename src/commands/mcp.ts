import type { CommandContext } from "../cli.js";
import {
  appendMcpUsageLog,
  instinctsForFile,
  recentInstincts,
  searchInstincts,
} from "../v2/mcp/query.js";
import { runMcpStdioServer } from "../v2/mcp/stdio-server.js";
import {
  instinctsForFileInputSchema,
  recentInstinctsInputSchema,
  searchInstinctsInputSchema,
} from "../v2/mcp/types.js";

export async function executeMcp(context: CommandContext): Promise<number> {
  const [toolName, ...args] = context.args;
  if (!toolName) {
    throw new Error(
      "mcp requires a tool name or serve: search_instincts, instincts_for_file, recent_instincts, or serve",
    );
  }
  const startedAt = Date.now();
  let resultCount = 0;
  let inputSizeChars = 0;
  try {
    if (toolName === "serve") {
      await runMcpStdioServer();
      return 0;
    }
    if (toolName === "search_instincts") {
      const input = searchInstinctsInputSchema.parse(parseKeyValueArgs(args));
      inputSizeChars = JSON.stringify(input).length;
      const result = await searchInstincts(input);
      resultCount = result.hits.length;
      context.output.info(JSON.stringify(result, null, 2));
      return 0;
    }
    if (toolName === "instincts_for_file") {
      const input = instinctsForFileInputSchema.parse(parseKeyValueArgs(args));
      inputSizeChars = JSON.stringify(input).length;
      const result = await instinctsForFile(input);
      resultCount = result.exact_hits.length + result.proximal_hits.length;
      context.output.info(JSON.stringify(result, null, 2));
      return 0;
    }
    if (toolName === "recent_instincts") {
      const input = recentInstinctsInputSchema.parse(parseKeyValueArgs(args));
      inputSizeChars = JSON.stringify(input).length;
      const result = await recentInstincts(input);
      resultCount = result.hits.length;
      context.output.info(JSON.stringify(result, null, 2));
      return 0;
    }
    throw new Error(`Unknown mcp tool: ${toolName}`);
  } finally {
    if (
      toolName === "search_instincts" ||
      toolName === "instincts_for_file" ||
      toolName === "recent_instincts"
    ) {
      await appendMcpUsageLog({
        tool: toolName,
        ts: new Date().toISOString(),
        input_size_chars: inputSizeChars,
        result_count: resultCount,
        duration_ms: Date.now() - startedAt,
      });
    }
  }
}

function parseKeyValueArgs(args: string[]): Record<string, unknown> {
  const parsed: Record<string, unknown> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg?.startsWith("--")) {
      throw new Error(`Expected flag, got: ${arg}`);
    }
    const key = arg.slice(2).replace(/-/g, "_");
    const next = args[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
      continue;
    }
    parsed[key] = coerceValue(next);
    index += 1;
  }
  return parsed;
}

function coerceValue(value: string): unknown {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  if (/^-?\d+$/u.test(value)) {
    return Number.parseInt(value, 10);
  }
  return value;
}
