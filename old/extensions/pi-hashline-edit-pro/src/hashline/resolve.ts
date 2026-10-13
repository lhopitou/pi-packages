
import { throwIfAborted } from "../runtime";
import { HASHLINE_BARE_PREFIX_RE } from "./hash";
import { parseHashRef, hashlineParseText, type Anchor } from "./parse";


export type ResolvedAnchor = {
	line: number;
	hash: string;
	hashMatched: boolean;
};

export type HashlineEdit = { start: Anchor; end: Anchor; lines: string[] };
export type ResolvedHashlineEdit = {
	start: ResolvedAnchor;
	end: ResolvedAnchor;
	lines: string[];
};
interface HashMismatch {
	ref: Anchor;
	kind: "not_found" | "ambiguous";
	candidates?: number[];
}

export interface NoopEdit {
	editIndex: number;
	loc: string;
	currentContent: string;
}

export type HashlineToolEdit = {
	start?: string;
	end?: string;
	lines?: string[];
	/** @deprecated Legacy field — rejected with [E_LEGACY_SHAPE] at validation time. */
	oldText?: string;
	/** @deprecated Legacy field — rejected with [E_LEGACY_SHAPE] at validation time. */
	newText?: string;
};


function resolveAnchor(
	ref: Anchor,
	fileLines: string[],
	fileHashes: string[],
): ResolvedAnchor | HashMismatch {
	const hashMatches: number[] = [];
	for (let i = 0; i < fileHashes.length; i++) {
		if (fileHashes[i] === ref.hash) hashMatches.push(i + 1);
	}
	if (hashMatches.length === 0) {
		return { ref, kind: "not_found" };
	}
	if (hashMatches.length === 1) {
		return {
			line: hashMatches[0]!,
			hash: ref.hash,
			hashMatched: true,
		};
	}
	return { ref, kind: "ambiguous", candidates: hashMatches };
}


export function formatMismatchError(
	mismatches: HashMismatch[],
	fileLines: string[],
	fileHashes: string[],
): string {
	if (fileHashes.length !== fileLines.length) {
		throw new Error(
			`formatMismatchError: fileHashes.length (${fileHashes.length}) must match fileLines.length (${fileLines.length}).`,
		);
	}
	const out: string[] = [];
	const notFound = mismatches.filter((m) => m.kind === "not_found");
	const ambiguous = mismatches.filter((m) => m.kind === "ambiguous");

	if (notFound.length > 0) {
		const refList = notFound.map((m) => `"${m.ref.hash}"`).join(", ");
	out.push(
		`[E_STALE_ANCHOR] ${notFound.length} stale anchor${notFound.length > 1 ? "s" : ""}: ${refList}. Call read() to get fresh anchors, then copy the 4-character HASH from each line into your next replace call.`
	);
	}
	if (ambiguous.length > 0) {
		if (out.length > 0) out.push("");
	out.push(
		`[E_AMBIGUOUS_ANCHOR] ${ambiguous.length} ambiguous anchor${ambiguous.length > 1 ? "s" : ""}. Call read() to get fresh anchors, then copy the 4-character HASH from each line into your next replace call.`
	);
		for (const m of ambiguous) {
			const sample = (m.candidates ?? []).slice(0, 5);
			const more =
				(m.candidates?.length ?? 0) > sample.length
					? `, ... (+${(m.candidates?.length ?? 0) - sample.length} more)`
					: "";
			const lines = sample
				.map((line) => {
					const content = fileLines[line - 1] ?? "";
					return `    ${line}: ${fileHashes[line - 1]}│${content}`;
				})
				.join("\n");
				out.push(
					`  Hash "${m.ref.hash}" matches lines ${sample.join(", ")}${more}.\n${lines}`,
				);
		}
	}


	return out.join("\n");
}


const ITEM_KEYS = new Set(["start", "end", "lines"]);
function isStringArray(value: unknown): value is string[] {
	return (
		Array.isArray(value) && value.every((item) => typeof item === "string")
	);
}

function assertEditItem(edit: Record<string, unknown>, index: number): void {
	const unknownKeys = Object.keys(edit).filter((key) => !ITEM_KEYS.has(key));
	if (unknownKeys.length > 0) {
		throw new Error(
			`[E_BAD_SHAPE] Edit ${index} contains unknown or unsupported fields: ${unknownKeys.join(", ")}.`,
		);
	}

	if ("start" in edit && typeof edit.start !== "string") {
		throw new Error(
			`[E_BAD_SHAPE] Edit ${index} field "start" must be a string when provided.`,
		);
	}
	if ("end" in edit && typeof edit.end !== "string") {
		throw new Error(`[E_BAD_SHAPE] Edit ${index} field "end" must be a string when provided.`);
	}
	if (!("lines" in edit)) {
		throw new Error(`[E_BAD_SHAPE] Edit ${index} requires a "lines" field.`);
	}
	if ("lines" in edit && !isStringArray(edit.lines)) {
		throw new Error(`[E_BAD_SHAPE] Edit ${index} field "lines" must be a string array.`);
	}
	if (typeof edit.start !== "string") {
		throw new Error(
			`[E_BAD_OP] Edit ${index} requires a "start" anchor string.`,
		);
	}
	if (typeof edit.end !== "string") {
		throw new Error(
			`[E_BAD_OP] Edit ${index} requires an "end" anchor string.`,
		);
	}

}

export function resolveEditAnchors(edits: HashlineToolEdit[]): HashlineEdit[] {
	const result: HashlineEdit[] = [];
	for (const [index, edit] of edits.entries()) {
		assertEditItem(edit as Record<string, unknown>, index);

		// Normalize lines: [""] to lines: [] for deletion.
		const replaceLines = hashlineParseText(edit.lines ?? null);
		const normalizedLines =
			replaceLines.length === 1 && replaceLines[0] === ""
				? []
				: replaceLines;
		result.push({
			start: parseHashRef(edit.start!),
			end: parseHashRef(edit.end!),
			lines: normalizedLines,
		});
	}
	return result;
}

function maybeWarnSuspiciousUnicodeEscapePlaceholder(
	edits: HashlineEdit[],
	warnings: string[],
): void {
	for (const edit of edits) {
		if (edit.lines.some((line) => /\\uDDDD/i.test(line))) {
			warnings.push(
				"Detected literal \\uDDDD in edit content; no autocorrection applied. Verify whether this should be a real Unicode escape or plain text.",
			);
		}
	}
}

export function assertNoBareHashPrefixLines(
	edits: HashlineEdit[],
	fileLines: string[],
	fileHashes: string[],
): string[] {
	if (fileHashes.length !== fileLines.length) {
		throw new Error(
			`assertNoBareHashPrefixLines: fileHashes.length (${fileHashes.length}) must match fileLines.length (${fileLines.length}).`,
		);
	}
	const suspects: { line: string; hash: string; editIndex: number; lineIndex: number }[] = [];
	for (let editIndex = 0; editIndex < edits.length; editIndex++) {
		const edit = edits[editIndex]!;
		for (let lineIndex = 0; lineIndex < edit.lines.length; lineIndex++) {
			const line = edit.lines[lineIndex]!;
			const match = line.match(HASHLINE_BARE_PREFIX_RE);
			if (match) suspects.push({ line, hash: match[1]!, editIndex, lineIndex });
		}
	}
	if (suspects.length === 0) return [];

	const fileHashSet = new Set(fileHashes);
	const matched = suspects.filter((s) => fileHashSet.has(s.hash));
	const matchedCount = matched.length;
	const exampleLine = `${suspects[0]!.hash}│${suspects[0]!.line}`;


	const linesHint =
		matchedCount === 0
			? `None match file line hashes.`
			: `${matchedCount} match file line hashes — likely a copied hash.`;

	throw new Error(
		`[E_BARE_HASH_PREFIX] ${suspects.length} edit line(s) start with a hash-like prefix (e.g. ${JSON.stringify(exampleLine)}). ${linesHint} Use literal file content in \"lines\" — never paste HASH│content from read output.`
	);
}


/**
 * Human-readable label for a resolved edit (used in warnings and conflict errors).
 */
export function describeEdit(edit: ResolvedHashlineEdit): string {
	return `replace ${edit.start.hash}-${edit.end.hash}`;
}

export function validateAnchorEdits(
	edits: HashlineEdit[],
	fileLines: string[],
	fileHashes: string[],
	warnings: string[],
	signal: AbortSignal | undefined,
): { resolved: ResolvedHashlineEdit[]; mismatches: HashMismatch[] } {
	if (fileHashes.length !== fileLines.length) {
		throw new Error(
			`validateAnchorEdits: fileHashes.length (${fileHashes.length}) must match fileLines.length (${fileLines.length}).`,
		);
	}
	const resolved: ResolvedHashlineEdit[] = [];
	const mismatches: HashMismatch[] = [];

	const tryResolve = (ref: Anchor): ResolvedAnchor | undefined => {
		const result = resolveAnchor(ref, fileLines, fileHashes);
		if ("kind" in result) {
			mismatches.push(result);
			return undefined;
		}
		return result;
	};


	for (const edit of edits) {
		throwIfAborted(signal);
		const startResolved = tryResolve(edit.start);
		const endResolved = tryResolve(edit.end);
		if (!startResolved || !endResolved) {
			continue;
		}
		if (startResolved.line > endResolved.line) {
			throw new Error(
				`[E_BAD_OP] Range start line ${startResolved.line} must be <= end line ${endResolved.line} (anchors ${edit.start.hash} and ${edit.end.hash}).`,
			);
		}
		const endLine = endResolved.line;
		const nextLine = fileLines[endLine];
		const replacementLastLine = edit.lines.at(-1)?.trim();
		if (
			nextLine !== undefined &&
			replacementLastLine &&
			/[\p{L}\p{N}]/u.test(replacementLastLine) &&
			replacementLastLine === nextLine.trim()
		) {
			const resolvedEdit: ResolvedHashlineEdit = {
				start: startResolved,
				end: endResolved,
				lines: edit.lines,
			};
			warnings.push(
				`Potential boundary duplication after ${describeEdit(resolvedEdit)}: the replacement ends with a line that matches the next surviving line after trim.`,
			);
		}
		const prevLine = fileLines[startResolved.line - 2];
		const replacementFirstLine = edit.lines[0]?.trim();
		if (
			prevLine !== undefined &&
			replacementFirstLine &&
			/[\p{L}\p{N}]/u.test(replacementFirstLine) &&
			replacementFirstLine === prevLine.trim()
		) {
			const resolvedEdit: ResolvedHashlineEdit = {
				start: startResolved,
				end: endResolved,
				lines: edit.lines,
			};
			warnings.push(
				`Potential boundary duplication before ${describeEdit(resolvedEdit)}: the replacement starts with a line that matches the preceding surviving line after trim.`,
			);
		}
		resolved.push({
			start: startResolved,
			end: endResolved,
			lines: edit.lines,
		});
	}

	return { resolved, mismatches };
}

export { maybeWarnSuspiciousUnicodeEscapePlaceholder };
