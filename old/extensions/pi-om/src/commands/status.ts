import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { observationPoolMetrics, observationTokenSum } from "../agents/dropper/pool.ts";
import type { Runtime } from "../runtime.ts";
import {
	diffProjection,
	foldLedger,
	fullProjection,
	rawTokensSinceLastCompaction,
	rawTokensSinceObservationCoverage,
	visibleProjection,
	type Entry,
} from "../ledger/index.ts";

function pct(current: number, total: number): number {
	return total > 0 ? Math.round((current / total) * 100) : 0;
}

function tokenSum(items: { tokenCount: number }[]): number {
	return items.reduce((sum, item) => sum + item.tokenCount, 0);
}

export function registerStatusCommand(pi: ExtensionAPI, runtime: Runtime): void {
	pi.registerCommand("om:status", {
		description: "Show pi-om memory status",
		handler: async (_args, ctx) => {
			await runtime.ensureConfig(ctx.cwd);
			const entries = ctx.sessionManager.getBranch() as Entry[];
			const folded = foldLedger(entries);
			const visible = visibleProjection(entries);
			const full = fullProjection(entries);
			const drift = diffProjection(visible, full);

			const visibleReflectionTokens = tokenSum(visible.reflections);
			const activeObservationPool = observationPoolMetrics(folded.activeObservations, runtime.config.observationsPoolTargetTokens);
			const obsProgress = rawTokensSinceObservationCoverage(entries);
			const reflectionProgress = observationTokenSum(folded.activeObservations);
			const compactionProgress = rawTokensSinceLastCompaction(entries);

			const lines = [
				"── Memory ──",
				`Observations: ${folded.observations.length} recorded / ${folded.droppedObservationIds.size} dropped / ${folded.activeObservations.length} live / ${visible.observations.length} in context${drift.observationsOnlyInFull.length > 0 ? ` +${drift.observationsOnlyInFull.length}` : ""}`,
				`Reflections:  ${folded.reflections.length} recorded / ${folded.supersededReflectionIds.size} superseded / ${folded.activeReflections.length} live / ${visible.reflections.length} in context${drift.reflectionsOnlyInFull.length > 0 ? ` +${drift.reflectionsOnlyInFull.length}` : ""}`,
				"",
				"── Activity ──",
				`Next observation: ~${obsProgress.toLocaleString()} / ${runtime.config.observeAfterTokens.toLocaleString()} tokens (${pct(obsProgress, runtime.config.observeAfterTokens)}%)`,
				`Next reflection:  ~${reflectionProgress.toLocaleString()} / ${runtime.config.reflectAfterTokens.toLocaleString()} obs tokens (${pct(reflectionProgress, runtime.config.reflectAfterTokens)}%)`,
				`Next compaction:  ~${compactionProgress.toLocaleString()} / ${runtime.config.compactAfterTokens.toLocaleString()} tokens (${pct(compactionProgress, runtime.config.compactAfterTokens)}%)`,
				`Live observation pool: ~${activeObservationPool.observationTokens.toLocaleString()} / ${runtime.config.observationsPoolTargetTokens.toLocaleString()} target tokens (${pct(activeObservationPool.observationTokens, runtime.config.observationsPoolTargetTokens)}%)`,
				`Reflection pool:         ~${visibleReflectionTokens.toLocaleString()} tokens`,
			];

			if (runtime.consolidationInFlight || runtime.compactInFlight || runtime.compactHookInFlight) {
				lines.push("", "── In flight ──");
				if (runtime.consolidationInFlight) lines.push(`Consolidation: running${runtime.consolidationPhase ? ` (${runtime.consolidationPhase})` : ""}`);
				if (runtime.compactInFlight) lines.push("Auto-compaction: running");
				if (runtime.compactHookInFlight) lines.push("Compaction hook: running");
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
