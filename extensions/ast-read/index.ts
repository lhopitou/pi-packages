/**
 * ast-read — AST-aware structure tools for pi.
 *
 * v1 ships `ast_signatures`: extract code signatures (functions, methods,
 * classes, interfaces, types, enums, structs, traits, impls) from a source
 * file with tree-sitter, returning each definition's verbatim signature and its
 * full line range, nested by structure. The agent then targets a body with the
 * native `read` tool using the returned line range as offset/limit.
 *
 * `ast_map` (deps/exports/public-API surface) is planned as a separate tool on
 * the same engine.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { configForPath } from "./languages.ts";
import { parseSource, extract, type ExtractResult } from "./engine.ts";

const MAX_ITEMS = 200;
const MAX_BYTES = 256 * 1024;
const FILE_CACHE_LIMIT = 20;

interface FileCacheEntry {
	mtimeMs: number;
	blocks: string[];
	totalLines: number;
}
const fileCache = new Map<string, FileCacheEntry>();

function isBinary(buf: Buffer): boolean {
	return buf.subarray(0, 8000).includes(0);
}

async function getExtract(absPath: string, config: ReturnType<typeof configForPath>): Promise<ExtractResult> {
	const st = await stat(absPath);
	const mtimeMs = st.mtimeMs;
	const cached = fileCache.get(absPath);
	if (cached && cached.mtimeMs === mtimeMs) return cached;

	const buf = await readFile(absPath);
	if (isBinary(buf)) throw new Error("binary file: not parsed — use read");
	const src = buf.toString("utf8");

	const tree = await parseSource(config!.grammar, src);
	const result = extract(tree.rootNode, config!, src);
	tree.delete();

	const entry: FileCacheEntry = { mtimeMs, blocks: result.blocks, totalLines: result.totalLines };
	fileCache.set(absPath, entry);
	if (fileCache.size > FILE_CACHE_LIMIT) {
		const first = fileCache.keys().next().value;
		if (first !== undefined) fileCache.delete(first);
	}
	return entry;
}

export default function astReadExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "ast_signatures",
		label: "AST signatures",
		description:
			"Extract code signatures (functions, methods, classes, interfaces, types, enums, structs, traits, impls) from a source file using tree-sitter, returning each definition's verbatim signature with its full line range, nested by structure. Use this to understand a file's structure or to locate a symbol before reading its body with `read` (pass the returned line range as offset/limit). Supported: TypeScript/JavaScript/TSX, Rust, Python, Go. For small files, prose, images, or unsupported languages, use `read` instead.",
		promptSnippet: "List a code file's definitions (functions, classes, types) with line ranges, without bodies",
		promptGuidelines: [
			"Use ast_signatures to see what a code file defines (function/class/type names + line ranges) when you don't need the implementation — to check whether a file contains a symbol, locate a symbol's line range before reading its body with read (offset/limit), or understand a file's structure cheaply; use read instead when you need exact content (to edit, quote, or reproduce lines), when the file isn't code, or when you already know the line range you want.",
		],
		parameters: Type.Object({
			path: Type.String({ description: "Path to the source file (relative or absolute)" }),
			after: Type.Optional(
				Type.Number({
					description:
						"Top-level definition index to start from (0-based). Use this to page through large results when a previous call reported more definitions remain.",
				}),
			),
		}),
		async execute(_toolCallId, { path, after }, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("Operation aborted");

			const config = configForPath(path);
			if (!config) {
				const ext = path.includes(".") ? path.slice(path.lastIndexOf(".") + 1) : "(none)";
				throw new Error(`unsupported language (.${ext}): no tree-sitter grammar configured — use read`);
			}

			const absPath = resolve(ctx.cwd, path);
			let entry: ExtractResult;
			try {
				entry = await getExtract(absPath, config);
			} catch (e) {
				throw new Error(`ast_signatures: ${(e as Error).message}`);
			}
			if (signal?.aborted) throw new Error("Operation aborted");

			const total = entry.blocks.length;
			const start = Math.max(0, Math.floor(after ?? 0));
			const header = `${path} [signatures] ${entry.totalLines}L · ${total} definitions`;

			if (total === 0) {
				return {
					content: [{ type: "text", text: `${header}\n[no definitions found]` }],
					details: { total: 0, shownFrom: 0, shownTo: 0 },
				};
			}
			if (start >= total) {
				return {
					content: [
						{ type: "text", text: `${header}\n[after=${start} is past the end (total ${total}). Use after=0.]` },
					],
					details: { total, shownFrom: start, shownTo: start },
				};
			}

			let out = "";
			let count = 0;
			let i = start;
			while (i < total) {
				if (count >= MAX_ITEMS) break;
				const block = entry.blocks[i];
				if (count >= 1 && out.length + block.length + 1 > MAX_BYTES) break;
				out += (count ? "\n" : "") + block;
				count++;
				i++;
			}
			const shownTo = i;
			let text = `${header}\n${out}`;
			if (shownTo < total) {
				text += `\n[showing definitions ${start + 1}-${shownTo} of ${total}. Use ast_signatures with after=${shownTo} to continue.]`;
			}
			return {
				content: [{ type: "text", text }],
				details: { total, shownFrom: start, shownTo },
			};
		},
	});
}
