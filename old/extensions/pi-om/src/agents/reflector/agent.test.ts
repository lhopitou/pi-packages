import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeSupportingObservationIds } from "./agent.ts";

describe("normalizeSupportingObservationIds", () => {
	it("returns undefined for undefined input", () => {
		assert.equal(normalizeSupportingObservationIds(undefined, ["a", "b"]), undefined);
	});

	it("returns undefined for empty array", () => {
		assert.equal(normalizeSupportingObservationIds([], ["a", "b"]), undefined);
	});

	it("returns sorted ids when all are valid", () => {
		const result = normalizeSupportingObservationIds(["b", "a"], ["a", "b", "c"]);
		assert.deepEqual(result, ["a", "b"]); // sorted by allowed position
	});

	it("filters out ids not in allowed list and keeps valid ones", () => {
		const result = normalizeSupportingObservationIds(["a", "invalid"], ["a", "b"]);
		assert.deepEqual(result, ["a"]); // invalid filtered out, valid kept
	});

	it("returns undefined when all ids are invalid", () => {
		const result = normalizeSupportingObservationIds(["invalid1", "invalid2"], ["a", "b"]);
		assert.equal(result, undefined);
	});

	it("deduplicates ids", () => {
		const result = normalizeSupportingObservationIds(["a", "a"], ["a", "b"]);
		assert.deepEqual(result, ["a"]);
	});

	it("preserves order according to allowed list positions", () => {
		const result = normalizeSupportingObservationIds(["c", "a"], ["a", "b", "c"]);
		assert.deepEqual(result, ["a", "c"]);
	});
});
