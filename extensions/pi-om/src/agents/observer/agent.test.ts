import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeSourceEntryIds } from "./agent.ts";

describe("normalizeSourceEntryIds", () => {
	it("returns undefined for undefined input", () => {
		assert.equal(normalizeSourceEntryIds(undefined, ["a", "b"]), undefined);
	});

	it("returns undefined for empty array", () => {
		assert.equal(normalizeSourceEntryIds([], ["a", "b"]), undefined);
	});

	it("returns sorted ids when all are valid", () => {
		const result = normalizeSourceEntryIds(["b", "a"], ["a", "b", "c"]);
		assert.deepEqual(result, ["a", "b"]); // sorted by position in allowed list
	});

	it("filters out ids not in allowed list and keeps valid ones", () => {
		const result = normalizeSourceEntryIds(["a", "invalid"], ["a", "b"]);
		assert.deepEqual(result, ["a"]); // invalid filtered out, valid kept
	});

	it("returns undefined when all ids are invalid", () => {
		const result = normalizeSourceEntryIds(["invalid1", "invalid2"], ["a", "b"]);
		assert.equal(result, undefined);
	});

	it("deduplicates ids", () => {
		const result = normalizeSourceEntryIds(["a", "a"], ["a", "b"]);
		assert.deepEqual(result, ["a"]);
	});

	it("preserves order according to allowed list positions", () => {
		const result = normalizeSourceEntryIds(["c", "a"], ["a", "b", "c"]);
		assert.deepEqual(result, ["a", "c"]);
	});
});
