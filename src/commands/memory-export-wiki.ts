import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { CommandContext } from "../cli.js";
import { ensureRuntimePath, getRuntimePath } from "../config/paths.js";
import { type Learning, learningSchema } from "../models/canonical.js";

export const wikiMemorySchemaVersion = "asd.wiki_memory.v1";

export type WikiMemoryRecord = {
	schema_version: typeof wikiMemorySchemaVersion;
	id: string;
	kind: "project_learning";
	project: {
		key: string;
		root: string | null;
	};
	title: string;
	body: string;
	evidence: {
		learning_id: string;
		promotion_basis: string;
		evidence: string[];
		source_refs: Learning["source_refs"];
	};
	review: {
		verdict: "keep";
		confidence: Learning["confidence"];
		source: "deterministic-export" | "reviewed-export";
	};
	created_at: string;
};

export async function executeMemoryExportWiki(
	context: CommandContext,
): Promise<number> {
	const records = await buildWikiMemoryExport();
	const exportDir = await ensureRuntimePath("wikiMemoryExports");
	const exportPath = join(exportDir, "reviewed-memory.jsonl");
	const contents =
		records.length === 0
			? ""
			: `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;

	await writeFile(exportPath, contents, "utf8");

	context.output.info(
		`Exported ${records.length} wiki memory ${records.length === 1 ? "record" : "records"}.`,
	);
	context.output.info(`Export path: ${exportPath}`);

	return 0;
}

export async function buildWikiMemoryExport(): Promise<WikiMemoryRecord[]> {
	const reviewedRoot = join(getRuntimePath("root"), "knowledge", "projects-reviewed");
	const projectRoot =
		(await directoryExists(reviewedRoot)) ? reviewedRoot : getRuntimePath("knowledgeProjects");
	const projectDirs = await readDirectoryNames(projectRoot);
	const records: WikiMemoryRecord[] = [];
	const reviewSource =
		projectRoot === reviewedRoot ? "reviewed-export" : "deterministic-export";

	for (const projectKey of projectDirs.sort()) {
		const projectDir = join(projectRoot, projectKey);
		const files = (await readDirectoryNames(projectDir)).filter((file) =>
			file.endsWith(".jsonl"),
		);

		for (const file of files.sort()) {
			const lines = await readJsonl(join(projectDir, file));
			for (const value of lines) {
				const learning = learningSchema.parse(value);
				if (learning.scope !== "project") continue;
				records.push(toWikiMemoryRecord(learning, reviewSource));
			}
		}
	}

	records.sort((left, right) => left.id.localeCompare(right.id));
	return records;
}

function toWikiMemoryRecord(
	learning: Learning,
	reviewSource: WikiMemoryRecord["review"]["source"],
): WikiMemoryRecord {
	return {
		schema_version: wikiMemorySchemaVersion,
		id: stableRecordId(learning),
		kind: "project_learning",
		project: {
			key: learning.scope_key,
			root: null,
		},
		title: learning.title,
		body: learning.statement,
		evidence: {
			learning_id: learning.learning_id,
			promotion_basis: learning.promotion_basis,
			evidence: learning.evidence,
			source_refs: learning.source_refs,
		},
		review: {
			verdict: "keep",
			confidence: learning.confidence,
			source: reviewSource,
		},
		created_at: inferCreatedAt(learning),
	};
}

function stableRecordId(learning: Learning): string {
	const stablePayload = JSON.stringify({
		schema_version: wikiMemorySchemaVersion,
		learning_id: learning.learning_id,
		project_key: learning.scope_key,
		title: learning.title,
		body: learning.statement,
		source_refs: learning.source_refs,
	});
	return `sha256:${createHash("sha256").update(stablePayload).digest("hex")}`;
}

function inferCreatedAt(learning: Learning): string {
	const firstRef = learning.source_refs[0];
	const line = firstRef?.line ?? 0;
	const seconds = Math.max(0, line);
	return new Date(Date.UTC(1970, 0, 1, 0, 0, seconds)).toISOString();
}

async function readDirectoryNames(path: string): Promise<string[]> {
	try {
		return await readdir(path);
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return [];
		throw error;
	}
}

async function directoryExists(path: string): Promise<boolean> {
	try {
		const entries = await readdir(path);
		return entries.length > 0;
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return false;
		throw error;
	}
}

async function readJsonl(path: string): Promise<unknown[]> {
	const content = await readFile(path, "utf8");
	return content
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as unknown);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
