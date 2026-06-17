import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	isObservation,
	isReflection,
	isObservationsRecordedData,
	isReflectionsRecordedData,
	isObservationsDroppedData,
	isReflectionsSupersededData,
	isMemoryDetails,
	isMemoryId,
	isObservationsRecordedEntry,
	isReflectionsRecordedEntry,
	isObservationsDroppedEntry,
	isReflectionsSupersededEntry,
	isRelevance,
	isNonEmptyString,
	isNonEmptyStringArray,
	buildObservationsRecordedData,
	buildReflectionsRecordedData,
	buildObservationsDroppedData,
	buildReflectionsSupersededData,
	OM_OBSERVATIONS_RECORDED,
	OM_REFLECTIONS_RECORDED,
	OM_OBSERVATIONS_DROPPED,
	OM_FOLDED,
	type Observation,
	type Reflection,
	type Entry,
} from "./types.ts";

function makeObservation(overrides: Partial<Observation> = {}): Observation {
	return {
		id: "a1b2c3d4e5f6a1b2",
		content: "Test observation content",
		timestamp: "2025-01-01 12:00",
		relevance: "medium",
		sourceEntryIds: ["src1"],
		tokenCount: 10,
		...overrides,
	};
}

function makeReflection(overrides: Partial<Reflection> = {}): Reflection {
	return {
		id: "f6e5d4c3b2a1f6e5",
		content: "Test reflection content",
		supportingObservationIds: ["a1b2c3d4e5f6a1b2"],
		tokenCount: 8,
		...overrides,
	};
}

// ── isRelevance ──

describe("isRelevance", () => {
	it("accepts valid relevance levels", () => {
		assert.equal(isRelevance("low"), true);
		assert.equal(isRelevance("medium"), true);
		assert.equal(isRelevance("high"), true);
		assert.equal(isRelevance("critical"), true);
	});

	it("rejects invalid values", () => {
		assert.equal(isRelevance("unknown"), false);
		assert.equal(isRelevance(""), false);
		assert.equal(isRelevance(42), false);
		assert.equal(isRelevance(null), false);
		assert.equal(isRelevance(undefined), false);
	});
});

// ── isNonEmptyString ──

describe("isNonEmptyString", () => {
	it("accepts non-empty strings", () => {
		assert.equal(isNonEmptyString("hello"), true);
	});

	it("rejects empty strings", () => {
		assert.equal(isNonEmptyString(""), false);
	});

	it("rejects non-strings", () => {
		assert.equal(isNonEmptyString(42), false);
		assert.equal(isNonEmptyString(null), false);
		assert.equal(isNonEmptyString(undefined), false);
	});
});

// ── isNonEmptyStringArray ──

describe("isNonEmptyStringArray", () => {
	it("accepts array of non-empty strings", () => {
		assert.equal(isNonEmptyStringArray(["a", "b"]), true);
	});

	it("rejects empty array", () => {
		assert.equal(isNonEmptyStringArray([]), false);
	});

	it("rejects array with empty strings", () => {
		assert.equal(isNonEmptyStringArray(["a", ""]), false);
	});

	it("rejects non-array", () => {
		assert.equal(isNonEmptyStringArray("abc"), false);
	});
});

// ── isMemoryId ──

describe("isMemoryId", () => {
	it("accepts valid 16-char hex ids", () => {
		assert.equal(isMemoryId("a1b2c3d4e5f6a1b2"), true);
		assert.equal(isMemoryId("0000000000000000"), true);
		assert.equal(isMemoryId("ffffffffffffffff"), true);
	});

	it("rejects wrong length", () => {
		assert.equal(isMemoryId("a1b2c3d4e5f6a1b"), false); // 15 chars
		assert.equal(isMemoryId("a1b2c3d4e5f6a1b23"), false); // 17 chars
	});

	it("rejects uppercase hex", () => {
		assert.equal(isMemoryId("A1B2C3D4E5F6A1B2"), false);
	});

	it("rejects non-hex characters", () => {
		assert.equal(isMemoryId("g1b2c3d4e5f6a1b2"), false);
	});

	it("rejects non-strings", () => {
		assert.equal(isMemoryId(123), false);
		assert.equal(isMemoryId(null), false);
	});
});

// ── isObservation ──

describe("isObservation", () => {
	it("accepts valid observation", () => {
		assert.equal(isObservation(makeObservation()), true);
	});

	it("rejects observation with uppercase id", () => {
		assert.equal(isObservation(makeObservation({ id: "A1B2C3D4E5F6" })), false);
	});

	it("rejects observation with empty content", () => {
		assert.equal(isObservation(makeObservation({ content: "" })), false);
	});

	it("rejects observation with empty sourceEntryIds", () => {
		assert.equal(isObservation(makeObservation({ sourceEntryIds: [] })), false);
	});

	it("rejects observation with invalid relevance", () => {
		assert.equal(isObservation(makeObservation({ relevance: "urgent" as any })), false);
	});

	it("rejects observation with negative tokenCount", () => {
		assert.equal(isObservation(makeObservation({ tokenCount: -1 })), false);
	});

	it("rejects observation with NaN tokenCount", () => {
		assert.equal(isObservation(makeObservation({ tokenCount: NaN })), false);
	});

	it("rejects non-objects", () => {
		assert.equal(isObservation(null), false);
		assert.equal(isObservation(undefined), false);
		assert.equal(isObservation("string"), false);
		assert.equal(isObservation(42), false);
	});
});

// ── isReflection ──

describe("isReflection", () => {
	it("accepts valid reflection", () => {
		assert.equal(isReflection(makeReflection()), true);
	});

	it("rejects reflection with empty supportingObservationIds", () => {
		assert.equal(isReflection(makeReflection({ supportingObservationIds: [] })), false);
	});

	it("rejects reflection with newlines in content", () => {
		assert.equal(isReflection(makeReflection({ content: "line1\nline2" })), false);
	});

	it("rejects reflection with carriage return in content", () => {
		assert.equal(isReflection(makeReflection({ content: "line1\rline2" })), false);
	});

	it("rejects non-objects", () => {
		assert.equal(isReflection(null), false);
		assert.equal(isReflection(undefined), false);
	});
});

// ── isObservationsRecordedData ──

describe("isObservationsRecordedData", () => {
	it("accepts valid data", () => {
		const obs = makeObservation();
		assert.equal(isObservationsRecordedData({ observations: [obs], coversUpToId: "entry1" }), true);
	});

	it("rejects empty observations array", () => {
		assert.equal(isObservationsRecordedData({ observations: [], coversUpToId: "entry1" }), false);
	});

	it("rejects invalid observation in array", () => {
		assert.equal(isObservationsRecordedData({ observations: [{ bad: true }], coversUpToId: "entry1" }), false);
	});

	it("rejects missing coversUpToId", () => {
		assert.equal(isObservationsRecordedData({ observations: [makeObservation()] }), false);
	});

	it("rejects empty coversUpToId", () => {
		assert.equal(isObservationsRecordedData({ observations: [makeObservation()], coversUpToId: "" }), false);
	});
});

// ── isReflectionsRecordedData ──

describe("isReflectionsRecordedData", () => {
	it("accepts valid data", () => {
		const ref = makeReflection();
		assert.equal(isReflectionsRecordedData({ reflections: [ref], coversUpToId: "entry1" }), true);
	});

	it("rejects empty reflections array", () => {
		assert.equal(isReflectionsRecordedData({ reflections: [], coversUpToId: "entry1" }), false);
	});
});

// ── isObservationsDroppedData ──

describe("isObservationsDroppedData", () => {
	it("accepts valid data", () => {
		assert.equal(isObservationsDroppedData({ observationIds: ["a1b2c3d4e5f6a1b2"], coversUpToId: "entry1" }), true);
	});

	it("rejects empty observationIds", () => {
		assert.equal(isObservationsDroppedData({ observationIds: [], coversUpToId: "entry1" }), false);
	});

	it("rejects observationIds with empty strings", () => {
		assert.equal(isObservationsDroppedData({ observationIds: [""], coversUpToId: "entry1" }), false);
	});
});

// ── isMemoryDetails ──

describe("isMemoryDetails", () => {
	it("accepts valid memory details", () => {
		assert.equal(isMemoryDetails({
			type: OM_FOLDED,
			version: 1,
			fullFold: false,
			observations: [makeObservation()],
			reflections: [makeReflection()],
		}), true);
	});

	it("rejects wrong type", () => {
		assert.equal(isMemoryDetails({
			type: "wrong",
			version: 1,
			fullFold: false,
			observations: [],
			reflections: [],
		}), false);
	});

	it("rejects wrong version", () => {
		assert.equal(isMemoryDetails({
			type: OM_FOLDED,
			version: 2,
			fullFold: false,
			observations: [],
			reflections: [],
		}), false);
	});

	it("rejects invalid observations", () => {
		assert.equal(isMemoryDetails({
			type: OM_FOLDED,
			version: 1,
			fullFold: false,
			observations: [{ bad: true }],
			reflections: [],
		}), false);
	});
});

// ── Entry type guards ──

describe("isObservationsRecordedEntry", () => {
	it("accepts valid entry", () => {
		const entry: Entry = {
			type: "custom",
			id: "e1",
			customType: OM_OBSERVATIONS_RECORDED,
			data: { observations: [makeObservation()], coversUpToId: "src1" },
		};
		assert.equal(isObservationsRecordedEntry(entry), true);
	});

	it("rejects wrong type", () => {
		const entry: Entry = { type: "message", id: "e1", data: { observations: [makeObservation()], coversUpToId: "src1" } };
		assert.equal(isObservationsRecordedEntry(entry), false);
	});

	it("rejects wrong customType", () => {
		const entry: Entry = { type: "custom", id: "e1", customType: "wrong", data: { observations: [makeObservation()], coversUpToId: "src1" } };
		assert.equal(isObservationsRecordedEntry(entry), false);
	});

	it("rejects invalid data", () => {
		const entry: Entry = { type: "custom", id: "e1", customType: OM_OBSERVATIONS_RECORDED, data: {} };
		assert.equal(isObservationsRecordedEntry(entry), false);
	});
});

describe("isReflectionsRecordedEntry", () => {
	it("accepts valid entry", () => {
		const entry: Entry = {
			type: "custom",
			id: "e1",
			customType: OM_REFLECTIONS_RECORDED,
			data: { reflections: [makeReflection()], coversUpToId: "src1" },
		};
		assert.equal(isReflectionsRecordedEntry(entry), true);
	});
});

	describe("isObservationsDroppedEntry", () => {
	it("accepts valid entry", () => {
		const entry: Entry = {
			type: "custom",
			id: "e1",
			customType: OM_OBSERVATIONS_DROPPED,
			data: { observationIds: ["a1b2c3d4e5f6a1b2"], coversUpToId: "src1" },
		};
		assert.equal(isObservationsDroppedEntry(entry), true);
	});
});

describe("isReflectionsSupersededEntry", () => {
	it("accepts valid entry", () => {
		const entry: Entry = {
			type: "custom",
			id: "e1",
			customType: "om.reflections.superseded",
			data: { reflectionIds: ["fee1111111111111"], coversUpToId: "src1" },
		};
		assert.equal(isReflectionsSupersededEntry(entry), true);
	});

	it("rejects wrong customType", () => {
		const entry: Entry = { type: "custom", id: "e1", customType: "wrong", data: { reflectionIds: ["fee1111111111111"], coversUpToId: "src1" } };
		assert.equal(isReflectionsSupersededEntry(entry), false);
	});

	it("rejects invalid data", () => {
		const entry: Entry = { type: "custom", id: "e1", customType: "om.reflections.superseded", data: {} };
		assert.equal(isReflectionsSupersededEntry(entry), false);
	});
});

// ── Builders ──

describe("buildObservationsRecordedData", () => {
	it("builds valid data", () => {
		const obs = makeObservation();
		const data = buildObservationsRecordedData([obs], "entry1");
		assert.deepEqual(data, { observations: [obs], coversUpToId: "entry1" });
	});

	it("returns undefined for empty observations", () => {
		assert.equal(buildObservationsRecordedData([], "entry1"), undefined);
	});

	it("returns undefined for empty coversUpToId", () => {
		assert.equal(buildObservationsRecordedData([makeObservation()], ""), undefined);
	});
});

describe("buildReflectionsRecordedData", () => {
	it("builds valid data", () => {
		const ref = makeReflection();
		const data = buildReflectionsRecordedData([ref], "entry1");
		assert.deepEqual(data, { reflections: [ref], coversUpToId: "entry1" });
	});

	it("returns undefined for empty reflections", () => {
		assert.equal(buildReflectionsRecordedData([], "entry1"), undefined);
	});
});

describe("buildObservationsDroppedData", () => {
	it("builds valid data", () => {
		const data = buildObservationsDroppedData(["a1b2c3d4e5f6a1b2"], "entry1");
		assert.deepEqual(data, { observationIds: ["a1b2c3d4e5f6a1b2"], coversUpToId: "entry1" });
	});

	it("returns undefined for empty ids", () => {
		assert.equal(buildObservationsDroppedData([], "entry1"), undefined);
	});
});

describe("buildReflectionsSupersededData", () => {
	it("builds valid data", () => {
		const data = buildReflectionsSupersededData(["fee1111111111111"], "entry1");
		assert.deepEqual(data, { reflectionIds: ["fee1111111111111"], coversUpToId: "entry1" });
	});

	it("returns undefined for empty ids", () => {
		assert.equal(buildReflectionsSupersededData([], "entry1"), undefined);
	});

	it("returns undefined for empty coversUpToId", () => {
		assert.equal(buildReflectionsSupersededData(["fee1111111111111"], ""), undefined);
	});
});

describe("isReflectionsSupersededData", () => {
	it("accepts valid data", () => {
		assert.equal(isReflectionsSupersededData({ reflectionIds: ["fee1111111111111"], coversUpToId: "src1" }), true);
	});

	it("rejects empty reflectionIds", () => {
		assert.equal(isReflectionsSupersededData({ reflectionIds: [], coversUpToId: "src1" }), false);
	});

	it("rejects reflectionIds with empty strings", () => {
		assert.equal(isReflectionsSupersededData({ reflectionIds: [""], coversUpToId: "src1" }), false);
	});
});
