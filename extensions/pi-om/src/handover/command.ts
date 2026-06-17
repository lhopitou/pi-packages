/**
 * /om:handover command: flushes observations and reflections, renders a handover
 * summary directly, and starts a fresh session.
 *
 * Uses "flush + direct render" instead of spawning an LLM subprocess:
 * 1. Force-runs observer + reflector on all unobserved content
 * 2. Renders reflections + observations directly (no pi subprocess / LLM call)
 * 3. Strips ledger bookkeeping (IDs, relevance markers) and tags reflections
 *    as "Durable Facts"
 * 4. Starts a new session with the rendered handover summary
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import * as os from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Runtime } from "../runtime.ts";
import { flushConsolidation } from "../compaction/consolidation.ts";
import { fullProjection, renderHandoverSummary, type Entry } from "../ledger/index.ts";
import { persistHandoffContent } from "./injection.ts";

export const HANDOFF_CUSTOM_TYPE = "om.handoff";

export function registerHandoverCommand(pi: ExtensionAPI, runtime: Runtime): void {
	pi.registerCommand("om:handover", {
		description: "Produce a handover document and start a fresh session (optional: follow-up prompt)",
		handler: async (args, ctx) => {
			await runtime.ensureConfig(ctx.cwd);

			const followUpPrompt = typeof args === "string" ? args.trim() : undefined;

			// 1. Flush: force-observe and reflect all pending content
			ctx.ui.notify("pi-om: flushing observations and reflections...", "info");
			await flushConsolidation(pi, runtime, {
				cwd: ctx.cwd,
				hasUI: ctx.hasUI,
				ui: ctx.ui,
				model: ctx.model,
				modelRegistry: ctx.modelRegistry,
				sessionManager: ctx.sessionManager,
			});

			// 2. Render the flushed summary (no LLM call)
			const entries = ctx.sessionManager.getBranch() as Entry[];
			const projection = fullProjection(entries);
			const summary = renderHandoverSummary(projection.reflections, projection.observations);

			if (!summary.trim()) {
				ctx.ui.notify("pi-om: no observations or reflections to hand over. Continue working or call /om:handover later.", "warning");
				return;
			}

			// 3. Write handoff document to /tmp for reference
			const tmpFile = join(os.tmpdir(), `handover-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}.md`);
			try {
				mkdirSync(dirname(tmpFile), { recursive: true });
				writeFileSync(tmpFile, summary, "utf-8");
			} catch (error) {
				ctx.ui.notify(`pi-om: failed to write handoff document — ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}

			// 4. Start new session with handoff document injected as a custom message
			const handoffContent = summary;

			await ctx.newSession({
				parentSession: ctx.sessionManager.getSessionFile(),
				setup: async (sm) => {
					// Inject the handoff document as a custom message in the session
					sm.appendMessage({
						role: "user",
						content: [{
							type: "text",
							text: handoffContent,
						}],
						timestamp: Date.now(),
						customType: HANDOFF_CUSTOM_TYPE,
					} as any);
				},
				withSession: async (newCtx) => {
					// Persist the original handoff content as a custom entry so it
					// survives compaction and can be re-injected if pruned.
					persistHandoffContent(pi, handoffContent);

					if (followUpPrompt) {
						await newCtx.sendUserMessage(followUpPrompt);
					}
				},
			});
		},
	});
}
