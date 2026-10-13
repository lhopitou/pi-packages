import { Markdown, Text } from "@earendil-works/pi-tui";
import type {
	ExtensionAPI,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { constants } from "fs";
import { readFileSync } from "fs";
import { access as fsAccess } from "fs/promises";
import {
	detectLineEnding,
	generateDiffString,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
} from "./replace-diff";
import { normalizeReplaceRequest } from "./replace-normalize";
import { isRecord, hasOwn } from "./utils";
import { resolveMutationTargetPath, writeFileAtomically } from "./fs-write";
import {
	applyHashlineEdits,
	computeLineHashes,
	resolveEditAnchors,
	type HashlineToolEdit,
} from "./hashline";
import { loadFileKindAndText } from "./file-kind";
import { resolveToCwd } from "./path-utils";
import { throwIfAborted } from "./runtime";
import { getFileSnapshot } from "./snapshot";
import {
	buildChangedResponse,
	buildFullResponse,
	buildNoopResponse,
	buildRangesResponse,
	type ReplaceMeta,
	type ReturnMode,
} from "./replace-response";
import {
	buildAppliedChangedResultText,
	createRenderedEditMarkdownTheme,
	formatEditCall,
	formatRenderedEditResultMarkdown,
	getRenderablePreviewInput,
	getRenderedEditTextContent,
	isAppliedChangedResult,
	type ReplacePreview,
	type ReplaceRenderState,
} from "./replace-render";

function stringEnumSchema<const Values extends readonly string[]>(
	values: Values,
	options: { description: string },
) {
	return Type.Unsafe<Values[number]>({
		type: "string",
		enum: [...values],
		description: options.description,
	});
}

const hashlineEditLinesSchema = Type.Array(Type.String(), {
	description:
		"replacement content, one array entry per line, no HASH| prefix",
});

const returnRangeSchema = Type.Object(
	{
		start: Type.Integer({
			minimum: 1,
			description: "first post-edit line to return",
		}),
		end: Type.Optional(
			Type.Integer({
				minimum: 1,
				description: "last post-edit line to return",
			}),
		),
	},
	{ additionalProperties: false },
);

const hashlineEditItemSchema = Type.Object(
	{
		start: Type.Optional(
			Type.String({
				description:
					"required range-start anchor (hash anchor like \"aB3x\" copied from read output); no content may follow the anchor",
			}),
		),
		end: Type.Optional(
			Type.String({
				description:
					"required range-end anchor (hash anchor like \"aB3x\"). To replace a single line, set start = end = the line's anchor",
			}),
		),
		lines: Type.Optional(hashlineEditLinesSchema),
	},
	{ additionalProperties: false },
);
export const hashlineEditToolSchema = Type.Object(
	{
		path: Type.String({ description: "path" }),
		returnMode: Type.Optional(
			stringEnumSchema(["changed", "full", "ranges"] as const, {
				description: 'response mode: "changed", "full", or "ranges"',
			}),
		),
		returnRanges: Type.Optional(
			Type.Array(returnRangeSchema, {
				description: "post-edit line ranges when returnMode is ranges",
			}),
		),
		edits: Type.Optional(
			Type.Array(hashlineEditItemSchema, { description: "edits over $path" }),
		),
	},
	{ additionalProperties: false },
);

type ReturnRange = {
	start: number;
	end?: number;
};

type ReturnedRangePreview = {
	start: number;
	end: number;
	text: string;
	nextOffset?: number;
	empty?: true;
};

type FullContentPreview = {
	text: string;
	nextOffset?: number;
};

export type ReplaceRequestParams = {
	path: string;
	returnMode?: "changed" | "full" | "ranges";
	returnRanges?: ReturnRange[];
	edits?: HashlineToolEdit[];
};

type ReplaceMetrics = {
	edits_attempted: number;
	edits_noop: number;
	warnings: number;
	return_mode: "changed" | "full" | "ranges";
	classification: "applied" | "noop";
	changed_lines?: { first: number; last: number };
	added_lines?: number;
	removed_lines?: number;
};

export type HashlineReplaceToolDetails = {
	diff: string;
	firstChangedLine?: number;
	/**
	 * Post-edit snapshot fingerprint. Surfaced in details only — the LLM no
	 * longer receives or echoes it. Hosts may use this for UI hints (e.g.
	 * "file changed since last view"). See plan W2.
	 */
	snapshotId?: string;
	classification?: "noop";
	nextOffset?: number;
	fullContent?: FullContentPreview;
	returnedRanges?: ReturnedRangePreview[];
	structureOutline?: string[];
	/**
	 * Phase 2 C — opt-in observability surface for hosts. Never echoed in text.
	 * Hosts can use it for adoption/regression dashboards.
	 */
	metrics?: ReplaceMetrics;
};

const EDIT_DESC = readFileSync(
	new URL("../prompts/replace.md", import.meta.url),
	"utf-8",
).trim();

const EDIT_PROMPT_SNIPPET = readFileSync(
	new URL("../prompts/replace-snippet.md", import.meta.url),
	"utf-8",
).trim();


const EDIT_PROMPT_GUIDELINES = readFileSync(
	new URL("../prompts/replace-guidelines.md", import.meta.url),
	"utf-8",
)
	.split("\n")
	.map((line) => line.trim())
	.filter((line) => line.startsWith("- "))
	.map((line) => line.slice(2));
const ROOT_KEYS = new Set(["path", "returnMode", "returnRanges", "edits"]);

export function assertReplaceRequest(
	request: unknown,
): asserts request is ReplaceRequestParams {
	if (!isRecord(request)) {
		throw new Error("[E_BAD_SHAPE] Edit request must be an object.");
	}

	for (const legacyKey of ["oldText", "newText", "old_text", "new_text"]) {
		if (hasOwn(request, legacyKey)) {
			throw new Error(
				`[E_LEGACY_SHAPE] "${legacyKey}" is not supported. Use {start:"<HASH>", end:"<HASH>", lines:[...]}.`
			);
		}
	}

	const unknownRootKeys = Object.keys(request).filter(
		(key) => !ROOT_KEYS.has(key),
	);
	if (unknownRootKeys.length > 0) {
		throw new Error(
			`[E_BAD_SHAPE] Edit request contains unknown or unsupported fields: ${unknownRootKeys.join(", ")}.`,
		);
	}

	if (typeof request.path !== "string" || request.path.length === 0) {
		throw new Error('[E_BAD_SHAPE] Edit request requires a non-empty "path" string.');
	}

	if (hasOwn(request, "edits") && !Array.isArray(request.edits)) {
		throw new Error('[E_BAD_SHAPE] Edit request requires an "edits" array when provided.');
	}

	if (hasOwn(request, "returnMode")) {
		if (
			request.returnMode !== "changed" &&
			request.returnMode !== "full" &&
			request.returnMode !== "ranges"
		) {
			throw new Error(
				'[E_BAD_SHAPE] Edit request field "returnMode" must be "changed", "full", or "ranges" when provided.',
			);
		}
	}

	if (hasOwn(request, "returnRanges")) {
		if (
			!Array.isArray(request.returnRanges) ||
			request.returnRanges.length === 0
		) {
			throw new Error(
				'[E_BAD_SHAPE] Edit request field "returnRanges" must be a non-empty array when provided.',
			);
		}
		for (const [index, range] of request.returnRanges.entries()) {
			if (!isRecord(range)) {
				throw new Error(`[E_BAD_SHAPE] returnRanges[${index}] must be an object.`);
			}
			if (!Number.isInteger(range.start) || (range.start as number) < 1) {
				throw new Error(
					`[E_BAD_SHAPE] returnRanges[${index}].start must be a positive integer.`,
				);
			}
			if (hasOwn(range, "end")) {
				if (!Number.isInteger(range.end) || (range.end as number) < 1) {
					throw new Error(
						`[E_BAD_SHAPE] returnRanges[${index}].end must be a positive integer when provided.`,
					);
				}
				if ((range.end as number) < (range.start as number)) {
					throw new Error(`[E_BAD_SHAPE] returnRanges[${index}].end must be >= start.`);
				}
			}
		}
	}

	if (request.returnMode === "ranges") {
		if (
			!Array.isArray(request.returnRanges) ||
			request.returnRanges.length === 0
		) {
			throw new Error(
				'[E_BAD_SHAPE] Edit request with returnMode "ranges" requires a non-empty "returnRanges" array.',
			);
		}
	} else if (hasOwn(request, "returnRanges")) {
		throw new Error(
			'[E_BAD_SHAPE] Edit request field "returnRanges" is only supported when returnMode is "ranges".',
		);
	}

}

async function executeEditPipeline(
	request: unknown,
	cwd: string,
	accessMode: number,
	signal?: AbortSignal,
): Promise<{
	path: string;
	toolEdits: HashlineToolEdit[];
	originalNormalized: string;
	result: string;
	bom: string;
	originalEnding: "\r\n" | "\n";
	hadUtf8DecodeErrors: boolean;
	warnings: string[];
	noopEdits?: { editIndex: number; loc: string; currentContent: string }[];
	firstChangedLine?: number;
	lastChangedLine?: number;
	originalHashes?: string[];
}> {
	const normalized = normalizeReplaceRequest(request);
	assertReplaceRequest(normalized);

	const params = normalized;
	const path = params.path;
	const absolutePath = resolveToCwd(path, cwd);
	const toolEdits = Array.isArray(params.edits)
		? (params.edits as HashlineToolEdit[])
		: [];

	if (toolEdits.length === 0) {
		throw new Error("[E_BAD_SHAPE] Edit request requires a non-empty \"edits\" array.");
	}

	throwIfAborted(signal);
	try {
		await fsAccess(absolutePath, accessMode);
	} catch (error: unknown) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			throw new Error(`File not found: ${path}`);
		}
		if (code === "EACCES" || code === "EPERM") {
			const accessLabel =
				accessMode & constants.W_OK ? "not writable" : "not readable";
			throw new Error(`File is ${accessLabel}: ${path}`);
		}
		throw new Error(`Cannot access file: ${path}`);
	}

	throwIfAborted(signal);
	const file = await loadFileKindAndText(absolutePath);
	if (file.kind === "directory") {
		throw new Error(
			`Path is a directory: ${path}. Use ls to inspect directories.`,
		);
	}
	if (file.kind === "image") {
		throw new Error(
			`Path is an image file: ${path}. Hashline edit only supports text files.`,
		);
	}
	if (file.kind === "binary") {
		throw new Error(
			`Path is a binary file: ${path} (${file.description}). Hashline edit only supports text files.`,
		);
	}

	throwIfAborted(signal);
	const { bom, text: rawContent } = stripBom(file.text);
	const originalEnding = detectLineEnding(rawContent);
	const originalNormalized = normalizeToLF(rawContent);

	const originalHashes = computeLineHashes(originalNormalized);

	const resolved = resolveEditAnchors(toolEdits);
	const anchorResult = applyHashlineEdits(
		originalNormalized,
		resolved,
		signal,
		originalHashes,
	);

	return {
		path,
		toolEdits,
		originalNormalized,
		result: anchorResult.content,
		bom,
		originalEnding,
		hadUtf8DecodeErrors: file.hadUtf8DecodeErrors === true,
		warnings: [...(anchorResult.warnings ?? [])],
		noopEdits: anchorResult.noopEdits,
		firstChangedLine: anchorResult.firstChangedLine,
		lastChangedLine: anchorResult.lastChangedLine,
		originalHashes,
	};
}

export async function computeReplacePreview(
	request: unknown,
	cwd: string,
): Promise<ReplacePreview> {
	try {
		const { path, originalNormalized, result } = await executeEditPipeline(
			request,
			cwd,
			constants.R_OK,
		);

		if (originalNormalized === result) {
			return {
				error: `No changes made to ${path}. The edits produced identical content.`,
			};
		}

		return { diff: generateDiffString(originalNormalized, result, 4, computeLineHashes(result)).diff };
	} catch (error: unknown) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

type EditToolDefinition = ToolDefinition<
	typeof hashlineEditToolSchema,
	HashlineReplaceToolDetails,
	ReplaceRenderState
> & { renderShell?: "default" | "self" };

const editToolDefinition: EditToolDefinition = {
	name: "replace",
	label: "Replace",
	description: EDIT_DESC,
	parameters: hashlineEditToolSchema,
	promptSnippet: EDIT_PROMPT_SNIPPET,
	promptGuidelines: EDIT_PROMPT_GUIDELINES,
	prepareArguments: (args: unknown) =>
		normalizeReplaceRequest(args) as ReplaceRequestParams,
	renderShell: "default",
	renderCall(args, theme, context) {
		const previewInput = getRenderablePreviewInput(args);
		if (context.executionStarted) {
			context.state.argsKey = undefined;
			context.state.preview = undefined;
			context.state.previewGeneration =
				(context.state.previewGeneration ?? 0) + 1;
		} else if (!context.argsComplete || !previewInput) {
			context.state.argsKey = undefined;
			context.state.preview = undefined;
			context.state.previewGeneration =
				(context.state.previewGeneration ?? 0) + 1;
		} else {
			const argsKey = JSON.stringify(previewInput);
			if (context.state.argsKey !== argsKey) {
				context.state.argsKey = argsKey;
				context.state.preview = undefined;
				const previewGeneration = (context.state.previewGeneration ?? 0) + 1;
				context.state.previewGeneration = previewGeneration;
				computeReplacePreview(previewInput, context.cwd)
					.then((preview) => {
						if (
							context.state.argsKey === argsKey &&
							context.state.previewGeneration === previewGeneration
						) {
							context.state.preview = preview;
							context.invalidate();
						}
					})
					.catch((err: unknown) => {
						if (
							context.state.argsKey === argsKey &&
							context.state.previewGeneration === previewGeneration
						) {
							context.state.preview = {
								error: err instanceof Error ? err.message : String(err),
							};
							context.invalidate();
						}
					});
			}
		}
		const text =
			(context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		text.setText(
			formatEditCall(
				getRenderablePreviewInput(args) ?? undefined,
				context.state as ReplaceRenderState,
				context.expanded,
				theme,
			),
		);
		return text;
	},

	renderResult(result, { isPartial }, theme, context) {
		if (isPartial) {
			const text =
				(context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(theme.fg("warning", "Editing..."));
			return text;
		}

		const typedResult = result as {
			content?: Array<{ type: string; text?: string }>;
			details?: HashlineReplaceToolDetails;
		};
		const renderedText = getRenderedEditTextContent(typedResult);

		const renderState = context.state as ReplaceRenderState | undefined;
		const previewBeforeResult = renderState?.preview;
		if (renderState) {
			renderState.preview = undefined;
			renderState.previewGeneration = (renderState.previewGeneration ?? 0) + 1;
		}

		if (context.isError) {
			if (!renderedText) {
				return new Text("", 0, 0);
			}
			const text =
				context.lastComponent instanceof Text
					? context.lastComponent
					: new Text("", 0, 0);
			text.setText(`\n${theme.fg("error", renderedText)}`);
			return text;
		}

		if (isAppliedChangedResult(typedResult.details)) {
			const appliedChangedText = buildAppliedChangedResultText(
				renderedText,
				typedResult.details,
				previewBeforeResult,
				theme,
			);
			if (!appliedChangedText) {
				return new Text("", 0, 0);
			}
			const text =
				context.lastComponent instanceof Text
					? context.lastComponent
					: new Text("", 0, 0);
			text.setText(appliedChangedText);
			return text;
		}

		if (!renderedText) {
			return new Text("", 0, 0);
		}

		const markdown =
			context.lastComponent instanceof Markdown
				? context.lastComponent
				: new Markdown("", 0, 0, createRenderedEditMarkdownTheme(theme));
		markdown.setText(formatRenderedEditResultMarkdown(renderedText));
		return markdown;
	},

	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		const normalized = normalizeReplaceRequest(params);
		assertReplaceRequest(normalized);
		const normalizedParams = normalized;
		const path = normalizedParams.path;
		const absolutePath = resolveToCwd(path, ctx.cwd);
		const returnMode = normalizedParams.returnMode ?? "changed";
		const requestedReturnRanges = normalizedParams.returnRanges;

		const mutationTargetPath = await resolveMutationTargetPath(absolutePath);
		return withFileMutationQueue(mutationTargetPath, async () => {
			throwIfAborted(signal);

			const {
				originalNormalized,
				result,
				bom,
				originalEnding,
				hadUtf8DecodeErrors,
				warnings,
				noopEdits,
				firstChangedLine,
				lastChangedLine,
			} = await executeEditPipeline(
				normalized,
				ctx.cwd,
				constants.R_OK | constants.W_OK,
				signal,
			);

			const editsAttempted = Array.isArray(normalizedParams.edits)
				? normalizedParams.edits.length
				: 0;

			if (originalNormalized === result) {
				const noopSnapshotId = (await getFileSnapshot(absolutePath)).snapshotId;
				return buildNoopResponse({
					path,
					returnMode: returnMode as ReturnMode,
					requestedReturnRanges,
					noopEdits,
					originalNormalized,
					snapshotId: noopSnapshotId,
					editMeta: {
						editsAttempted,
						noopEditsCount: noopEdits?.length ?? 0,
					},
					warnings,
				});
			}

			if (hadUtf8DecodeErrors) {
				warnings.push(
					"Non-UTF-8 bytes were shown as U+FFFD; this edit rewrote the file as UTF-8.",
				);
			}

			throwIfAborted(signal);
			await writeFileAtomically(
				absolutePath,
				bom + restoreLineEndings(result, originalEnding),
			);
			const updatedSnapshotId = (await getFileSnapshot(absolutePath))
				.snapshotId;

			const editMeta: ReplaceMeta = {
				editsAttempted,
				noopEditsCount: noopEdits?.length ?? 0,
				firstChangedLine,
				lastChangedLine,
			};

			const successInput = {
				path,
				returnMode: returnMode as ReturnMode,
				requestedReturnRanges,
				originalNormalized,
				result,
				resultHashes: computeLineHashes(result),
				warnings,
				snapshotId: updatedSnapshotId,
				editMeta,
			};

			if (returnMode === "full") return buildFullResponse(successInput);
			if (returnMode === "ranges") return buildRangesResponse(successInput);
			return buildChangedResponse(successInput);
		});
	},
};

export function registerReplaceTool(pi: ExtensionAPI): void {
	pi.registerTool(editToolDefinition);
}
