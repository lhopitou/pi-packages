/**
 * Context Tokens Extension
 *
 * Adds a /context-tokens command that shows the estimated token composition
 * of the current context, grouped by pi's own message types: system, user,
 * assistant (split into text / thinking / tool calls, mirroring the
 * AssistantMessage content block kinds), toolResult, bashExecution, custom,
 * branchSummary, compactionSummary. The system prompt's `skills` and
 * `project_context` sections are reported as their own categories.
 *
 * Estimates use pi's exported estimateTokens() (chars/4 heuristic, images
 * ≈1200 tokens) computed over the session projection — the same basis pi's
 * footer and compaction accounting use. No visualization, no config.
 */

import { estimateTokens, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** pi's AgentMessage roles (assistant split by content block kind). */
const ROLE_LABELS: Record<string, string> = {
	system: "System prompt (prompt + tool defs)",
	skills: "Skills (system prompt section)",
	project_context: "Project context (AGENTS.md etc.)",
	user: "User messages",
	"assistant/text": "Assistant text",
	"assistant/thinking": "Assistant thinking",
	"assistant/toolCalls": "Assistant tool calls",
	toolResult: "Tool results",
	bashExecution: "Bash executions (! commands)",
	custom: "Extension-injected messages",
	branchSummary: "Branch summaries",
	compactionSummary: "Compaction summary",
};

const format = (n: number): string => n.toLocaleString("en-US");

interface CategoryEntry {
	key: string;
	count: number;
	tokens: number;
}

const ESTIMATED_IMAGE_CHARS = 4800;

/** Mirror of pi's estimateTextAndImageContentChars. */
function textAndImageChars(content: unknown): number {
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	let chars = 0;
	for (const block of content) {
		const b = block as { type: string; text?: string };
		if (b.type === "text" && b.text) chars += b.text.length;
		else if (b.type === "image") chars += ESTIMATED_IMAGE_CHARS;
	}
	return chars;
}

/** System-prompt sections reported as their own categories. */
const SYSTEM_SECTION_CATEGORIES: Record<string, string> = {
	skills: "skills",
	project_context: "project_context",
};

/**
 * Char counts mirroring pi's estimateTokens for a system message, with the
 * sections named in SYSTEM_SECTION_CATEGORIES (pi renders skills and project
 * context as named system-prompt sections; see system-prompt.js) split out
 * from the rest.
 */
function systemCharSplit(message: Record<string, unknown>): Record<string, number> {
	const chars: Record<string, number> = { system: textAndImageChars(message.content) };
	const sections = message.sections as Record<string, string | null> | undefined;
	if (sections) {
		for (const [name, section] of Object.entries(sections)) {
			if (!section) continue;
			const key = SYSTEM_SECTION_CATEGORIES[name] ?? "system";
			chars[key] = (chars[key] ?? 0) + section.length;
		}
	}
	if (message.toolsAdded) chars.system += JSON.stringify(message.toolsAdded).length;
	return chars;
}

/**
 * Split an integer across shares proportional to their sizes, keeping the
 * sum exact (largest-remainder method).
 */
function splitByShare(total: number, shares: Record<string, number>): Record<string, number> {
	const sum = Object.values(shares).reduce((a, b) => a + b, 0);
	const result: Record<string, number> = {};
	let assigned = 0;
	let largestKind: string | null = null;
	let largestFrac = -1;
	for (const [kind, chars] of Object.entries(shares)) {
		const exact = (total * chars) / sum;
		const floor = Math.floor(exact);
		result[kind] = floor;
		assigned += floor;
		const frac = exact - floor;
		if (chars > 0 && frac > largestFrac) {
			largestFrac = frac;
			largestKind = kind;
		}
	}
	if (largestKind !== null) result[largestKind] += total - assigned;
	return result;
}

/** Character counts per assistant content block kind, mirroring estimateTokens. */
function assistantBlockChars(content: unknown[]): Record<string, number> {
	const chars: Record<string, number> = { text: 0, thinking: 0, toolCalls: 0 };
	for (const block of content) {
		const b = block as { type: string; text?: string; thinking?: string; name?: string; arguments?: unknown };
		if (b.type === "text") chars.text += b.text?.length ?? 0;
		else if (b.type === "thinking") chars.thinking += b.thinking?.length ?? 0;
		else if (b.type === "toolCall")
			chars.toolCalls += (b.name?.length ?? 0) + (b.arguments !== undefined ? JSON.stringify(b.arguments).length : 0);
	}
	return chars;
}

function computeCategories(messages: { role: string }[]): CategoryEntry[] {
	const byKey = new Map<string, CategoryEntry>();
	const ensure = (key: string): CategoryEntry => {
		let entry = byKey.get(key);
		if (!entry) {
			entry = { key, count: 0, tokens: 0 };
			byKey.set(key, entry);
		}
		return entry;
	};
	for (const message of messages) {
		const tokens = estimateTokens(message as never);
		if (message.role === "system") {
			const chars = systemCharSplit(message as unknown as Record<string, unknown>);
			const hasSplit = Object.entries(chars).some(([key, value]) => key !== "system" && value > 0);
			if (!hasSplit) {
				const entry = ensure("system");
				entry.count++;
				entry.tokens += tokens;
				continue;
			}
			// Distribute pi's estimate between the extracted sections and the rest.
			const split = splitByShare(tokens, chars);
			for (const [kind, value] of Object.entries(split)) {
				if (value === 0) continue;
				const entry = ensure(kind);
				entry.count++;
				entry.tokens += value;
			}
			continue;
		}
		if (message.role !== "assistant") {
			const entry = ensure(message.role);
			entry.count++;
			entry.tokens += tokens;
			continue;
		}
		// Distribute pi's per-message estimate across block kinds by char share,
		// so the three rows sum exactly to pi's own assistant total.
		const chars = assistantBlockChars((message as unknown as { content: unknown[] }).content);
		const sum = chars.text + chars.thinking + chars.toolCalls;
		if (sum === 0) continue;
		const split = splitByShare(tokens, chars);
		for (const [kind, value] of Object.entries(split)) {
			if (value === 0) continue;
			const entry = ensure(`assistant/${kind}`);
			entry.count++;
			entry.tokens += value;
		}
	}
	return [...byKey.values()]
		.sort((a, b) => b.tokens - a.tokens || a.key.localeCompare(b.key));
}

function renderLines(
	entries: CategoryEntry[],
	total: number,
	contextWindow: number | undefined,
	modelLabel: string | undefined,
): string[] {
	const lines: string[] = [];
	const width = Math.max(...entries.map((e) => ROLE_LABELS[e.key]?.length ?? 7), 20);

	for (const entry of entries) {
		const label = ROLE_LABELS[entry.key] ?? entry.key;
		const share = total > 0 ? ((entry.tokens / total) * 100).toFixed(1) : "0.0";
		lines.push(
			`${label.padEnd(width)}  ${format(entry.tokens).padStart(9)} tok  ${share.padStart(5)}%  (${entry.count} msg)`,
		);
	}

	lines.push("");
	lines.push(`Estimated total: ${format(total)} tokens`);
	if (contextWindow && contextWindow > 0) {
		const percent = ((total / contextWindow) * 100).toFixed(1);
		const remaining = Math.max(0, contextWindow - total);
		lines.push(`Context window:  ${format(contextWindow)} (${percent}% used, ${format(remaining)} free)`);
	}
	if (modelLabel) {
		lines.push(`Model: ${modelLabel}`);
	}
	return lines;
}

export default function contextTokensExtension(pi: ExtensionAPI) {
	pi.registerCommand("context-tokens", {
		description: "Show estimated context tokens by message type",
		handler: async (_args, ctx) => {
			const messages = ctx.sessionManager.buildSessionProjection().messages as { role: string }[];
			const entries = computeCategories(messages);

			if (entries.length === 0) {
				ctx.ui.notify("No context messages yet.", "info");
				return;
			}

			const total = entries.reduce((sum, entry) => sum + entry.tokens, 0);
			const lines = renderLines(entries, total, ctx.model?.contextWindow, ctx.model?.name);

			if (ctx.hasUI) {
				await ctx.ui.select("Context tokens (estimated)", lines);
			} else {
				ctx.ui.notify(lines.join("\n"), "info");
			}
		},
	});
}
