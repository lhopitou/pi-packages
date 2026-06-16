import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Runtime } from "../runtime.ts";
import {
	fullProjection,
	observationToSummaryLine,
	reflectionToSummaryLine,
	visibleProjection,
	type Entry,
	type Projection,
} from "../ledger/index.ts";

function renderList<T>(items: T[], render: (item: T) => string, empty: string): string {
	return items.length > 0 ? items.map(render).join("\n") : empty;
}

function renderContentOnlyProjection(projection: Projection, emptyScope: "visible" | "recorded"): string {
	return [
		"── Reflections ──",
		renderList(projection.reflections, reflectionToSummaryLine, `No ${emptyScope} reflections.`),
		"",
		"── Observations ──",
		renderList(projection.observations, observationToSummaryLine, `No ${emptyScope} observations.`),
	].join("\n");
}

export function registerViewCommand(pi: ExtensionAPI, runtime: Runtime): void {
	pi.registerCommand("om:view", {
		description: "Print observational memory content (visible by default, full for recorded memory)",
		handler: async (args, ctx) => {
			await runtime.ensureConfig(ctx.cwd);
			const entries = ctx.sessionManager.getBranch() as Entry[];
			const mode = typeof args === "string" ? args.trim().split(/\s+/)[0] : undefined;

			if (mode === "full") {
				ctx.ui.notify(renderContentOnlyProjection(fullProjection(entries), "recorded"), "info");
				return;
			}

			if (mode && mode !== "visible") {
				ctx.ui.notify("Usage: /om:view [full]", "info");
				return;
			}

			ctx.ui.notify(renderContentOnlyProjection(visibleProjection(entries), "visible"), "info");
		},
	});
}
