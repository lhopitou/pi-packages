/**
 * Shared type guards and utility helpers.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasOwn(record: Record<string, unknown>, key: string): boolean {
	return Object.hasOwn(record, key);
}

/**
 * Return the visible lines of a text (excluding the terminal-newline sentinel).
 */
export function getVisibleLines(text: string): string[] {
	if (text.length === 0) return [];
	const lines = text.split("\n");
	return text.endsWith("\n") ? lines.slice(0, -1) : lines;
}

/**
 * Count the visible lines of a text (excluding the terminal-newline sentinel).
 */
export function countVisibleLines(text: string): number {
	return getVisibleLines(text).length;
}
