import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	recallMemorySources,
	type Entry,
	type RecallResult,
	type RecalledObservation,
} from "../ledger/recall.ts";
import type { Observation, Reflection } from "../ledger/index.ts";
import { renderRecallSourceEntries, renderRecallSourceEntry } from "../serialize.ts";

export const RECALL_OBSERVATION_TOOL_NAME = "recall";

const MEMORY_ID_PATTERN = /^[a-f0-9]{12}$/;

type RecallObservationToolDetails = {
	status: "ok" | "partial" | "invalid_id" | "not_found" | "no_source" | "source_unavailable";
	memoryId: string;
	observationId: string;
	collision: boolean;
	partial: boolean;
	message?: string;
};

function textResult(text: string, details: RecallObservationToolDetails) {
	return { content: [{ type: "text" as const, text }], details };
}

function emptyDetails(status: RecallObservationToolDetails["status"], memoryId: string, message: string): RecallObservationToolDetails {
	return {
		status,
		memoryId,
		observationId: memoryId,
		collision: false,
		partial: false,
		message,
	};
}

function renderObservationOnlyTextFromResult(result: Extract<RecallResult, { status: "found" }>): string {
	const sections: string[] = [];
	if (result.collision) sections.push(`Memory id ${result.memoryId} matched multiple observations; returning all matching source results.`);
	for (const match of result.observations.filter((m) => m.observation.id === result.memoryId)) {
		if (match.status === "dropped") sections.push(`Observation ${match.observation.id} is dropped from active memory but remains recallable.`);
		if (match.missingSourceEntryIds.length > 0) {
			sections.push(`Some source entries are unavailable: ${match.missingSourceEntryIds.join(", ")}`);
			continue;
		}
		if (match.sourceEntries.length === 0) {
			sections.push(`Observation ${match.observation.id} has no source entries associated with it.`);
			continue;
		}
		const sourceText = renderRecallSourceEntries(match.sourceEntries);
		sections.push(sourceText.trim() ? sourceText : `Observation ${match.observation.id} has source entries but they rendered no text content.`);
	}
	return sections.join("\n\n");
}

function renderMemoryText(result: Extract<RecallResult, { status: "found" }>): string {
	const sections: string[] = [];
	if (result.collision) sections.push(`Memory id ${result.memoryId} matched multiple items.`);
	if (result.reflections.length > 0) sections.push(`Reflections:\n${result.reflections.map((m) => `[${m.reflection.id}] ${m.reflection.content}`).join("\n")}`);
	if (result.observations.length > 0) sections.push(`Observations:\n${result.observations.map((m) => `[${m.observation.id}]${m.status === "dropped" ? " [dropped]" : ""} ${m.observation.timestamp} [${m.observation.relevance}] ${m.observation.content}`).join("\n")}`);
	const sourceText = renderRecallSourceEntries(result.sourceEntries);
	if (sourceText.trim()) sections.push(`Sources:\n${sourceText}`);
	return sections.join("\n\n");
}

export const recallObservationTool = defineTool({
	name: RECALL_OBSERVATION_TOOL_NAME,
	label: "Recall memory evidence",
	description:
		"Recover exact evidence and source context behind a compacted observational-memory observation or reflection id on the current branch. " +
		"Use when compressed memory is important and original source context is needed before acting.",
	promptSnippet: "Use recall(<id>) to recover exact source context behind compacted memory observations/reflections when precision matters.",
	promptGuidelines: [
		"Use recall before making an important decision that depends on a compacted observation or reflection whose details are unclear.",
		"Use recall when you need exact wording, rationale, file paths, commands, errors, commits, user constraints, or provenance behind a remembered claim.",
		"Do not use recall as semantic search or transcript browsing; you must already have a specific 12-character memory id.",
		"Do not recall every id preemptively. Recall only when exact source context will materially improve the next action.",
	],
	parameters: Type.Object({
		id: Type.String({
			pattern: "^[a-f0-9]{12}$",
			description: "12-character lowercase hex observation or reflection id shown in compacted memory.",
		}),
	}),
	renderCall(args) {
		return new Text(`recall ${args.id ?? "..."}`, 0, 0);
	},
	renderResult(result, options) {
		const text = result.content.filter((p): p is { type: "text"; text: string } => p.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n");
		return new Text(text || "recall", 0, 0);
	},
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const memoryId = params.id;
		if (!MEMORY_ID_PATTERN.test(memoryId)) {
			const message = `Memory id must be 12 lowercase hex characters. Received: ${memoryId}`;
			return textResult(message, emptyDetails("invalid_id", memoryId, message));
		}
		const branchEntries = ctx.sessionManager.getBranch() as Entry[];
		const result = recallMemorySources(branchEntries, memoryId);
		if (result.status === "not_found") {
			const message = `No observation or reflection with id ${memoryId} was found on the current branch.`;
			return textResult(message, emptyDetails("not_found", memoryId, message));
		}
		const text = result.kind === "observation" ? renderObservationOnlyTextFromResult(result) : renderMemoryText(result);
		const details: RecallObservationToolDetails = {
			status: result.partial ? "partial" : "ok" as const,
			memoryId: result.memoryId,
			observationId: result.memoryId,
			collision: result.collision,
			partial: result.partial,
		};
		return textResult(text, details);
	},
});

export function registerRecallTool(pi: ExtensionAPI): void {
	pi.registerTool(recallObservationTool);
}
