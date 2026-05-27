import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { DatabaseSync } from "node:sqlite";

import type { CommandContext } from "../cli.js";
import { getRuntimePath } from "../config/paths.js";
import { sessionIndexRecordSchema, type SessionIndexRecord } from "./export-index.js";

export async function executeSearch(
	context: CommandContext,
	_database: DatabaseSync,
): Promise<number> {
	const { query, limit, json } = parseSearchArgs(context.args);
	const indexPath = join(getRuntimePath("index"), "session-index.jsonl");

	try {
		await access(indexPath);
	} catch {
		context.output.error(
			`Session index not found at ${indexPath}. Run \`export-index\` first.`,
		);
		return 1;
	}

	const contents = await readFile(indexPath, "utf8");
	const records = parseSessionIndex(contents);

	if (records.length === 0) {
		context.output.error(
			`Session index at ${indexPath} is empty. Run \`export-index\` after ingesting sessions.`,
		);
		return 1;
	}

	const needle = query.toLowerCase();
	const matches = records.filter((record) => matchesQuery(record, needle)).slice(0, limit);

	if (json) {
		context.output.info(JSON.stringify(matches, null, 2));
		return 0;
	}

	if (matches.length === 0) {
		context.output.info(`No sessions matched "${query}".`);
		return 0;
	}

	for (const record of matches) {
		context.output.info(
			`${record.asd_session_id}\t${record.source_tool}\t${record.topic_source}\t${record.topic}`,
		);
	}

	context.output.info(`${matches.length} match${matches.length === 1 ? "" : "es"}.`);
	return 0;
}

function parseSearchArgs(args: string[]): {
	query: string;
	limit: number;
	json: boolean;
} {
	let limit = 20;
	let json = false;
	const positional: string[] = [];

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index]!;

		if (arg === "--json") {
			json = true;
			continue;
		}

		if (arg === "--limit") {
			const value = args[index + 1];
			if (!value || value.startsWith("--")) {
				throw new Error("--limit requires a value");
			}

			const parsed = Number.parseInt(value, 10);
			if (!Number.isFinite(parsed) || parsed < 1) {
				throw new Error("--limit must be a positive integer");
			}

			limit = parsed;
			index += 1;
			continue;
		}

		if (arg.startsWith("--")) {
			throw new Error(`Unknown flag: ${arg}`);
		}

		positional.push(arg);
	}

	if (positional.length === 0) {
		throw new Error("search requires a query argument");
	}

	return {
		query: positional.join(" "),
		limit,
		json,
	};
}

function parseSessionIndex(contents: string): SessionIndexRecord[] {
	const records: SessionIndexRecord[] = [];

	for (const line of contents.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) {
			continue;
		}

		records.push(sessionIndexRecordSchema.parse(JSON.parse(trimmed)));
	}

	return records;
}

function matchesQuery(record: SessionIndexRecord, needle: string): boolean {
	return (
		record.topic.toLowerCase().includes(needle) ||
		record.asd_session_id.toLowerCase().includes(needle) ||
		record.source_tool.toLowerCase().includes(needle)
	);
}
