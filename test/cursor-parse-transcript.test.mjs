import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { parseCursorTranscript } from "../dist/adapters/cursor/parse-transcript.js";

async function withTranscript(content, run) {
  const sandboxRoot = await mkdtemp(join(tmpdir(), "marrow-cursor-transcript-"));
  const transcriptPath = join(sandboxRoot, "agent-transcripts", "composer.jsonl");

  try {
    await mkdir(dirname(transcriptPath), { recursive: true });
    await writeFile(transcriptPath, content, "utf8");
    await run(transcriptPath);
  } finally {
    await rm(sandboxRoot, { force: true, recursive: true });
  }
}

function summarize(record) {
  return {
    kind: record.kind,
    rawType: record.rawType,
    lineNumber: record.provenance.lineNumber,
    timestampHint: record.timestampHint,
    messageText: record.messageText,
    contentRedacted: record.contentRedacted,
    commandStrings: record.commandStrings,
    filePaths: record.filePaths,
    toolName: record.toolUse?.name ?? null,
    toolCallId: record.toolUse?.callId ?? null,
  };
}

test("parses Cursor transcript JSONL as adapter-local intermediate records with provenance", async () => {
  const transcriptContent = [
    JSON.stringify({
      role: "user",
      timestamp: "2026-05-16T08:30:00.000Z",
      message: {
        content: [
          {
            type: "text",
            text: "Open /Users/example/Code/marrow/src/main.ts and run npm test",
          },
        ],
      },
    }),
    JSON.stringify({
      role: "assistant",
      createdAt: "2026-05-16T08:30:02.000Z",
      message: {
        content: [
          {
            type: "text",
            text: "I'll inspect /Users/example/Code/marrow/src/main.ts before running `npm test`.",
          },
        ],
      },
    }),
    JSON.stringify({
      type: "tool_call",
      name: "run_terminal_command",
      id: "tool-001",
      arguments: {
        command: "npm test",
        cwd: "/Users/example/Code/marrow",
      },
    }),
    JSON.stringify({
      type: "tool_result",
      toolName: "read_file",
      metadata: {
        path: "/Users/example/Code/marrow/src/main.ts",
      },
    }),
  ].join("\n");

  await withTranscript(transcriptContent, async (transcriptPath) => {
    const parsed = await parseCursorTranscript({
      sourceHash: "sha256:fixture-transcript",
      sourcePath: transcriptPath,
    });

    assert.equal(parsed.records.length, 4);
    assert.deepEqual(parsed.records.map(summarize), [
      {
        kind: "user_message",
        rawType: "user",
        lineNumber: 1,
        timestampHint: "2026-05-16T08:30:00.000Z",
        messageText: "Open /Users/example/Code/marrow/src/main.ts and run npm test",
        contentRedacted: false,
        commandStrings: ["npm test"],
        filePaths: ["/Users/example/Code/marrow/src/main.ts"],
        toolName: null,
        toolCallId: null,
      },
      {
        kind: "assistant_message",
        rawType: "assistant",
        lineNumber: 2,
        timestampHint: "2026-05-16T08:30:02.000Z",
        messageText:
          "I'll inspect /Users/example/Code/marrow/src/main.ts before running `npm test`.",
        contentRedacted: false,
        commandStrings: ["npm test"],
        filePaths: ["/Users/example/Code/marrow/src/main.ts"],
        toolName: null,
        toolCallId: null,
      },
      {
        kind: "tool_use_stub",
        rawType: "tool_call",
        lineNumber: 3,
        timestampHint: null,
        messageText: null,
        contentRedacted: false,
        commandStrings: ["npm test"],
        filePaths: ["/Users/example/Code/marrow"],
        toolName: "run_terminal_command",
        toolCallId: "tool-001",
      },
      {
        kind: "tool_result_stub",
        rawType: "tool_result",
        lineNumber: 4,
        timestampHint: null,
        messageText: null,
        contentRedacted: false,
        commandStrings: [],
        filePaths: ["/Users/example/Code/marrow/src/main.ts"],
        toolName: "read_file",
        toolCallId: null,
      },
    ]);
    assert.equal(parsed.records[0].provenance.sourcePath, transcriptPath);
    assert.equal(parsed.records[0].provenance.sourceHash, "sha256:fixture-transcript");
  });
});

test("tolerates missing fields, redacted content, and partial tool metadata", async () => {
  const transcriptContent = [
    JSON.stringify({
      type: "assistant",
      message: {
        content: "[redacted]",
      },
      isRedacted: true,
    }),
    JSON.stringify({
      type: "tool_call",
      arguments: {
        path: "/Users/example/Code/marrow/src/partial.ts",
      },
    }),
    JSON.stringify({
      type: "assistant",
    }),
  ].join("\n");

  await withTranscript(transcriptContent, async (transcriptPath) => {
    const parsed = await parseCursorTranscript({
      sourceHash: "sha256:fixture-transcript-variants",
      sourcePath: transcriptPath,
    });

    assert.deepEqual(parsed.records.map(summarize), [
      {
        kind: "assistant_message",
        rawType: "assistant",
        lineNumber: 1,
        timestampHint: null,
        messageText: null,
        contentRedacted: true,
        commandStrings: [],
        filePaths: [],
        toolName: null,
        toolCallId: null,
      },
      {
        kind: "tool_use_stub",
        rawType: "tool_call",
        lineNumber: 2,
        timestampHint: null,
        messageText: null,
        contentRedacted: false,
        commandStrings: [],
        filePaths: ["/Users/example/Code/marrow/src/partial.ts"],
        toolName: null,
        toolCallId: null,
      },
      {
        kind: "assistant_message",
        rawType: "assistant",
        lineNumber: 3,
        timestampHint: null,
        messageText: null,
        contentRedacted: false,
        commandStrings: [],
        filePaths: [],
        toolName: null,
        toolCallId: null,
      },
    ]);
  });
});

test("prefers user_query content over attachment wrappers and avoids prose-only command extraction", async () => {
  const transcriptContent = [
    JSON.stringify({
      role: "user",
      message: {
        content: [
          {
            type: "text",
            text: [
              "<attached_files>",
              '<code_selection path="/tmp/plan.md" lines="1-40">1| make sure to add corresponding DROP VIEW statements</code_selection>',
              "</attached_files>",
              "<user_query>",
              "Implement the plan as specified.",
              "Run `uv run pytest -v` when verification is needed.",
              "</user_query>",
            ].join("\n"),
          },
        ],
      },
    }),
    JSON.stringify({
      role: "assistant",
      message: {
        content: [
          {
            type: "text",
            text: "surely we can make these tests go faster",
          },
        ],
      },
    }),
  ].join("\n");

  await withTranscript(transcriptContent, async (transcriptPath) => {
    const parsed = await parseCursorTranscript({
      sourceHash: "sha256:fixture-transcript-user-query",
      sourcePath: transcriptPath,
    });

    assert.deepEqual(parsed.records.map(summarize), [
      {
        kind: "user_message",
        rawType: "user",
        lineNumber: 1,
        timestampHint: null,
        messageText:
          "Implement the plan as specified.\nRun `uv run pytest -v` when verification is needed.",
        contentRedacted: false,
        commandStrings: ["uv run pytest -v"],
        filePaths: [],
        toolName: null,
        toolCallId: null,
      },
      {
        kind: "assistant_message",
        rawType: "assistant",
        lineNumber: 2,
        timestampHint: null,
        messageText: "surely we can make these tests go faster",
        contentRedacted: false,
        commandStrings: [],
        filePaths: [],
        toolName: null,
        toolCallId: null,
      },
    ]);
  });
});
