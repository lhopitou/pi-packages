import { createHash } from "node:crypto";
import { debugLog } from "./debug-log.ts";

/**
 * Generate a deterministic content-hash ID (16 hex chars = 64 bits).
 *
 * Collisions at 64 bits are extremely unlikely in a single session
 * (~10⁻¹⁵ probability for ~1000 items by birthday paradox).
 * Intentionally identical content produces the same ID as a dedup key.
 * Accidental collisions of different content are logged via debugLog.
 */
export function hashId(content: string): string {
	return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/**
 * Insert into an accumulated map with collision detection.
 * If the key already exists and the existing content differs from the
 * new content, log a warning (accidental hash collision).
 * Returns true if the item was inserted (new or intentional dedup).
 */
export function accumulateWithCollisionCheck<T extends { id: string; content: string }>(
	map: Map<string, T>,
	item: T,
	label: string,
): boolean {
	const existing = map.get(item.id);
	if (existing) {
		if (existing.content !== item.content) {
			debugLog(`${label}.hash_collision`, {
				id: item.id,
				existingContent: existing.content.slice(0, 200),
				newContent: item.content.slice(0, 200),
			});
		}
		return false; // Dedup: same ID, skip
	}
	map.set(item.id, item);
	return true;
}
