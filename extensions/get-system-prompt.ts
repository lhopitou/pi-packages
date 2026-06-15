/**
 * Get System Prompt Extension
 *
 * Adds a /system-prompt command so you can inspect Pi's current system prompt.
 *
 * - /system-prompt          Shows the full system prompt text
 * - /system-prompt options  Shows the structured prompt options (tools, context files, skills, etc.)
 * - /system-prompt summary  Shows a brief summary (length, active tools, context files)
 *
 * Place in ~/.pi/agent/extensions/ for global access, or .pi/extensions/ for project-local.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
				const prompt = ctx.getSystemPrompt();
				// Use a select dialog so the user can scroll through the full text
				const lines = prompt.split("\n");
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
				];
				await ctx.ui.select("System Prompt Options", info);
			} else if (mode === "summary") {
				const prompt = ctx.getSystemPrompt();
				const options = ctx.getSystemPromptOptions();
				const toolCount = options.selectedTools?.length ?? 0;
				const fileCount = options.contextFiles?.length ?? 0;
				const skillCount = options.skills?.length ?? 0;
				ctx.ui.notify(
					`System prompt: ${prompt.length} chars | ${toolCount} tools | ${fileCount} context files | ${skillCount} skills`,
					"info",
				);
			}
		},
	});

}
