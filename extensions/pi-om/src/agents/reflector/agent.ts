// NOTE: agentLoop, AgentContext, AgentLoopConfig, and AgentTool are only available
// from the internal @earendil-works/pi-agent-core package. The public SDK
// (@earendil-works/pi-coding-agent) does not re-export these. The public SDK's
// `complete`/`completeSimple` from @earendil-works/pi-ai are lower-level
// streaming APIs without tool execution. Using agentLoop is the only way to
// get LLM+tool loop behavior in an extension. This dependency is declared in
// the root package.json alongside @earendil-works/pi-coding-agent.
import { agentLoop, type AgentContext, type AgentLoopConfig, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Message, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import type { Static } from "typebox";
import { debugLog } from "../../debug-log.ts";
import { hashId, accumulateWithCollisionCheck } from "../../ids.ts";
import { AGENT_LOOP_MAX_TOKENS, boundedMaxTokens } from "../../model-budget.ts";
import { truncateRecordContent } from "../../serialize.ts";
import { REFLECTOR_SYSTEM } from "./prompts.ts";
import { estimateStringTokens } from "../../tokens.ts";
import { reflectionToSummaryLine, type Observation, type Reflection } from "../../ledger/index.ts";
import {
	coverageTierForObservation,
	reflectionCoverageMap,
	summarizeCoverageByRelevance,
	summarizeCoverageTransitionsByRelevance,
	type ReflectionCoverageTier,
} from "../dropper/coverage.ts";

interface RunReflectorArgs {
	model: Model<any>;
	apiKey: string;
	headers?: Record<string, string>;
	reflections: Reflection[];
	observations: Observation[];
	signal?: AbortSignal;
	agentLoop?: typeof agentLoop;
	maxTurns?: number;
	thinkingLevel?: ModelThinkingLevel;
}

const RecordReflectionsSchema = Type.Object({
	reflections: Type.Array(
		Type.Object({
			content: Type.String({ minLength: 1 }),
			supportingObservationIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
		}),
		{ minItems: 1 },
	),
});

type RecordReflectionsArgs = Static<typeof RecordReflectionsSchema>;

function joinOrEmpty(items: string[]): string {
	return items.length ? items.join("\n") : "(none yet)";
}

export function observationToReflectorLine(
	observation: Observation,
	coverage: ReflectionCoverageTier,
): string {
	return `[${observation.id}] ${observation.timestamp} [${observation.relevance}] [coverage: ${coverage}] ${observation.content}`;
}

export function normalizeSupportingObservationIds(
	supportingObservationIds: readonly string[] | undefined,
	allowedObservationIds: readonly string[],
): string[] | undefined {
	if (!supportingObservationIds || supportingObservationIds.length === 0) return undefined;
	const allowedOrder = new Map<string, number>();
	for (let i = 0; i < allowedObservationIds.length; i++) {
		if (!allowedOrder.has(allowedObservationIds[i])) allowedOrder.set(allowedObservationIds[i], i);
	}

	const seen = new Set<string>();
	for (const id of supportingObservationIds) {
		if (!allowedOrder.has(id)) continue; // Skip invalid, keep valid
		seen.add(id);
	}
	if (seen.size === 0) return undefined;
	return Array.from(seen).sort((a, b) => (allowedOrder.get(a) ?? 0) - (allowedOrder.get(b) ?? 0));
}

function normalizeReflectionContent(content: string): string | undefined {
	const normalized = truncateRecordContent(content.trim());
	if (!normalized || /\r|\n/.test(normalized)) return undefined;
	return normalized;
}

export async function runReflector(args: RunReflectorArgs): Promise<Reflection[] | undefined> {
	const { model, apiKey, headers, reflections, observations, signal } = args;
	if (observations.length === 0) return undefined;

	const coverageById = reflectionCoverageMap(observations, reflections);
	debugLog("reflector.agent_start", {
		activeObservationCount: observations.length,
		reflectionCount: reflections.length,
		coverageSummaryByRelevance: summarizeCoverageByRelevance(observations, coverageById),
	});

	const allowedObservationIds = observations.map((observation) => observation.id);
	const existingReflectionIds = new Set(reflections.map((reflection) => reflection.id));
	const accumulated = new Map<string, Reflection>();

	const recordReflections: AgentTool<typeof RecordReflectionsSchema> = {
		name: "record_reflections",
		label: "Record reflections",
		description: "Record new durable reflections with supporting observation ids.",
		parameters: RecordReflectionsSchema,
		execute: async (_id, params: RecordReflectionsArgs) => {
			let added = 0;
			let duplicates = 0;
			let rejected = 0;
			for (const proposal of params.reflections) {
				const content = normalizeReflectionContent(proposal.content);
				const supportingObservationIds = normalizeSupportingObservationIds(proposal.supportingObservationIds, allowedObservationIds);
				if (!content || !supportingObservationIds) {
					rejected++;
					continue;
				}
				const id = hashId(content);
				if (existingReflectionIds.has(id)) {
					duplicates++;
					continue;
				}
				const inserted = accumulateWithCollisionCheck(accumulated, {
					id,
					content,
					supportingObservationIds,
					tokenCount: estimateStringTokens(content),
				}, "reflector");
				if (!inserted) {
					duplicates++; // same-run duplicate or collision
				} else {
					added++;
				}
			}
			return {
				content: [{ type: "text", text: `Recorded ${added} reflection${added === 1 ? "" : "s"}; ${duplicates} duplicate${duplicates === 1 ? "" : "s"}; ${rejected} rejected. Total this run: ${accumulated.size}.` }],
				details: { added, duplicates, rejected, total: accumulated.size },
			};
		},
	};

	const userText = `CURRENT REFLECTIONS:\n${joinOrEmpty(reflections.map(reflectionToSummaryLine))}\n\nCURRENT OBSERVATIONS:\n${joinOrEmpty(observations.map((observation) => observationToReflectorLine(observation, coverageTierForObservation(observation, coverageById))))}\n\nCrystallize any missing durable facts or patterns into new reflections. If nothing is stable enough, do not call the tool.`;
	const prompts: Message[] = [{ role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() }];
	const context: AgentContext = { systemPrompt: REFLECTOR_SYSTEM, messages: [], tools: [recordReflections as AgentTool<any>] };
	const reasoning = (model as { reasoning?: unknown }).reasoning;
	const thinkingLevel = args.thinkingLevel ?? "low";
	const effectiveMaxTurns = args.maxTurns && args.maxTurns > 0 ? args.maxTurns : undefined;
	let turnCount = 0;
	const config: AgentLoopConfig = {
		model,
		apiKey,
		headers,
		maxTokens: boundedMaxTokens(model, AGENT_LOOP_MAX_TOKENS),
		convertToLlm: (msgs) => msgs as Message[],
		toolExecution: "sequential",
		...(reasoning && thinkingLevel !== "off" ? { reasoning: thinkingLevel } : {}),
		...(effectiveMaxTurns !== undefined ? { shouldStopAfterTurn: () => ++turnCount >= effectiveMaxTurns } : {}),
	};

	const loop = args.agentLoop ?? agentLoop;
	const stream = loop(prompts, context, config, signal);
	for await (const _event of stream) {
		// Tool execution collects records.
	}
	await stream.result();
	const acceptedReflections = Array.from(accumulated.values());
	const afterCoverageById = reflectionCoverageMap(observations, [...reflections, ...acceptedReflections]);
	debugLog("reflector.result", {
		reason: acceptedReflections.length > 0 ? "accepted_nonempty" : "no_tool_call",
		acceptedReflectionCount: acceptedReflections.length,
		coverageTransitionsByRelevance: summarizeCoverageTransitionsByRelevance(observations, coverageById, afterCoverageById),
	});
	return acceptedReflections.length > 0 ? acceptedReflections : undefined;
}
