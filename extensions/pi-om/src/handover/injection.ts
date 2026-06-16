/**
 * Handover injection: re-injects handoff document content after compaction.
 *
 * The handoff document is injected as a custom message during session setup
 * and also persisted as a custom entry (via appendEntry) so it survives
 * compaction. The session_compact hook checks if the message was pruned
 * and re-injects from the persisted entry.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { HANDOFF_CUSTOM_TYPE } from "./command.ts";

/** Custom entry type for persisting handoff content through compaction. */
const HANDOFF_PERSIST_ENTRY_TYPE = "om.handoff.persist";

/**
 * Store handoff document content as a custom entry so it survives compaction.
 * Called by the handover command after producing the handoff document.
 */
export function persistHandoffContent(pi: ExtensionAPI, content: string): void {
	pi.appendEntry(HANDOFF_PERSIST_ENTRY_TYPE, { content });
}

/**
 * Retrieve persisted handoff content from session entries.
 */
function findPersistedHandoffContent(entries: Array<{ type: string; customType?: string; data?: unknown }>): string | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "custom" && entry.customType === HANDOFF_PERSIST_ENTRY_TYPE) {
			const data = entry.data as Record<string, unknown> | undefined;
			if (data && typeof data.content === "string" && data.content) return data.content;
		}
	}
	return undefined;
}

/**
 * Register the session_compact hook that re-injects handoff document content
 * after compaction (which may prune the injected message).
 */
export function registerHandoverInjection(pi: ExtensionAPI): void {
	pi.on("session_compact", async (event, ctx) => {
		// Check if this session has a handoff message that might have been pruned
		const entries = ctx.sessionManager.getBranch();
		let hasHandoff = false;
		for (const entry of entries) {
			if (entry.type === "message") {
				const msg = (entry as any).message;
				if (msg?.customType === HANDOFF_CUSTOM_TYPE) {
					hasHandoff = true;
					break;
				}
			}
			if (entry.type === "custom_message" && (entry as any).customType === HANDOFF_CUSTOM_TYPE) {
				hasHandoff = true;
				break;
			}
		}

		// If there was a handoff but it was pruned by compaction, re-inject the
		// original document from the persisted entry (not from the compaction
		// summary, which may contain unrelated memory content).
		if (!hasHandoff) {
			const persistedContent = findPersistedHandoffContent(entries);
			if (persistedContent) {
				pi.sendMessage({
					customType: HANDOFF_CUSTOM_TYPE,
					content: persistedContent,
					display: true,
				}, { triggerTurn: false });
			}
		}
	});
}
