
import { generateDiffString } from "./replace-diff";
import {
	computeAffectedLineRange,
	computeLineHashes,
	formatHashlineRegion,
} from "./hashline";
import { formatHashlineReadPreview } from "./read";
import { getVisibleLines } from "./utils";

type ToolResult = {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
	details: any;
};

const CHANGED_ANCHOR_TEXT_BUDGET_BYTES = 50 * 1024;


export type ReturnMode = "changed" | "full" | "ranges";

export type ReturnRange = {
	start: number;
	end?: number;
};

export type ReturnedRangePreview = {
	start: number;
	end: number;
	text: string;
	nextOffset?: number;
	empty?: true;
};

export type FullContentPreview = {
	text: string;
	nextOffset?: number;
};

export type ReplaceMetrics = {
	edits_attempted: number;
	edits_noop: number;
	warnings: number;
	return_mode: ReturnMode;
	classification: "applied" | "noop";
	changed_lines?: { first: number; last: number };
	added_lines?: number;
	removed_lines?: number;
};

export type ReadMetrics = {
	truncated: boolean;
	next_offset?: number;
};

export type ReplaceMeta = {
	editsAttempted: number;
	noopEditsCount: number;
	firstChangedLine?: number;
	lastChangedLine?: number;
};

type NoopEditEntry = {
	editIndex: number;
	loc: string;
	currentContent: string;
};

// ─── Builder inputs ─────────────────────────────────────────────────────

export interface NoopResponseInput {
	path: string;
	returnMode: ReturnMode;
	requestedReturnRanges: ReturnRange[] | undefined;
	noopEdits: NoopEditEntry[] | undefined;
	originalNormalized: string;
	snapshotId: string;
	editMeta: ReplaceMeta;
	warnings: string[] | undefined;
}

export interface SuccessResponseInput {
	path: string;
	returnMode: ReturnMode;
	requestedReturnRanges: ReturnRange[] | undefined;
	originalNormalized: string;
	result: string;
	/** Precomputed hashes for `result`. When omitted the response builder
	 * computes them on demand; the caller should pass them in when the same
	 * result is rendered through more than one path (full / ranges / changed)
	 * to avoid redundant work. */
	resultHashes?: string[];
	warnings: string[] | undefined;
	snapshotId: string;
	editMeta: ReplaceMeta;
}

// ─── Helpers ────────────────────────────────────────────────────────────


function countDiffLines(diff: string, marker: "+" | "-"): number {
	if (!diff) return 0;
	let count = 0;
	for (const line of diff.split("\n")) {
		if (
			line.startsWith(marker) &&
			!line.startsWith(`${marker}${marker}${marker}`)
		) {
			count += 1;
		}
	}
	return count;
}

function buildMetrics(args: {
	classification: "applied" | "noop";
	returnMode: ReturnMode;
	editsAttempted: number;
	noopEditsCount: number;
	warningsCount: number;
	firstChangedLine?: number;
	lastChangedLine?: number;
	addedLines?: number;
	removedLines?: number;
}): ReplaceMetrics {
	const metrics: ReplaceMetrics = {
		edits_attempted: args.editsAttempted,
		edits_noop: args.noopEditsCount,
		warnings: args.warningsCount,
		return_mode: args.returnMode,
		classification: args.classification,
	};
	if (
		args.classification === "applied" &&
		args.firstChangedLine !== undefined &&
		args.lastChangedLine !== undefined
	) {
		metrics.changed_lines = {
			first: args.firstChangedLine,
			last: args.lastChangedLine,
		};
	}
	if (args.addedLines !== undefined) metrics.added_lines = args.addedLines;
	if (args.removedLines !== undefined)
		metrics.removed_lines = args.removedLines;
	return metrics;
}

function warningsBlockOf(warnings: string[] | undefined): string {
	return warnings?.length ? `\n\nWarnings:\n${warnings.join("\n")}` : "";
}

function outlineBlockOf(outlineText: string): string {
	return outlineText ? `\n\n${outlineText}` : "";
}

// ─── Structure outline ──────────────────────────────────────────────────

const STRUCTURE_MARKER_RE =
	/^(#{1,6}\s+.+|(export\s+)?(async\s+)?function\s+\w+|(export\s+)?class\s+\w+|(export\s+)?interface\s+\w+|(export\s+)?type\s+\w+|(export\s+)?enum\s+\w+|(const|let|var)\s+\w+\s*=\s*(async\s*)?\()/;

function truncateOutlineEntry(text: string, max = 88): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function collectOutlineEntries(previewText: string): string[] {
	const structural: string[] = [];
	for (const line of previewText.split("\n")) {
		const match = line.match(/^\s*([A-Za-z0-9_\-]{4})│(.*)$/);
		if (!match) continue;
		const content = match[2]!.trim();
		if (content.length === 0) continue;
		if (!STRUCTURE_MARKER_RE.test(content)) continue;
		structural.push(truncateOutlineEntry(content.replace(/\s+/g, " ")));
	}
	return structural.slice(0, 8);
}

function buildStructureOutline(
	sections: Array<{ label?: string; previewText: string }>,
): { text: string; outline: string[] } {
	const outlineLines: string[] = [];
	const detailOutline: string[] = [];
	const useSectionLabels = sections.length > 1;

	for (const section of sections) {
		const entries = collectOutlineEntries(section.previewText);
		if (entries.length === 0) continue;
		if (useSectionLabels && section.label) {
			outlineLines.push(`- ${section.label}`);
		}
		for (const entry of entries) {
			outlineLines.push(useSectionLabels ? `  - ${entry}` : `- ${entry}`);
			detailOutline.push(section.label ? `${section.label}: ${entry}` : entry);
		}
	}

	if (outlineLines.length === 0) {
		return { text: "", outline: [] };
	}
	return {
		text: ["Structure outline:", ...outlineLines].join("\n"),
		outline: detailOutline,
	};
}

// ─── Range previews ─────────────────────────────────────────────────────

function formatRequestedRangePreviews(
	text: string,
	ranges: ReturnRange[],
	precomputedHashes?: string[],
): { text: string; returnedRanges: ReturnedRangePreview[] } {
	const totalLines = getVisibleLines(text).length;
	const returnedRanges = ranges.map((range) => {
		const requestedEnd = range.end ?? range.start;
		const preview = formatHashlineReadPreview(
			text,
			{
				offset: range.start,
				limit: requestedEnd - range.start + 1,
			},
			precomputedHashes,
		);
		const hasReturnedLines = /^\s*[A-Za-z0-9_\-]{4}│/m.test(preview.text);
		const actualEnd = hasReturnedLines
			? preview.nextOffset !== undefined
				? preview.nextOffset - 1
				: Math.min(requestedEnd, totalLines)
			: requestedEnd;
		return {
			start: range.start,
			end: hasReturnedLines ? Math.max(range.start, actualEnd) : actualEnd,
			text: preview.text,
			...(preview.nextOffset !== undefined
				? { nextOffset: preview.nextOffset }
				: {}),
			...(!hasReturnedLines ? { empty: true as const } : {}),
		};
	});

	const formatted = returnedRanges
		.map(
			(range, index) =>
				`--- Range ${index + 1} ---\n${range.text}`,
		)
		.join("\n\n");

	return {
		text: formatted,
		returnedRanges,
	};
}

// ─── Builders ───────────────────────────────────────────────────────────

export function buildNoopResponse(input: NoopResponseInput): ToolResult {
	const {
		path,
		returnMode,
		requestedReturnRanges,
		noopEdits,
		originalNormalized,
		snapshotId,
		editMeta,
		warnings,
	} = input;

	const noopDetailsText = noopEdits?.length
		? noopEdits
				.map(
					(edit) =>
						`Edit ${edit.editIndex}: replacement for ${edit.loc} is identical to current content:\n  ${edit.loc}: ${edit.currentContent}`,
				)
				.join("\n")
		: "The edits produced identical content.";

	const fullPreview =
		returnMode === "full"
			? formatHashlineReadPreview(originalNormalized, { offset: 1 })
			: undefined;
	const rangePreviews =
		returnMode === "ranges"
			? formatRequestedRangePreviews(
					originalNormalized,
					requestedReturnRanges!,
				)
			: undefined;
	const outline =
		returnMode === "full"
			? buildStructureOutline([{ previewText: fullPreview!.text }])
			: returnMode === "ranges"
				? buildStructureOutline(
						rangePreviews!.returnedRanges.map((range, index) => ({
							label: `Range ${index + 1} (lines ${range.start}-${range.end})`,
							previewText: range.text,
						})),
					)
				: undefined;

	const text =
		returnMode === "full"
			? `No changes made to ${path}\nClassification: noop${outlineBlockOf(outline!.text)}\n\nFull content is available in details.fullContent.`
			: returnMode === "ranges"
				? `No changes made to ${path}\nClassification: noop${outlineBlockOf(outline!.text)}\n\nRequested range payloads are available in details.returnedRanges.`
				: `No changes made to ${path}\nClassification: noop\n${noopDetailsText}`;

	const metrics = buildMetrics({
		classification: "noop",
		returnMode,
		editsAttempted: editMeta.editsAttempted,
		noopEditsCount: editMeta.noopEditsCount,
		warningsCount: warnings?.length ?? 0,
	});

	return {
		content: [{ type: "text", text }],
		details: {
			diff: "",
			firstChangedLine: undefined,
			snapshotId,
			classification: "noop" as const,
			...(fullPreview?.nextOffset !== undefined
				? { nextOffset: fullPreview.nextOffset }
				: {}),
			...(fullPreview
				? {
						fullContent: {
							text: fullPreview.text,
							...(fullPreview.nextOffset !== undefined
								? { nextOffset: fullPreview.nextOffset }
								: {}),
						},
					}
				: {}),
			...(rangePreviews
				? { returnedRanges: rangePreviews.returnedRanges }
				: {}),
			...(outline ? { structureOutline: outline.outline } : {}),
			metrics,
		},
	};
}

export function buildFullResponse(input: SuccessResponseInput): ToolResult {
	const { path, result, warnings, snapshotId, originalNormalized, editMeta } =
		input;

	const diffResult = generateDiffString(originalNormalized, result);
	const resultHashes = input.resultHashes ?? computeLineHashes(result);
	const fullPreview = formatHashlineReadPreview(
		result,
		{ offset: 1 },
		resultHashes,
	);
	const outline = buildStructureOutline([{ previewText: fullPreview.text }]);
	const text = `Updated ${path}${warningsBlockOf(warnings)}${outlineBlockOf(outline.text)}\n\nFull content is available in details.fullContent.`;

	const metrics = buildMetrics({
		classification: "applied",
		returnMode: "full",
		editsAttempted: editMeta.editsAttempted,
		noopEditsCount: editMeta.noopEditsCount,
		warningsCount: warnings?.length ?? 0,
		firstChangedLine: editMeta.firstChangedLine,
		lastChangedLine: editMeta.lastChangedLine,
	});

	return {
		content: [{ type: "text", text }],
		details: {
			diff: diffResult.diff,
			firstChangedLine:
				editMeta.firstChangedLine ?? diffResult.firstChangedLine,
			snapshotId,
			...(fullPreview.nextOffset !== undefined
				? { nextOffset: fullPreview.nextOffset }
				: {}),
			fullContent: {
				text: fullPreview.text,
				...(fullPreview.nextOffset !== undefined
					? { nextOffset: fullPreview.nextOffset }
					: {}),
			},
			structureOutline: outline.outline,
			metrics,
		},
	};
}

export function buildRangesResponse(input: SuccessResponseInput): ToolResult {
	const {
		path,
		result,
		warnings,
		snapshotId,
		originalNormalized,
		requestedReturnRanges,
		editMeta,
	} = input;

	const diffResult = generateDiffString(originalNormalized, result);
	const resultHashes = input.resultHashes ?? computeLineHashes(result);
	const rangePreviews = formatRequestedRangePreviews(
		result,
		requestedReturnRanges!,
		resultHashes,
	);
	const outline = buildStructureOutline(
		rangePreviews.returnedRanges.map((range, index) => ({
			label: `Range ${index + 1} (lines ${range.start}-${range.end})`,
			previewText: range.text,
		})),
	);
	const text = `Updated ${path}${warningsBlockOf(warnings)}${outlineBlockOf(outline.text)}\n\nRequested range payloads are available in details.returnedRanges.`;

	const metrics = buildMetrics({
		classification: "applied",
		returnMode: "ranges",
		editsAttempted: editMeta.editsAttempted,
		noopEditsCount: editMeta.noopEditsCount,
		warningsCount: warnings?.length ?? 0,
		firstChangedLine: editMeta.firstChangedLine,
		lastChangedLine: editMeta.lastChangedLine,
	});

	return {
		content: [{ type: "text", text }],
		details: {
			diff: diffResult.diff,
			firstChangedLine:
				editMeta.firstChangedLine ?? diffResult.firstChangedLine,
			snapshotId,
			returnedRanges: rangePreviews.returnedRanges,
			structureOutline: outline.outline,
			metrics,
		},
	};
}

export function buildChangedResponse(input: SuccessResponseInput): ToolResult {
	const { result, warnings, snapshotId, originalNormalized, editMeta } = input;

	const diffResult = generateDiffString(originalNormalized, result);
	const addedLines = countDiffLines(diffResult.diff, "+");
	const removedLines = countDiffLines(diffResult.diff, "-");
	const warningsBlock = warningsBlockOf(warnings);

	const resultLines = getVisibleLines(result);
	const resultHashes = input.resultHashes ?? computeLineHashes(result);
	const anchorRange = computeAffectedLineRange({
		firstChangedLine: editMeta.firstChangedLine,
		lastChangedLine: editMeta.lastChangedLine,
		resultLineCount: resultLines.length,
	});
	const anchorsBlock = anchorRange
		? (() => {
				const region = resultLines.slice(
					anchorRange.start - 1,
					anchorRange.end,
				);
				const regionHashes = resultHashes.slice(
					anchorRange.start - 1,
					anchorRange.end,
				);
			const formatted = formatHashlineRegion(regionHashes, region);
				const block = `--- Anchors ---\n${formatted}`;
				return Buffer.byteLength(block, "utf8") <=
					CHANGED_ANCHOR_TEXT_BUDGET_BYTES
					? block
					: "Anchors omitted; use read for subsequent edits.";
			})()
		: resultLines.length === 0
			? "File is empty. Use edit to insert content."
			: "Anchors omitted; use read for subsequent edits.";

	const text = [anchorsBlock, warningsBlock.trimStart()]
		.filter((section) => section.length > 0)
		.join("\n\n");

	const metrics = buildMetrics({
		classification: "applied",
		returnMode: "changed",
		editsAttempted: editMeta.editsAttempted,
		noopEditsCount: editMeta.noopEditsCount,
		warningsCount: warnings?.length ?? 0,
		firstChangedLine: editMeta.firstChangedLine,
		lastChangedLine: editMeta.lastChangedLine,
		addedLines,
		removedLines,
	});

	return {
		content: [{ type: "text", text }],
		details: {
			diff: diffResult.diff,
			firstChangedLine:
				editMeta.firstChangedLine ?? diffResult.firstChangedLine,
			snapshotId,
			metrics,
		},
	};
}
