/**
 * /scopy - Select & Copy
 *
 * Opens a paged picker of user/assistant messages on the active branch.
 * Use ←/→ or Alt+←/Alt+→ to navigate pages, Enter to select, Esc to cancel.
 * Select a message to copy its text content to the clipboard.
 *
 * Usage: /scopy
 */

import type { ExtensionAPI, ExtensionUIContext, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { copyToClipboard, getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { Container, matchesKey, SelectList, type SelectItem, Text } from "@earendil-works/pi-tui";

const PREVIEW_LENGTH = 80;
const PAGE_SIZE = 20;

function extractText(entry: SessionMessageEntry): string | undefined {
	const message = entry.message;
	let text = "";
	for (const content of message.content) {
		if (content.type === "text") {
			text += content.text;
		}
	}
	return text.trim() || undefined;
}

function makePreview(entry: SessionMessageEntry): string {
	const role = entry.message.role === "user" ? "👤" : "🤖";
	const text = extractText(entry);
	if (!text) return `${role} (empty)`;
	const oneline = text.replace(/\n/g, " ");
	if (oneline.length <= PREVIEW_LENGTH) return `${role} ${oneline}`;
	return `${role} ${oneline.slice(0, PREVIEW_LENGTH - 1)}…`;
}

async function showMessagePicker(
	messageEntries: SessionMessageEntry[],
	previews: string[],
	ui: ExtensionUIContext,
): Promise<SessionMessageEntry | undefined> {
	const totalPages = Math.ceil(previews.length / PAGE_SIZE);
	let currentPage = 0;

	return ui.custom<SessionMessageEntry | undefined>((_tui, theme, _kb, done) => {
		const selectTheme = getSelectListTheme();

		function getPageItems(): SelectItem[] {
			const start = currentPage * PAGE_SIZE;
			const end = Math.min(start + PAGE_SIZE, previews.length);
			return previews.slice(start, end).map((preview, i) => ({
				value: String(start + i),
				label: preview,
			}));
		}

		const container = new Container();

		const titleText = new Text(
			theme.fg("accent", theme.bold(`scopy — page ${currentPage + 1}/${totalPages}`)),
			1, 0,
		);
		container.addChild(titleText);

		const selectList = new SelectList(getPageItems(), Math.min(PAGE_SIZE, 15), selectTheme);
		selectList.onSelect = (item: SelectItem) => {
			const idx = Number(item.value);
			done(messageEntries[idx]);
		};
		selectList.onCancel = () => {
			done(undefined);
		};
		container.addChild(selectList);

		const hintText = new Text(
			theme.fg("dim", "←/→ page  Enter select  Esc cancel"),
			1, 0,
		);
		container.addChild(hintText);

		function refreshPage() {
			const start = currentPage * PAGE_SIZE;
			const end = Math.min(start + PAGE_SIZE, previews.length);
			const items: SelectItem[] = previews.slice(start, end).map((preview, i) => ({
				value: String(start + i),
				label: preview,
			}));
			selectList.setFilter("");
			// @ts-expect-error — private fields, needed to swap items for paging
			selectList.items = items;
			// @ts-expect-error — filteredItems mirrors items when unfiltered
			selectList.filteredItems = items;
			selectList.setSelectedIndex(0);
			titleText.setText(
				theme.fg("accent", theme.bold(`scopy — page ${currentPage + 1}/${totalPages}`)),
			);
			container.invalidate();
		}

		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				// Page navigation: left/right or alt+left/alt+right
				if (
					matchesKey(data, "left") ||
					matchesKey(data, "alt+left") ||
					matchesKey(data, "ctrl+left")
				) {
					if (currentPage > 0) {
						currentPage--;
						refreshPage();
					}
					return;
				}
				if (
					matchesKey(data, "right") ||
					matchesKey(data, "alt+right") ||
					matchesKey(data, "ctrl+right")
				) {
					if (currentPage < totalPages - 1) {
						currentPage++;
						refreshPage();
					}
					return;
				}
				// Delegate everything else (up/down/enter/escape) to SelectList
				selectList.handleInput(data);
			},
		};
	});
}

export default function scopyExtension(pi: ExtensionAPI) {
	pi.registerCommand("scopy", {
		description: "Select a message and copy its text to clipboard",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/scopy requires TUI mode", "error");
				return;
			}

			const entries = ctx.sessionManager.getBranch();

			const messageEntries: SessionMessageEntry[] = [];
			const previews: string[] = [];

			for (const entry of entries) {
				if (entry.type !== "message") continue;
				const msgEntry = entry as SessionMessageEntry;
				if (msgEntry.message.role !== "user" && msgEntry.message.role !== "assistant") continue;
				const text = extractText(msgEntry);
				if (!text) continue;
				messageEntries.push(msgEntry);
				previews.push(makePreview(msgEntry));
			}

			// Reverse so most recent messages appear at top (default cursor position)
			messageEntries.reverse();
			previews.reverse();

			if (messageEntries.length === 0) {
				ctx.ui.notify("No messages to copy", "warning");
				return;
			}

			const selected = await showMessagePicker(messageEntries, previews, ctx.ui);
			if (!selected) return;

			const text = extractText(selected);
			if (!text) return;

			try {
				await copyToClipboard(text);
				ctx.ui.notify("Copied to clipboard", "info");
			} catch (error) {
				ctx.ui.notify(
					`Copy failed: ${error instanceof Error ? error.message : String(error)}`,
					"error"
				);
			}
		},
	});
}
