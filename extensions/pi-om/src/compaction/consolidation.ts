import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runDropper } from "../agents/dropper/agent.ts";
import { observationPoolMetrics, observationTokenSum } from "../agents/dropper/pool.ts";
import { runObserver } from "../agents/observer/agent.ts";
import { runReflector } from "../agents/reflector/agent.ts";
import { debugLog, withDebugLogContext } from "../debug-log.ts";
import { type ResolveResult, type Runtime } from "../runtime.ts";
import { serializeSourceAddressedBranchEntries } from "../serialize.ts";
import {
	OM_OBSERVATIONS_DROPPED,
	OM_OBSERVATIONS_RECORDED,
	OM_REFLECTIONS_RECORDED,
	OM_REFLECTIONS_SUPERSEDED,
	buildObservationsDroppedData,
	buildObservationsRecordedData,
	buildReflectionsRecordedData,
	buildReflectionsSupersededData,
	foldLedger,
	fullProjection,
	isSourceEntry,
	latestCoverageIndex,
	latestCoverageMarkerId,
	observationToSummaryLine,
	rawTokensSinceObservationCoverage,
	reflectionToSummaryLine,
	type Entry,
	type Reflection,
} from "../ledger/index.ts";

type ResolvedModel = Extract<ResolveResult, { ok: true }>;

export type ConsolidationCtx = {
	cwd: string;
	hasUI: boolean;
	ui?: { notify: (message: string, type?: "warning" | "info" | "error") => void };
	model: unknown;
	modelRegistry: any;
	sessionManager: {
		getBranch: () => unknown;
		getSessionId?: () => string;
		getSessionFile?: () => string | undefined;
	};
};

type StageOutcome = "continue" | "abort";

type ReflectorStageResult = {
	outcome: StageOutcome;
	sameRunReflections: Reflection[];
};

function sourceEntriesAfter(entries: Entry[], index: number): Entry[] {
	return entries.slice(index + 1).filter(isSourceEntry);
}

function appendEntry(pi: ExtensionAPI, customType: string, data: unknown): void {
	pi.appendEntry(customType, data);
}

function anyStageDue(entries: Entry[], runtime: Runtime): boolean {
	if (rawTokensSinceObservationCoverage(entries) >= runtime.config.observeAfterTokens) return true;
	const folded = foldLedger(entries);
	const obsTokens = observationTokenSum(folded.activeObservations);
	if (obsTokens >= runtime.config.reflectAfterTokens) return true;
	return false;
}

function makeModelResolver(runtime: Runtime, ctx: ConsolidationCtx): (stage: "observer" | "reflector" | "dropper") => Promise<ResolvedModel | undefined> {
	let cached: ResolveResult | undefined;
	return async (stage) => {
		cached ??= await runtime.resolveModel({
			model: ctx.model,
			modelRegistry: ctx.modelRegistry,
			hasUI: ctx.hasUI,
			ui: ctx.ui,
		});
		if (cached.ok) {
			runtime.resolveFailureNotified = false;
			return cached;
		}
		debugLog(`${stage}.model_unavailable`, { reason: cached.reason });
		if (!runtime.resolveFailureNotified && ctx.hasUI && ctx.ui) {
			ctx.ui.notify(`pi-om: ${stage} skipped — ${cached.reason}`, "warning");
			runtime.resolveFailureNotified = true;
		}
		return undefined;
	};
}

export function registerConsolidationTrigger(pi: ExtensionAPI, runtime: Runtime): void {
	const launch = async (_event: unknown, ctx: ConsolidationCtx) => {
		await maybeLaunchConsolidation(pi, runtime, ctx);
	};
	pi.on("agent_start", launch);
	pi.on("turn_end", launch);
}

function debugSessionMetadata(ctx: ConsolidationCtx): { sessionId?: string; sessionFile?: string } {
	try {
		return {
			sessionId: ctx.sessionManager.getSessionId?.(),
			sessionFile: ctx.sessionManager.getSessionFile?.(),
		};
	} catch {
		return {};
	}
}

async function maybeLaunchConsolidation(pi: ExtensionAPI, runtime: Runtime, ctx: ConsolidationCtx): Promise<void> {
	await runtime.ensureConfig(ctx.cwd);
	if (runtime.config.passive === true) return;
	if (runtime.consolidationInFlight) return;

	const entries = ctx.sessionManager.getBranch() as Entry[];
	if (!anyStageDue(entries, runtime)) return;

	const runId = `consolidation-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
	const consolidationCtx: ConsolidationCtx = {
		cwd: ctx.cwd,
		hasUI: ctx.hasUI,
		ui: ctx.ui,
		model: ctx.model,
		modelRegistry: ctx.modelRegistry,
		sessionManager: ctx.sessionManager,
	};

	const sessionMetadata = debugSessionMetadata(ctx);
	void runtime.launchConsolidationTask(ctx, async () => withDebugLogContext({
		enabled: runtime.config.debugLog === true,
		cwd: ctx.cwd,
		...sessionMetadata,
		runId,
	}, async () => {
		await runConsolidationPipeline(pi, runtime, consolidationCtx);
	}));
}

async function runConsolidationPipeline(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
): Promise<void> {
	const resolveModel = makeModelResolver(runtime, ctx);

	runtime.consolidationPhase = "observer";
	try {
		const observerOutcome = await runObserverStage(pi, runtime, ctx, resolveModel);
		if (observerOutcome === "abort") return;
	} catch (error) {
		debugLog("observer.error", { errorMessage: runtime.recordConsolidationStageError(ctx, "observer", error) });
		return;
	}

	runtime.consolidationPhase = "reflector";
	let reflectorResult: ReflectorStageResult;
	try {
		reflectorResult = await runReflectorStage(pi, runtime, ctx, resolveModel);
		if (reflectorResult.outcome === "abort") return;
	} catch (error) {
		debugLog("reflector.error", { errorMessage: runtime.recordConsolidationStageError(ctx, "reflector", error) });
		return;
	}

	// Dropper only runs as post-reflection maintenance: when the reflector
	// just produced new reflections, check if the observation pool is still
	// over target and prune if so.
	if (reflectorResult.sameRunReflections.length > 0) {
		runtime.consolidationPhase = "dropper";
		try {
			await runDropperStage(pi, runtime, ctx, resolveModel);
		} catch (error) {
			debugLog("dropper.error", { errorMessage: runtime.recordConsolidationStageError(ctx, "dropper", error) });
		}
	}
}

async function runObserverStage(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
	resolveModel: (stage: "observer") => Promise<ResolvedModel | undefined>,
): Promise<StageOutcome> {
	const entries = ctx.sessionManager.getBranch() as Entry[];
	const tokens = rawTokensSinceObservationCoverage(entries);
	if (tokens < runtime.config.observeAfterTokens) return "continue";

	const lastCoverageIdx = latestCoverageIndex(entries, OM_OBSERVATIONS_RECORDED);
	const chunkEntries = sourceEntriesAfter(entries, lastCoverageIdx);
	const coversUpToId = chunkEntries.at(-1)?.id;
	if (!coversUpToId) return "continue";

	const { text: chunk, sourceEntryIds } = serializeSourceAddressedBranchEntries(chunkEntries);
	if (!chunk.trim() || sourceEntryIds.length === 0) return "continue";

	const memory = fullProjection(entries);
	const priorReflections = memory.reflections.map(reflectionToSummaryLine);
	const priorObservations = memory.observations.map(observationToSummaryLine);

	if (ctx.hasUI) ctx.ui?.notify(
		`pi-om: observer running on ~${tokens.toLocaleString()}-token chunk`,
		"info",
	);

	const resolved = await resolveModel("observer");
	if (!resolved) return "abort";

	const observations = await runObserver({
		model: resolved.model as any,
		apiKey: resolved.apiKey,
		headers: resolved.headers,
		priorReflections,
		priorObservations,
		chunk,
		allowedSourceEntryIds: sourceEntryIds,
		maxTurns: runtime.config.agentMaxTurns,
		thinkingLevel: runtime.config.model?.thinking ?? "low",
	});
	if (!observations || observations.length === 0) return "continue";

	const data = buildObservationsRecordedData(observations, coversUpToId);
	if (!data) return "continue";
	appendEntry(pi, OM_OBSERVATIONS_RECORDED, data);
	if (ctx.hasUI) ctx.ui?.notify(
		`pi-om: ${observations.length} observation${observations.length === 1 ? "" : "s"} recorded`,
		"info",
	);
	return "continue";
}

async function runReflectorStage(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
	resolveModel: (stage: "reflector") => Promise<ResolvedModel | undefined>,
): Promise<ReflectorStageResult> {
	const entries = ctx.sessionManager.getBranch() as Entry[];
	const folded = foldLedger(entries);
	const obsTokens = observationTokenSum(folded.activeObservations);
	if (obsTokens < runtime.config.reflectAfterTokens) return { outcome: "continue", sameRunReflections: [] };

	const observationCoverageId = latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED);
	if (!observationCoverageId) return { outcome: "continue", sameRunReflections: [] };

	if (ctx.hasUI) ctx.ui?.notify(
		`pi-om: reflector running (~${obsTokens.toLocaleString()} observation tokens)`,
		"info",
	);
	const resolved = await resolveModel("reflector");
	if (!resolved) return { outcome: "abort", sameRunReflections: [] };
	const result = await runReflector({
		model: resolved.model as any,
		apiKey: resolved.apiKey,
		headers: resolved.headers,
		reflections: folded.activeReflections,
		observations: folded.activeObservations,
		maxTurns: runtime.config.agentMaxTurns,
		thinkingLevel: runtime.config.model?.thinking ?? "low",
	});
	if (!result) return { outcome: "continue", sameRunReflections: [] };

	if (result.reflections.length > 0) {
		const data = buildReflectionsRecordedData(result.reflections, observationCoverageId);
		if (data) appendEntry(pi, OM_REFLECTIONS_RECORDED, data);
	}

	if (result.supersededIds.length > 0) {
		const supersededData = buildReflectionsSupersededData(result.supersededIds, observationCoverageId);
		if (supersededData) appendEntry(pi, OM_REFLECTIONS_SUPERSEDED, supersededData);
	}

	// Drop observations now covered by new reflections (Mastra-aligned:
	// reflection replaces observations, same as observation replaces raw messages).
	const coveredIds = new Set<string>();
	for (const reflection of result.reflections) {
		for (const id of reflection.supportingObservationIds) coveredIds.add(id);
	}
	const activeObsIds = new Set(folded.activeObservations.map((obs) => obs.id));
	const droppableIds = [...coveredIds].filter((id) => activeObsIds.has(id));
	if (droppableIds.length > 0) {
		const dropData = buildObservationsDroppedData(droppableIds, observationCoverageId);
		if (dropData) appendEntry(pi, OM_OBSERVATIONS_DROPPED, dropData);
		if (ctx.hasUI) ctx.ui?.notify(
			`pi-om: ${droppableIds.length} covered observation${droppableIds.length === 1 ? "" : "s"} dropped (replaced by reflections)`,
			"info",
		);
	}

	return {
		outcome: "continue",
		sameRunReflections: result.reflections,
	};
}

/**
 * Force-run observer regardless of thresholds. Used by /om:handover to flush
 * all unobserved content before producing a handover summary.
 * Same logic as runObserverStage but without the threshold gate.
 * Minimum floor of 500 tokens prevents wasteful LLM calls on trivial content.
 */
async function forceRunObserverStage(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
	resolveModel: (stage: "observer") => Promise<ResolvedModel | undefined>,
): Promise<StageOutcome> {
	const entries = ctx.sessionManager.getBranch() as Entry[];
	const tokens = rawTokensSinceObservationCoverage(entries);
	if (tokens < 500) return "continue";

	const lastCoverageIdx = latestCoverageIndex(entries, OM_OBSERVATIONS_RECORDED);
	const chunkEntries = sourceEntriesAfter(entries, lastCoverageIdx);
	const coversUpToId = chunkEntries.at(-1)?.id;
	if (!coversUpToId) return "continue";

	const { text: chunk, sourceEntryIds } = serializeSourceAddressedBranchEntries(chunkEntries);
	if (!chunk.trim() || sourceEntryIds.length === 0) return "continue";

	const memory = fullProjection(entries);
	const priorReflections = memory.reflections.map(reflectionToSummaryLine);
	const priorObservations = memory.observations.map(observationToSummaryLine);

	if (ctx.hasUI) ctx.ui?.notify(
		`pi-om: flush-observer running on ~${tokens.toLocaleString()}-token chunk`,
		"info",
	);

	const resolved = await resolveModel("observer");
	if (!resolved) return "abort";

	const observations = await runObserver({
		model: resolved.model as any,
		apiKey: resolved.apiKey,
		headers: resolved.headers,
		priorReflections,
		priorObservations,
		chunk,
		allowedSourceEntryIds: sourceEntryIds,
		maxTurns: runtime.config.agentMaxTurns,
		thinkingLevel: runtime.config.model?.thinking ?? "low",
	});
	if (!observations || observations.length === 0) return "continue";

	const data = buildObservationsRecordedData(observations, coversUpToId);
	if (!data) return "continue";
	appendEntry(pi, OM_OBSERVATIONS_RECORDED, data);
	if (ctx.hasUI) ctx.ui?.notify(
		`pi-om: ${observations.length} observation${observations.length === 1 ? "" : "s"} recorded (flush)`,
		"info",
	);
	return "continue";
}

/**
 * Force-run reflector regardless of thresholds. Used by /om:handover to flush
 * all unreflected observations before producing a handover summary.
 * Same logic as runReflectorStage but without the threshold gate.
 * Runs if there are any active observations with tokens > 0.
 */
async function forceRunReflectorStage(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
	resolveModel: (stage: "reflector") => Promise<ResolvedModel | undefined>,
): Promise<ReflectorStageResult> {
	const entries = ctx.sessionManager.getBranch() as Entry[];
	const folded = foldLedger(entries);
	const obsTokens = observationTokenSum(folded.activeObservations);
	if (obsTokens <= 0) return { outcome: "continue", sameRunReflections: [] };

	const observationCoverageId = latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED);
	if (!observationCoverageId) return { outcome: "continue", sameRunReflections: [] };

	if (ctx.hasUI) ctx.ui?.notify(
		`pi-om: flush-reflector running (~${obsTokens.toLocaleString()} observation tokens)`,
		"info",
	);
	const resolved = await resolveModel("reflector");
	if (!resolved) return { outcome: "abort", sameRunReflections: [] };
	const result = await runReflector({
		model: resolved.model as any,
		apiKey: resolved.apiKey,
		headers: resolved.headers,
		reflections: folded.activeReflections,
		observations: folded.activeObservations,
		maxTurns: runtime.config.agentMaxTurns,
		thinkingLevel: runtime.config.model?.thinking ?? "low",
	});
	if (!result) return { outcome: "continue", sameRunReflections: [] };

	if (result.reflections.length > 0) {
		const data = buildReflectionsRecordedData(result.reflections, observationCoverageId);
		if (data) appendEntry(pi, OM_REFLECTIONS_RECORDED, data);
	}

	if (result.supersededIds.length > 0) {
		const supersededData = buildReflectionsSupersededData(result.supersededIds, observationCoverageId);
		if (supersededData) appendEntry(pi, OM_REFLECTIONS_SUPERSEDED, supersededData);
	}

	// Drop observations now covered by new reflections
	const coveredIds = new Set<string>();
	for (const reflection of result.reflections) {
		for (const id of reflection.supportingObservationIds) coveredIds.add(id);
	}
	const activeObsIds = new Set(folded.activeObservations.map((obs) => obs.id));
	const droppableIds = [...coveredIds].filter((id) => activeObsIds.has(id));
	if (droppableIds.length > 0) {
		const dropData = buildObservationsDroppedData(droppableIds, observationCoverageId);
		if (dropData) appendEntry(pi, OM_OBSERVATIONS_DROPPED, dropData);
		if (ctx.hasUI) ctx.ui?.notify(
			`pi-om: ${droppableIds.length} covered observation${droppableIds.length === 1 ? "" : "s"} dropped (flush)`,
			"info",
		);
	}

	return {
		outcome: "continue",
		sameRunReflections: result.reflections,
	};
}

/**
 * Flush consolidation: force-run observer + reflector regardless of thresholds.
 * Used by /om:handover to ensure all unobserved content is captured before
 * producing a handover summary. Skips dropper — not needed for handover.
 */
export async function flushConsolidation(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
): Promise<void> {
	const resolveModel = makeModelResolver(runtime, ctx);

	runtime.consolidationPhase = "observer";
	try {
		const observerOutcome = await forceRunObserverStage(pi, runtime, ctx, resolveModel);
		if (observerOutcome === "abort") return;
	} catch (error) {
		debugLog("flush-observer.error", { errorMessage: runtime.recordConsolidationStageError(ctx, "observer", error) });
		return;
	}

	runtime.consolidationPhase = "reflector";
	try {
		await forceRunReflectorStage(pi, runtime, ctx, resolveModel);
	} catch (error) {
		debugLog("flush-reflector.error", { errorMessage: runtime.recordConsolidationStageError(ctx, "reflector", error) });
	}
}

async function runDropperStage(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
	resolveModel: (stage: "dropper") => Promise<ResolvedModel | undefined>,
): Promise<StageOutcome> {
	const entries = ctx.sessionManager.getBranch() as Entry[];
	const observationCoverageId = latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED);
	if (!observationCoverageId) return "continue";

	const folded = foldLedger(entries);
	const metrics = observationPoolMetrics(folded.activeObservations, runtime.config.observationsPoolTargetTokens);
	if (!metrics.ready) return "continue";

	if (ctx.hasUI) ctx.ui?.notify(
		`pi-om: dropper running — live pool ~${metrics.observationTokens.toLocaleString()} / ${metrics.targetTokens.toLocaleString()} target tokens`,
		"info",
	);
	const resolved = await resolveModel("dropper");
	if (!resolved) return "abort";

	const droppedIds = await runDropper({
		model: resolved.model as any,
		apiKey: resolved.apiKey,
		headers: resolved.headers,
		reflections: folded.activeReflections,
		observations: folded.activeObservations,
		targetTokens: runtime.config.observationsPoolTargetTokens,
		maxTurns: runtime.config.agentMaxTurns,
		thinkingLevel: runtime.config.model?.thinking ?? "low",
	});
	const data = droppedIds ? buildObservationsDroppedData(droppedIds, observationCoverageId) : undefined;
	if (data) appendEntry(pi, OM_OBSERVATIONS_DROPPED, data);
	return "continue";
}
