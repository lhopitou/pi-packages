import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	fullProjection,
	visibleProjection,
	buildCompactionProjection,
	diffProjection,
} from "./projection.ts";
import {
	OM_OBSERVATIONS_RECORDED,
	OM_REFLECTIONS_RECORDED,
	OM_OBSERVATIONS_DROPPED,
	OM_FOLDED,
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
		id: overrides.id ?? "fee1111111111111",
		content: overrides.content ?? "Test reflection",
		supportingObservationIds: overrides.supportingObservationIds ?? ["a1b2c3d4e5f6a1b2"],
		tokenCount: overrides.tokenCount ?? 8,
	};
}

function makeEntry(type: string, id: string, overrides: Partial<Entry> = {}): Entry {
	return { type, id, ...overrides };
}

// Source entries with fixed ids that coversUpToId can reference
function makeSourceEntry(id: string): Entry {
	return { type: "message", id, message: { role: "user", content: [{ type: "text", text: "source" }], timestamp: Date.now() } };
}

function makeObservationsRecordedEntry(observations: Observation[], coversUpToId: string, id: string): Entry {
	return makeEntry("custom", id, { customType: OM_OBSERVATIONS_RECORDED, data: { observations, coversUpToId } });
}

function makeReflectionsRecordedEntry(reflections: Reflection[], coversUpToId: string, id: string): Entry {
	return makeEntry("custom", id, { customType: OM_REFLECTIONS_RECORDED, data: { reflections, coversUpToId } });
}

function makeObservationsDroppedEntry(observationIds: string[], coversUpToId: string, id: string): Entry {
	return makeEntry("custom", id, { customType: OM_OBSERVATIONS_DROPPED, data: { observationIds, coversUpToId } });
}

function makeReflectionsSupersededEntry(reflectionIds: string[], coversUpToId: string, id: string): Entry {
	return makeEntry("custom", id, { customType: "om.reflections.superseded", data: { reflectionIds, coversUpToId } });
}

function makeCompactionEntry(firstKeptEntryId: string, details: Record<string, unknown>, id: string): Entry {
	return makeEntry("compaction", id, { firstKeptEntryId, details });
}

// ── fullProjection ──

describe("fullProjection", () => {
	it("returns empty projection for empty entries", () => {
		const proj = fullProjection([]);
		assert.equal(proj.observations.length, 0);
		assert.equal(proj.reflections.length, 0);
	});

	it("returns all observations and reflections through tip", () => {
		const obs1 = makeObservation({ id: "aaa1111111111111" });
		const obs2 = makeObservation({ id: "bbb2222222222222" });
		const ref1 = makeReflection({ id: "fee1111111111111" });
		const entries = [
			makeSourceEntry("src1"),
			makeSourceEntry("src2"),
			makeObservationsRecordedEntry([obs1], "src1", "obs-e1"),
			makeReflectionsRecordedEntry([ref1], "src1", "ref-e1"),
			makeObservationsRecordedEntry([obs2], "src2", "obs-e2"),
		];
		const proj = fullProjection(entries);
		assert.equal(proj.observations.length, 2);
		assert.equal(proj.reflections.length, 1);
	});

	it("filters dropped observations", () => {
		const obs1 = makeObservation({ id: "aaa1111111111111" });
		const obs2 = makeObservation({ id: "bbb2222222222222" });
		const entries = [
			makeSourceEntry("src1"),
			makeSourceEntry("src2"),
			makeObservationsRecordedEntry([obs1, obs2], "src1", "obs-e1"),
			makeObservationsDroppedEntry(["aaa1111111111111"], "src2", "drop-e1"),
		];
		const proj = fullProjection(entries);
		assert.equal(proj.observations.length, 1);
		assert.equal(proj.observations[0].id, "bbb2222222222222");
	});

	it("respects upToEntryId boundary", () => {
		const obs1 = makeObservation({ id: "aaa1111111111111" });
		const obs2 = makeObservation({ id: "bbb2222222222222" });
		const entries = [
			makeSourceEntry("src1"),
			makeSourceEntry("src2"),
			makeObservationsRecordedEntry([obs1], "src1", "obs-e1"),
			makeObservationsRecordedEntry([obs2], "src2", "obs-e2"),
		];
		// upToEntryId "obs-e1" means boundary at index 2
		// obs-e1 coversUpToId "src1" (index 0) ≤ 2 ✓
		// obs-e2 coversUpToId "src2" (index 1) ≤ 2 ✓ — both are included
		// This is correct behavior: boundary limits by source coverage, not entry position
		const proj = fullProjection(entries, "obs-e1");
		assert.equal(proj.observations.length, 2);
	});

	it("limits observations when coversUpToId is beyond boundary", () => {
		const obs1 = makeObservation({ id: "aaa1111111111111" });
		const obs2 = makeObservation({ id: "bbb2222222222222" });
		const entries = [
			makeSourceEntry("src1"),
			makeSourceEntry("src2"),
			makeObservationsRecordedEntry([obs1], "src1", "obs-e1"),
			// obs-e2 covers src2 (index 1), which is beyond boundary at src1 (index 0)
			makeObservationsRecordedEntry([obs2], "src2", "obs-e2"),
		];
		const proj = fullProjection(entries, "src1");
		// Boundary is at src1 (index 0). obs-e1 coversUpToId src1 (0) ≤ 0 ✓. obs-e2 coversUpToId src2 (1) > 0 ✗.
		assert.equal(proj.observations.length, 1);
		assert.equal(proj.observations[0].id, "aaa1111111111111");
	});

	it("filters superseded reflections", () => {
		const ref1 = makeReflection({ id: "fee1111111111111" });
		const ref2 = makeReflection({ id: "fee2222222222222" });
		const entries = [
			makeSourceEntry("src1"),
			makeReflectionsRecordedEntry([ref1], "src1", "ref-e1"),
			makeReflectionsRecordedEntry([ref2], "src1", "ref-e2"),
			makeReflectionsSupersededEntry(["fee1111111111111"], "src1", "sup-e1"),
		];
		const proj = fullProjection(entries);
		assert.equal(proj.reflections.length, 1);
		assert.equal(proj.reflections[0].id, "fee2222222222222");
	});
});

// ── visibleProjection ──

describe("visibleProjection", () => {
	it("returns empty projection when no compaction exists", () => {
		const obs1 = makeObservation({ id: "aaa1111111111111" });
		const entries = [
			makeSourceEntry("src1"),
			makeObservationsRecordedEntry([obs1], "src1", "obs-e1"),
		];
		const proj = visibleProjection(entries);
		assert.equal(proj.observations.length, 0);
		assert.equal(proj.reflections.length, 0);
	});

	it("returns memory from latest compaction details", () => {
		const obs1 = makeObservation({ id: "aaa1111111111111" });
		const ref1 = makeReflection({ id: "fee1111111111111" });
		const entries = [
			makeSourceEntry("m1"),
			makeCompactionEntry("m1", {
				type: OM_FOLDED,
				version: 1,
				fullFold: true,
				observations: [obs1],
				reflections: [ref1],
			}, "comp1"),
		];
		const proj = visibleProjection(entries);
		assert.equal(proj.observations.length, 1);
		assert.equal(proj.reflections.length, 1);
	});

	it("returns empty when compaction has non-V3 details", () => {
		const entries = [
			makeSourceEntry("m1"),
			makeCompactionEntry("m1", { type: "old_format" }, "comp1"),
		];
		const proj = visibleProjection(entries);
		assert.equal(proj.observations.length, 0);
	});
});

// ── buildCompactionProjection ──

describe("buildCompactionProjection", () => {
	it("returns normal projection when observation tokens are under pool max", () => {
		const obs1 = makeObservation({ id: "aaa1111111111111", tokenCount: 100 });
		const entries = [
			makeSourceEntry("src1"),
			makeObservationsRecordedEntry([obs1], "src1", "obs-e1"),
		];
		const proj = buildCompactionProjection(entries, "src1", { observationsPoolMaxTokens: 200 });
		assert.equal(proj.fullFold, false);
		assert.equal(proj.observations.length, 1);
	});

	it("includes reflections on first compaction (no prior full fold)", () => {
		const obs1 = makeObservation({ id: "aaa1111111111111", tokenCount: 100 });
		const ref1 = makeReflection({ id: "fee1111111111111" });
		const entries = [
			makeSourceEntry("src1"),
			makeObservationsRecordedEntry([obs1], "src1", "obs-e1"),
			makeReflectionsRecordedEntry([ref1], "src1", "ref-e1"),
		];
		const proj = buildCompactionProjection(entries, "src1", { observationsPoolMaxTokens: 200 });
		assert.equal(proj.fullFold, false);
		assert.equal(proj.observations.length, 1);
		assert.equal(proj.reflections.length, 1);
	});

	it("includes drops on first compaction (no prior full fold)", () => {
		const obs1 = makeObservation({ id: "aaa1111111111111", tokenCount: 100 });
		const obs2 = makeObservation({ id: "bbb2222222222222", tokenCount: 100 });
		const entries = [
			makeSourceEntry("src1"),
			makeObservationsRecordedEntry([obs1, obs2], "src1", "obs-e1"),
			makeObservationsDroppedEntry(["aaa1111111111111"], "src1", "drop-e1"),
		];
		const proj = buildCompactionProjection(entries, "src1", { observationsPoolMaxTokens: 200 });
		assert.equal(proj.fullFold, false);
		assert.equal(proj.observations.length, 1);
		assert.equal(proj.observations[0].id, "bbb2222222222222");
	});

	it("uses maintenance boundary for reflections after prior full fold", () => {
		const obs1 = makeObservation({ id: "aaa1111111111111", tokenCount: 100 });
		const ref1 = makeReflection({ id: "fee1111111111111" });
		const ref2 = makeReflection({ id: "fee2222222222222" });
		// First compaction was a full fold at src1
		const entries = [
			makeSourceEntry("src1"),
			makeSourceEntry("src2"),
			makeObservationsRecordedEntry([obs1], "src1", "obs-e1"),
			makeReflectionsRecordedEntry([ref1], "src1", "ref-e1"),
			makeCompactionEntry("src1", {
				type: OM_FOLDED,
				version: 1,
				fullFold: true,
				observations: [obs1],
				reflections: [ref1],
			}, "comp1"),
			makeReflectionsRecordedEntry([ref2], "src2", "ref-e2"),
		];
		const proj = buildCompactionProjection(entries, "src2", { observationsPoolMaxTokens: 200 });
		assert.equal(proj.fullFold, false);
		// Maintenance boundary at src1 includes ref1 (coversUpToId src1 ≤ src1 boundary)
		// but excludes ref2 (coversUpToId src2 > src1 boundary)
		assert.equal(proj.reflections.length, 1);
		assert.equal(proj.reflections[0].id, "fee1111111111111");
	});

	it("returns full fold projection when observation tokens exceed pool max", () => {
		const obs1 = makeObservation({ id: "aaa1111111111111", tokenCount: 500 });
		const ref1 = makeReflection({ id: "fee1111111111111" });
		const entries = [
			makeSourceEntry("src1"),
			makeObservationsRecordedEntry([obs1], "src1", "obs-e1"),
			makeReflectionsRecordedEntry([ref1], "src1", "ref-e1"),
		];
		const proj = buildCompactionProjection(entries, "src1", { observationsPoolMaxTokens: 100 });
		assert.equal(proj.fullFold, true);
		assert.equal(proj.observations.length, 1);
		assert.equal(proj.reflections.length, 1);
	});

	it("full fold includes all reflections even on first compaction", () => {
		const obs1 = makeObservation({ id: "aaa1111111111111", tokenCount: 500 });
		const ref1 = makeReflection({ id: "fee1111111111111" });
		const ref2 = makeReflection({ id: "fee2222222222222" });
		const entries = [
			makeSourceEntry("src1"),
			makeSourceEntry("src2"),
			makeObservationsRecordedEntry([obs1], "src1", "obs-e1"),
			makeReflectionsRecordedEntry([ref1], "src1", "ref-e1"),
			makeReflectionsRecordedEntry([ref2], "src2", "ref-e2"),
		];
		const proj = buildCompactionProjection(entries, "src2", { observationsPoolMaxTokens: 100 });
		assert.equal(proj.fullFold, true);
		assert.equal(proj.observations.length, 1);
		assert.equal(proj.reflections.length, 2);
	});

	it("includes MemoryDetails in result", () => {
		const obs1 = makeObservation({ id: "aaa1111111111111", tokenCount: 100 });
		const entries = [
			makeSourceEntry("src1"),
			makeObservationsRecordedEntry([obs1], "src1", "obs-e1"),
		];
		const proj = buildCompactionProjection(entries, "src1", { observationsPoolMaxTokens: 200 });
		assert.equal(proj.details.type, OM_FOLDED);
		assert.equal(proj.details.version, 1);
	});

	it("excludes superseded reflections from projection", () => {
		const obs1 = makeObservation({ id: "aaa1111111111111", tokenCount: 100 });
		const ref1 = makeReflection({ id: "fee1111111111111" });
		const ref2 = makeReflection({ id: "fee2222222222222" });
		const entries = [
			makeSourceEntry("src1"),
			makeObservationsRecordedEntry([obs1], "src1", "obs-e1"),
			makeReflectionsRecordedEntry([ref1], "src1", "ref-e1"),
			makeReflectionsRecordedEntry([ref2], "src1", "ref-e2"),
			makeReflectionsSupersededEntry(["fee1111111111111"], "src1", "sup-e1"),
		];
		const proj = buildCompactionProjection(entries, "src1", { observationsPoolMaxTokens: 200 });
		assert.equal(proj.reflections.length, 1);
		assert.equal(proj.reflections[0].id, "fee2222222222222");
	});
});

// ── diffProjection ──

describe("diffProjection", () => {
	it("reports no differences when projections are equal", () => {
		const obs1 = makeObservation({ id: "aaa1111111111111" });
		const ref1 = makeReflection({ id: "fee1111111111111" });
		const visible = { observations: [obs1], reflections: [ref1] };
		const full = { observations: [obs1], reflections: [ref1] };
		const diff = diffProjection(visible, full);
		assert.equal(diff.observationsOnlyInFull.length, 0);
		assert.equal(diff.reflectionsOnlyInFull.length, 0);
		assert.equal(diff.droppedOnlyInFull.length, 0);
	});

	it("reports observations only in full projection", () => {
		const obs1 = makeObservation({ id: "aaa1111111111111" });
		const obs2 = makeObservation({ id: "bbb2222222222222" });
		const visible = { observations: [obs1], reflections: [] };
		const full = { observations: [obs1, obs2], reflections: [] };
		const diff = diffProjection(visible, full);
		assert.equal(diff.observationsOnlyInFull.length, 1);
		assert.equal(diff.observationsOnlyInFull[0].id, "bbb2222222222222");
	});

	it("reports reflections only in full projection", () => {
		const ref1 = makeReflection({ id: "fee1111111111111" });
		const ref2 = makeReflection({ id: "fee2222222222222" });
		const visible = { observations: [], reflections: [ref1] };
		const full = { observations: [], reflections: [ref1, ref2] };
		const diff = diffProjection(visible, full);
		assert.equal(diff.reflectionsOnlyInFull.length, 1);
		assert.equal(diff.reflectionsOnlyInFull[0].id, "fee2222222222222");
	});

	it("reports dropped observations (in visible but not in full)", () => {
		const obs1 = makeObservation({ id: "aaa1111111111111" });
		const obs2 = makeObservation({ id: "bbb2222222222222" });
		const visible = { observations: [obs1, obs2], reflections: [] };
		const full = { observations: [obs1], reflections: [] };
		const diff = diffProjection(visible, full);
		assert.equal(diff.droppedOnlyInFull.length, 1);
		assert.equal(diff.droppedOnlyInFull[0].id, "bbb2222222222222");
	});
});
