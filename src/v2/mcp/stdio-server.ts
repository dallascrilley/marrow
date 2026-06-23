// Minimal JSON-RPC stdio MCP server exposing the 3 capped instinct tools.
// Line-delimited JSON-RPC over stdin/stdout; no external MCP SDK dependency.

import { ZodError, type ZodType } from "zod";
import { domains, maturityLevels, scopes } from "../instinct/schema.js";
import { appendMcpUsageLog, instinctsForFile, recentInstincts, searchInstincts } from "./query.js";
import {
  allTools,
  instinctsForFileInputSchema,
  type McpUsageLogEntry,
  recentInstinctsInputSchema,
  searchInstinctsInputSchema,
} from "./types.js";

export const MCP_PROTOCOL_VERSION = "2025-11-25";

const toolInputSchemas: Record<string, Record<string, unknown>> = {
  search_instincts: {
    type: "object",
    properties: {
      query: { type: "string" },
      scope: { type: "string", enum: scopes },
      project_id: { type: "string" },
      domain: { type: "string", enum: domains },
      min_maturity: { type: "string", enum: maturityLevels },
      limit: { type: "integer", minimum: 1, maximum: 20 },
    },
    required: ["query"],
    additionalProperties: false,
  },
  instincts_for_file: {
    type: "object",
    properties: {
      path: { type: "string" },
      project_id: { type: "string" },
      include_proximal: { type: "boolean" },
      limit: { type: "integer", minimum: 1, maximum: 20 },
    },
    required: ["path"],
    additionalProperties: false,
  },
  recent_instincts: {
    type: "object",
    properties: {
      window_days: { type: "integer", minimum: 1, maximum: 365 },
      scope: { type: "string", enum: scopes },
      project_id: { type: "string" },
      domain: { type: "string", enum: domains },
      only_new_or_changed: { type: "boolean" },
      limit: { type: "integer", minimum: 1, maximum: 50 },
    },
    additionalProperties: false,
  },
};

export type JsonRpcId = string | number;

export type JsonRpcMessage = {
  jsonrpc: "2.0";
  id?: JsonRpcId | null;
  method?: string;
  params?: unknown;
};

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
};

class InvalidParamsError extends Error {
  readonly data: unknown;
  constructor(message: string, data?: unknown) {
    super(message);
    this.name = "InvalidParamsError";
    this.data = data;
  }
}

export async function runMcpStdioServer(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<void> {
  input.setEncoding?.("utf8");
  let buffer = "";
  for await (const chunk of input) {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }
      let parsed: JsonRpcMessage;
      try {
        parsed = JSON.parse(line) as JsonRpcMessage;
      } catch {
        writeJsonLine(output, jsonRpcError(null, -32700, "Parse error"));
        continue;
      }
      const response = await handleMcpMessage(parsed);
      if (response) {
        writeJsonLine(output, response);
      }
    }
  }
  const trailing = buffer.trim();
  if (trailing) {
    try {
      const parsed = JSON.parse(trailing) as JsonRpcMessage;
      const response = await handleMcpMessage(parsed);
      if (response) {
        writeJsonLine(output, response);
      }
    } catch {
      writeJsonLine(output, jsonRpcError(null, -32700, "Parse error"));
    }
  }
}

export async function handleMcpMessage(message: JsonRpcMessage): Promise<JsonRpcResponse | null> {
  if (!("id" in message)) {
    return null;
  }
  if (message.id == null) {
    return jsonRpcError(null, -32600, "Invalid request id");
  }
  if (typeof message.method !== "string") {
    return jsonRpcError(message.id, -32600, "Invalid request");
  }
  if (message.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: "agent-session-distillery",
          title: "Agent Session Distillery",
          version: "1.0.0",
        },
      },
    };
  }
  if (message.method === "ping") {
    return { jsonrpc: "2.0", id: message.id, result: {} };
  }
  if (message.method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: allTools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: toolInputSchemas[tool.name],
        })),
      },
    };
  }
  if (message.method === "tools/call") {
    try {
      const result = await callTool(message.params);
      return {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [{ type: "text", text: JSON.stringify(result.result, null, 2) }],
          isError: false,
        },
      };
    } catch (error) {
      if (error instanceof InvalidParamsError) {
        return jsonRpcError(message.id, -32602, error.message, error.data);
      }
      return jsonRpcError(message.id, -32603, "Internal error");
    }
  }
  return jsonRpcError(message.id, -32601, `Method not found: ${message.method}`);
}

async function callTool(params: unknown): Promise<{ result: unknown }> {
  const startedAt = Date.now();
  const parsed = parseToolCallParams(params);
  if (parsed.name === "search_instincts") {
    const input = parseInput(searchInstinctsInputSchema, parsed.arguments);
    const result = await searchInstincts(input);
    await appendMcpUsageLog(buildUsageRecord(parsed.name, input, result.hits.length, startedAt));
    return { result };
  }
  if (parsed.name === "instincts_for_file") {
    const input = parseInput(instinctsForFileInputSchema, parsed.arguments);
    const result = await instinctsForFile(input);
    await appendMcpUsageLog(
      buildUsageRecord(
        parsed.name,
        input,
        result.exact_hits.length + result.proximal_hits.length,
        startedAt,
      ),
    );
    return { result };
  }
  const input = parseInput(recentInstinctsInputSchema, parsed.arguments);
  const result = await recentInstincts(input);
  await appendMcpUsageLog(buildUsageRecord(parsed.name, input, result.hits.length, startedAt));
  return { result };
}

function buildUsageRecord(
  tool: McpUsageLogEntry["tool"],
  input: unknown,
  resultCount: number,
  startedAt: number,
): McpUsageLogEntry {
  return {
    tool,
    ts: new Date().toISOString(),
    input_size_chars: JSON.stringify(input).length,
    result_count: resultCount,
    duration_ms: Date.now() - startedAt,
  };
}

function parseToolCallParams(params: unknown): {
  name: McpUsageLogEntry["tool"];
  arguments: unknown;
} {
  if (!params || typeof params !== "object") {
    throw new InvalidParamsError("tools/call params must be an object");
  }
  const { name, arguments: inputArguments } = params as { name?: unknown; arguments?: unknown };
  if (name !== "search_instincts" && name !== "instincts_for_file" && name !== "recent_instincts") {
    throw new InvalidParamsError(`Unknown mcp tool: ${String(name)}`);
  }
  return { name, arguments: inputArguments };
}

function parseInput<T>(schema: ZodType<T>, value: unknown): T {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new InvalidParamsError(error.message, error.issues);
    }
    throw error;
  }
}

function writeJsonLine(output: NodeJS.WritableStream, response: JsonRpcResponse): void {
  output.write(`${JSON.stringify(response)}\n`);
}

function jsonRpcError(
  id: JsonRpcId | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}
