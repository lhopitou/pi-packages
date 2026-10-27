/**
 * Get System Prompt Extension
 *
 * Adds a /system-prompt command so you can inspect Pi's current system prompt.
 *
 * - /system-prompt          Shows the system prompt as last sent to the model
 * - /system-prompt options  Shows the structured prompt options (tools, context files, skills, etc.)
 * - /system-prompt summary  Shows a brief summary (length, active tools, context files)
 *
 * "Full" and "summary" fold the transcript's system messages (leading content,
 * then section updates), so they show what the model last received — including
 * per-request loadout changes such as prepareLoadout hiddenDeclarations, which
 * ctx.getSystemPrompt()'s resting view leaves out. Before the first request of
 * a session they fall back to the resting prompt.
 *
 * Place in ~/.pi/agent/extensions/ for global access, or .pi/extensions/ for project-local.
 */

import { getCurrentSystemMessage, getSystemMessageText } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

/**
 * The system prompt the model last actually received: the transcript's system
 * messages folded together (leading content, then section updates by name,
 * `null` removing a section). Falls back to the resting prompt before this
 * session's first request.
 */
function currentPrompt(
	ctx: ExtensionCommandContext,
): { text: string; source: string } {
	const messages = ctx.sessionManager.buildSessionProjection().messages;
	const system = getCurrentSystemMessage(messages);
	if (system) {
		return {
			text: getSystemMessageText(system),
			source: "transcript: system prompt as last sent to the model",
		};
	}
	return {
		text: ctx.getSystemPrompt(),
		source: "resting prompt: no request sent in this session yet",
	};
}

export default function getSystemPromptExtension(pi: ExtensionAPI) {
	// --- Command: /system-prompt ---
	pi.registerCommand("system-prompt", {
		description: "Show the current system prompt",
		getArgumentCompletions: (prefix) => {
			const modes = ["full", "options", "summary"];
			const filtered = modes.filter((m) => m.startsWith(prefix));
			return filtered.length > 0
				? filtered.map((m) => ({ value: m, label: m }))
				: null;
		},
		handler: async (args, ctx) => {
			const mode = (args.trim() || "full") as "full" | "options" | "summary";

			if (mode === "full") {
				const { text, source } = currentPrompt(ctx);
				// Use a select dialog so the user can scroll through the full text
				const lines = [source, "", ...text.split("\n")];
				const selected = await ctx.ui.select("System Prompt (scroll to view)", lines);
				if (selected) {
					// Copy-friendly: notify with the line number
					const idx = lines.indexOf(selected);
					ctx.ui.notify(`Line ${idx + 1}: ${selected}`, "info");
				}
			} else if (mode === "options") {
				const options = ctx.getSystemPromptOptions();
				const info = [
					`Custom Prompt: ${options.customPrompt ?? "(none)"}`,
					`CWD: ${options.cwd}`,
					`Active Tools: ${options.selectedTools?.join(", ") ?? "(none)"}`,
					`Context Files: ${options.contextFiles?.map((f) => f.path).join(", ") ?? "(none)"}`,
					`Skills: ${options.skills?.map((s) => s.name).join(", ") ?? "(none)"}`,
					`Prompt Guidelines: ${options.promptGuidelines?.join("; ") ?? "(none)"}`,
					`Append System Prompt: ${options.appendSystemPrompt ?? "(none)"}`,
					`Hidden Tools (resting): ${options.hiddenTools?.join(", ") || "(none)"}`,
					"Note: resting options — per-request loadout changes (e.g. prepareLoadout hiddenDeclarations) are applied per run; see the default mode for what the model received.",
				];
				await ctx.ui.select("System Prompt Options", info);
			} else if (mode === "summary") {
				const { text, source } = currentPrompt(ctx);
				const options = ctx.getSystemPromptOptions();
				const toolCount = options.selectedTools?.length ?? 0;
				const fileCount = options.contextFiles?.length ?? 0;
				const skillCount = options.skills?.length ?? 0;
				ctx.ui.notify(
					`${source} | ${text.length} chars | ${toolCount} tools | ${fileCount} context files | ${skillCount} skills`,
					"info",
				);
			}
		},
	});

}
