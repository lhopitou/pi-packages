/**
 * Soft suggestion: fires ctx.ui.notify() once per session when context
 * usage crosses a configurable threshold, suggesting /om:handover.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Runtime } from "../runtime.ts";

export function registerHandoverSuggest(pi: ExtensionAPI, runtime: Runtime): void {
	pi.on("turn_end", async (event, ctx) => {
		if (runtime.handoverSuggested) return;
		if (runtime.config.passive === true) return;

		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens == null) return;

		const threshold = runtime.config.handoverSuggestTokens;
		if (usage.tokens < threshold) return;

		runtime.handoverSuggested = true;
		ctx.ui.notify(
			`pi-om: context usage is ~${usage.tokens.toLocaleString()} tokens (threshold: ${threshold.toLocaleString()}). Consider calling /om:handover to start a fresh session with a distilled handoff.`,
			"info",
		);
	});
}
