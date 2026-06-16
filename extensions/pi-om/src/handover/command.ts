/**
 * /handover command: produces a handover document and starts a fresh session.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import * as os from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Runtime } from "../runtime.ts";
import { produceHandover } from "./producer.ts";
import { foldLedger, fullProjection, renderSummary, type Entry } from "../ledger/index.ts";
import { persistHandoffContent } from "./injection.ts";

export const HANDOFF_CUSTOM_TYPE = "om.handoff";

export function registerHandoverCommand(pi: ExtensionAPI, runtime: Runtime): void {
	pi.registerCommand("handover", {
		description: "Produce a handover document and start a fresh session (optional: follow-up prompt)",
		handler: async (args, ctx) => {
			await runtime.ensureConfig(ctx.cwd);

			const followUpPrompt = typeof args === "string" ? args.trim() : undefined;

			// 1. Read ledger, fold, render summary
			const entries = ctx.sessionManager.getBranch() as Entry[];
			const projection = fullProjection(entries);
			const summary = renderSummary(projection.reflections, projection.observations);

			if (!summary.trim()) {
				ctx.ui.notify("pi-om: no observations or reflections to hand over. Continue working or call /handover later.", "warning");
				return;
			}

			// 2. Spawn handover producer
			ctx.ui.notify("pi-om: producing handover document...", "info");
			const result = await produceHandover(summary, ctx.cwd, ctx.signal);

			if (!result.success) {
				ctx.ui.notify(`pi-om: handover producer failed — ${result.error}`, "error");
				return;
			}

			// 3. Write handoff document to /tmp for reference
			const tmpFile = join(os.tmpdir(), `handover-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}.md`);
			try {
				mkdirSync(dirname(tmpFile), { recursive: true });
				writeFileSync(tmpFile, result.document, "utf-8");
			} catch (error) {
				ctx.ui.notify(`pi-om: failed to write handoff document — ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}

			// 4. Extract phase label from the document
			const phaseMatch = result.document.match(/^# Handover:\s*(.+)$/m);
			const phase = phaseMatch ? phaseMatch[1].trim() : "unknown";

			// 5. Start new session with handoff document injected as a custom message
			const handoffContent = result.document;

			await ctx.newSession({
				parentSession: ctx.sessionManager.getSessionFile(),
				setup: async (sm) => {
					// Store handoff metadata as a custom entry via the pi API
					// and inject the handoff document as a custom message in the session
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
