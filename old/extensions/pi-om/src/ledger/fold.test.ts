import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { foldLedger, type FoldedLedger } from "./fold.ts";
import {
	OM_OBSERVATIONS_RECORDED,
	OM_REFLECTIONS_RECORDED,
	OM_OBSERVATIONS_DROPPED,
	OM_REFLECTIONS_SUPERSEDED,
	type Entry,
	type Observation,
	type Reflection,
} from "./types.ts";

function makeObservation(overrides: Partial<Observation> = {}): Observation {
	return {
		id: overrides.id ?? "a1b2c3d4e5f6a1b2",
		content: overrides.content ?? "Test observation",
		timestamp: overrides.timestamp ?? "2025-01-01 12:00",
		relevance: overrides.relevance ?? "medium",
		sourceEntryIds: overrides.sourceEntryIds ?? ["src1"],
		tokenCount: overrides.tokenCount ?? 10,
	};
}

function makeReflection(overrides: Partial<Reflection> = {}): Reflection {
	return {
		id: overrides.id ?? "f6e5d4c3b2a1f6e5",
		content: overrides.content ?? "Test reflection",
		supportingObservationIds: overrides.supportingObservationIds ?? ["a1b2c3d4e5f6a1b2"],
		tokenCount: overrides.tokenCount ?? 8,
	};
}

function makeEntry(type: string, overrides: Partial<Entry> = {}): Entry {
	return { type, id: overrides.id ?? `e-${Math.random().toString(36).slice(2, 8)}`, ...overrides };
}

function makeObservationsRecordedEntry(observations: Observation[], coversUpToId: string, overrides: Partial<Entry> = {}): Entry {
	return makeEntry("custom", {
		customType: OM_OBSERVATIONS_RECORDED,
		data: { observations, coversUpToId },
		...overrides,
	});
}

function makeReflectionsRecordedEntry(reflections: Reflection[], coversUpToId: string, overrides: Partial<Entry> = {}): Entry {
	return makeEntry("custom", {
		customType: OM_REFLECTIONS_RECORDED,
		data: { reflections, coversUpToId },
		...overrides,
	});
}

function makeObservationsDroppedEntry(observationIds: string[], coversUpToId: string, overrides: Partial<Entry> = {}): Entry {
	return makeEntry("custom", {
		customType: OM_OBSERVATIONS_DROPPED,
		data: { observationIds, coversUpToId },
		...overrides,
	});
}

// ── Empty ledger ──

describe("foldLedger — empty", () => {
	it("returns empty result for empty entries", () => {
		const result = foldLedger([]);
		assert.equal(result.observations.length, 0);
		assert.equal(result.activeObservations.length, 0);
		assert.equal(result.reflections.length, 0);
		assert.equal(result.droppedObservationIds.size, 0);
	});
});

// ── Observations ──

describe("foldLedger — observations", () => {
	it("records observations from om.observations.recorded entries", () => {
		const obs1 = makeObservation({ id: "aaa1111111111111" });
		const obs2 = makeObservation({ id: "bbb2222222222222" });
		const entries = [
			makeObservationsRecordedEntry([obs1], "src1"),
			makeObservationsRecordedEntry([obs2], "src2"),
		];
		const result = foldLedger(entries);
		assert.equal(result.observations.length, 2);
		assert.equal(result.activeObservations.length, 2);
		assert.deepEqual(result.observations.map(o => o.id), ["aaa1111111111111", "bbb2222222222222"]);
	});

	it("uses first-valid observation (ignores duplicates with same id)", () => {
		const obs1 = makeObservation({ id: "aaa1111111111111", content: "original" });
		const obs2 = makeObservation({ id: "aaa1111111111111", content: "duplicate" });
		const entries = [
			makeObservationsRecordedEntry([obs1], "src1"),
			makeObservationsRecordedEntry([obs2], "src2"),
		];
		const result = foldLedger(entries);
		assert.equal(result.observations.length, 1);
		assert.equal(result.observations[0].content, "original");
	});

	it("ignores invalid data entries", () => {
		const entries = [
			makeEntry("custom", { customType: OM_OBSERVATIONS_RECORDED, data: {} }),
			makeEntry("custom", { customType: OM_OBSERVATIONS_RECORDED, data: { observations: [], coversUpToId: "x" } }),
		];
		const result = foldLedger(entries);
		assert.equal(result.observations.length, 0);
	});

	it("handles multiple observations in single entry", () => {
		const obs1 = makeObservation({ id: "aaa1111111111111" });
		const obs2 = makeObservation({ id: "bbb2222222222222" });
		const entries = [makeObservationsRecordedEntry([obs1, obs2], "src1")];
		const result = foldLedger(entries);
		assert.equal(result.observations.length, 2);
	});
});

// ── Reflections ──

describe("foldLedger — reflections", () => {
	it("records reflections from om.reflections.recorded entries", () => {
		const ref1 = makeReflection({ id: "fee1111111111111" });
		const entries = [makeReflectionsRecordedEntry([ref1], "src1")];
		const result = foldLedger(entries);
		assert.equal(result.reflections.length, 1);
		assert.equal(result.reflections[0].id, "fee1111111111111");
	});

	it("uses first-valid reflection (ignores duplicates)", () => {
		const ref1 = makeReflection({ id: "fee1111111111111", content: "original" });
		const ref2 = makeReflection({ id: "fee1111111111111", content: "duplicate" });
		const entries = [
			makeReflectionsRecordedEntry([ref1], "src1"),
			makeReflectionsRecordedEntry([ref2], "src2"),
		];
		const result = foldLedger(entries);
		assert.equal(result.reflections.length, 1);
		assert.equal(result.reflections[0].content, "original");
	});

	it("ignores invalid reflection data", () => {
		const entries = [
			makeEntry("custom", { customType: OM_REFLECTIONS_RECORDED, data: {} }),
		];
		const result = foldLedger(entries);
		assert.equal(result.reflections.length, 0);
	});
});

// ── Drops ──

describe("foldLedger — drops", () => {
	it("marks observations as dropped", () => {
		const obs1 = makeObservation({ id: "aaa1111111111111" });
		const entries = [
			makeObservationsRecordedEntry([obs1], "src1"),
			makeObservationsDroppedEntry(["aaa1111111111111"], "src2"),
		];
		const result = foldLedger(entries);
		assert.equal(result.observations.length, 1);
		assert.equal(result.activeObservations.length, 0);
		assert.equal(result.droppedObservationIds.size, 1);
		assert.equal(result.droppedObservationIds.has("aaa1111111111111"), true);
	});

	it("tracks drop id even when observation not yet seen", () => {
		const entries = [
			makeObservationsDroppedEntry(["aaa1111111111111"], "src1"),
		];
		const result = foldLedger(entries);
		assert.equal(result.observations.length, 0);
		assert.equal(result.droppedObservationIds.has("aaa1111111111111"), true);
	});

	it("ignores invalid drop data", () => {
		const entries = [
			makeEntry("custom", { customType: OM_OBSERVATIONS_DROPPED, data: {} }),
		];
		const result = foldLedger(entries);
		assert.equal(result.droppedObservationIds.size, 0);
	});

	it("drop after observation still drops it from active", () => {
		const obs1 = makeObservation({ id: "aaa1111111111111" });
		const obs2 = makeObservation({ id: "bbb2222222222222" });
		const entries = [
			makeObservationsRecordedEntry([obs1, obs2], "src1"),
			makeObservationsDroppedEntry(["aaa1111111111111"], "src2"),
		];
		const result = foldLedger(entries);
		assert.equal(result.activeObservations.length, 1);
		assert.equal(result.activeObservations[0].id, "bbb2222222222222");
		assert.equal(result.observations.length, 2);
	});

	it("multiple drops accumulate", () => {
		const obs1 = makeObservation({ id: "aaa1111111111111" });
		const obs2 = makeObservation({ id: "bbb2222222222222" });
		const obs3 = makeObservation({ id: "ccc3333333333333" });
		const entries = [
			makeObservationsRecordedEntry([obs1, obs2, obs3], "src1"),
			makeObservationsDroppedEntry(["aaa1111111111111"], "src2"),
			makeObservationsDroppedEntry(["bbb2222222222222"], "src3"),
		];
		const result = foldLedger(entries);
		assert.equal(result.activeObservations.length, 1);
		assert.equal(result.activeObservations[0].id, "ccc3333333333333");
		assert.equal(result.droppedObservationIds.size, 2);
	});
});

// ── upToEntryId boundary ──

describe("foldLedger — upToEntryId boundary", () => {
	it("folds only up to specified entry id", () => {
		const obs1 = makeObservation({ id: "aaa1111111111111" });
		const obs2 = makeObservation({ id: "bbb2222222222222" });
		const entry1 = makeObservationsRecordedEntry([obs1], "src1");
		const entry2 = makeObservationsRecordedEntry([obs2], "src2");
		const result = foldLedger([entry1, entry2], { upToEntryId: entry1.id });
		assert.equal(result.observations.length, 1);
		assert.equal(result.observations[0].id, "aaa1111111111111");
	});

	it("folds through entire branch when upToEntryId is undefined", () => {
		const obs1 = makeObservation({ id: "aaa1111111111111" });
		const obs2 = makeObservation({ id: "bbb2222222222222" });
		const entries = [
			makeObservationsRecordedEntry([obs1], "src1"),
			makeObservationsRecordedEntry([obs2], "src2"),
		];
		const result = foldLedger(entries);
		assert.equal(result.observations.length, 2);
	});

	it("folds through entire branch when upToEntryId is not found", () => {
		const obs1 = makeObservation({ id: "aaa1111111111111" });
		const entries = [makeObservationsRecordedEntry([obs1], "src1")];
		const result = foldLedger(entries, { upToEntryId: "nonexistent" });
		assert.equal(result.observations.length, 1);
	});
});

// ── Mixed entries (source entries interleaved) ──

describe("foldLedger — mixed entries", () => {
	it("skips non-custom entries (messages, etc)", () => {
		const obs1 = makeObservation({ id: "aaa1111111111111" });
		const entries = [
			makeEntry("message", { id: "msg1" }),
			makeObservationsRecordedEntry([obs1], "src1"),
			makeEntry("message", { id: "msg2" }),
		];
		const result = foldLedger(entries);
		assert.equal(result.observations.length, 1);
	});

	it("handles complete session lifecycle", () => {
		const obs1 = makeObservation({ id: "aaa1111111111111" });
		const obs2 = makeObservation({ id: "bbb2222222222222" });
		const obs3 = makeObservation({ id: "ccc3333333333333" });
		const ref1 = makeReflection({ id: "fee1111111111111" });
		const entries = [
			makeEntry("message", { id: "msg1" }),
			makeObservationsRecordedEntry([obs1, obs2], "src1"),
			makeEntry("message", { id: "msg2" }),
			makeReflectionsRecordedEntry([ref1], "src1"),
			makeObservationsRecordedEntry([obs3], "src3"),
			makeObservationsDroppedEntry(["aaa1111111111111"], "src3"),
		];
		const result = foldLedger(entries);
		assert.equal(result.observations.length, 3);
		assert.equal(result.activeObservations.length, 2);
		assert.equal(result.reflections.length, 1);
		assert.equal(result.droppedObservationIds.size, 1);
	});
});

function makeReflectionsSupersededEntry(reflectionIds: string[], coversUpToId: string, id: string): Entry {
	return makeEntry("custom", { id, customType: OM_REFLECTIONS_SUPERSEDED, data: { reflectionIds, coversUpToId } });
}

// ── superseded reflections ──

describe("foldLedger — superseded reflections", () => {
	it("marks reflections as superseded", () => {
		const ref1 = makeReflection({ id: "fee1111111111111" });
		const entries = [
			makeReflectionsRecordedEntry([ref1], "src1"),
			makeReflectionsSupersededEntry(["fee1111111111111"], "src1", "sup-e1"),
		];
		const result = foldLedger(entries);
		assert.equal(result.reflections.length, 1);
		assert.equal(result.activeReflections.length, 0);
		assert.equal(result.supersededReflectionIds.size, 1);
		assert.ok(result.supersededReflectionIds.has("fee1111111111111"));
	});

	it("tracks superseded id even when reflection not yet seen", () => {
		const entries = [
			makeReflectionsSupersededEntry(["fee1111111111111"], "src1", "sup-e1"),
		];
		const result = foldLedger(entries);
		assert.equal(result.reflections.length, 0);
		assert.equal(result.supersededReflectionIds.size, 1);
	});

	it("ignores invalid superseded data", () => {
		const ref1 = makeReflection({ id: "fee1111111111111" });
		const entries = [
			makeReflectionsRecordedEntry([ref1], "src1"),
			makeEntry("custom", "sup-e1", { customType: OM_REFLECTIONS_SUPERSEDED, data: { reflectionIds: [], coversUpToId: "src1" } }),
		];
		const result = foldLedger(entries);
		assert.equal(result.activeReflections.length, 1);
	});

	it("supersede after reflection still removes from active", () => {
		const ref1 = makeReflection({ id: "fee1111111111111" });
		const entries = [
			makeReflectionsRecordedEntry([ref1], "src1"),
			makeReflectionsSupersededEntry(["fee1111111111111"], "src1", "sup-e1"),
		];
		const result = foldLedger(entries);
		assert.equal(result.reflections.length, 1);
		assert.equal(result.activeReflections.length, 0);
	});

	it("multiple supersede entries accumulate", () => {
		const ref1 = makeReflection({ id: "fee1111111111111" });
		const ref2 = makeReflection({ id: "fee2222222222222" });
		const entries = [
			makeReflectionsRecordedEntry([ref1], "src1"),
			makeReflectionsRecordedEntry([ref2], "src1"),
			makeReflectionsSupersededEntry(["fee1111111111111"], "src1", "sup-e1"),
			makeReflectionsSupersededEntry(["fee2222222222222"], "src1", "sup-e2"),
		];
		const result = foldLedger(entries);
		assert.equal(result.reflections.length, 2);
		assert.equal(result.activeReflections.length, 0);
		assert.equal(result.supersededReflectionIds.size, 2);
	});

	it("handles complete session lifecycle with superseded reflections", () => {
		const obs1 = makeObservation({ id: "aaa1111111111111" });
		const obs2 = makeObservation({ id: "bbb2222222222222" });
		const ref1 = makeReflection({ id: "fee1111111111111" });
		const ref2 = makeReflection({ id: "fee2222222222222" });
		const entries = [
			makeEntry("message", { id: "msg1" }),
			makeObservationsRecordedEntry([obs1, obs2], "src1"),
			makeReflectionsRecordedEntry([ref1], "src1"),
			makeReflectionsSupersededEntry(["fee1111111111111"], "src1", "sup-e1"),
			makeReflectionsRecordedEntry([ref2], "src2"),
		];
		const result = foldLedger(entries);
		assert.equal(result.observations.length, 2);
		assert.equal(result.activeObservations.length, 2);
		assert.equal(result.reflections.length, 2);
		assert.equal(result.activeReflections.length, 1);
		assert.equal(result.activeReflections[0].id, "fee2222222222222");
	});
});
