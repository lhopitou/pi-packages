import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { observationToSummaryLine, reflectionToSummaryLine, renderSummary, renderHandoverSummary } from "./render-summary.ts";
import type { Observation, Reflection } from "./types.ts";

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

describe("observationToSummaryLine", () => {
	it("formats observation with id, timestamp, relevance, content", () => {
		const obs = makeObservation({ id: "aaa1111111111111", timestamp: "2025-06-17 14:30", relevance: "high", content: "User prefers dark theme" });
		assert.equal(observationToSummaryLine(obs), "[aaa1111111111111] 2025-06-17 14:30 [high] User prefers dark theme");
	});

	it("formats low relevance observation", () => {
		const obs = makeObservation({ id: "bbb2222222222222", timestamp: "2025-01-01 00:00", relevance: "low", content: "Routine tool ack" });
		assert.equal(observationToSummaryLine(obs), "[bbb2222222222222] 2025-01-01 00:00 [low] Routine tool ack");
	});
});

describe("reflectionToSummaryLine", () => {
	it("formats reflection with id and content", () => {
		const ref = makeReflection({ id: "fee1111111111111", content: "Project uses TypeScript strict mode" });
		assert.equal(reflectionToSummaryLine(ref), "[fee1111111111111] Project uses TypeScript strict mode");
	});
});

describe("renderSummary", () => {
	it("returns empty string when both are empty", () => {
		assert.equal(renderSummary([], []), "");
	});

	it("returns context instructions + reflections section when only reflections exist", () => {
		const ref = makeReflection({ id: "fee1111111111111", content: "Test reflection" });
		const summary = renderSummary([ref], []);
		assert.ok(summary.includes("Reflections"));
		assert.ok(summary.includes("[fee1111111111111] Test reflection"));
		assert.ok(summary.includes("condensed memories"));
	});

	it("returns context instructions + observations section when only observations exist", () => {
		const obs = makeObservation({ id: "aaa1111111111111", content: "Test observation" });
		const summary = renderSummary([], [obs]);
		assert.ok(summary.includes("Observations"));
		assert.ok(summary.includes("[aaa1111111111111]"));
	});

	it("returns both sections when both exist", () => {
		const ref = makeReflection({ id: "fee1111111111111", content: "Test reflection" });
		const obs = makeObservation({ id: "aaa1111111111111", content: "Test observation" });
		const summary = renderSummary([ref], [obs]);
		assert.ok(summary.includes("Reflections"));
		assert.ok(summary.includes("Observations"));
		assert.ok(summary.includes("[fee1111111111111]"));
		assert.ok(summary.includes("[aaa1111111111111]"));
	});
});

describe("renderHandoverSummary", () => {
	it("returns empty string when both are empty", () => {
		assert.equal(renderHandoverSummary([], []), "");
	});

	it("returns handover context instructions + durable facts section when only reflections exist", () => {
		const ref = makeReflection({ id: "fee1111111111111", content: "Project uses TypeScript strict mode" });
		const summary = renderHandoverSummary([ref], []);
		assert.ok(summary.includes("Durable Facts"));
		assert.ok(summary.includes("- Project uses TypeScript strict mode"));
		assert.ok(summary.includes("handover document"));
		// Should NOT include ledger bookkeeping (IDs, brackets)
		assert.ok(!summary.includes("[fee1111111111111]"));
	});

	it("returns handover context instructions + observations section when only observations exist", () => {
		const obs = makeObservation({ id: "aaa1111111111111", content: "User prefers dark theme", timestamp: "2025-06-17 14:30" });
		const summary = renderHandoverSummary([], [obs]);
		assert.ok(summary.includes("Observations"));
		assert.ok(summary.includes("- 2025-06-17 14:30 — User prefers dark theme"));
		// Should NOT include ledger bookkeeping (IDs, relevance markers)
		assert.ok(!summary.includes("[aaa1111111111111]"));
		assert.ok(!summary.includes("[medium]"));
	});

	it("returns both sections when both exist", () => {
		const ref = makeReflection({ id: "fee1111111111111", content: "Test reflection" });
		const obs = makeObservation({ id: "aaa1111111111111", content: "Test observation", timestamp: "2025-01-01 12:00" });
		const summary = renderHandoverSummary([ref], [obs]);
		assert.ok(summary.includes("Durable Facts"));
		assert.ok(summary.includes("Observations"));
		assert.ok(summary.includes("- Test reflection"));
		assert.ok(summary.includes("- 2025-01-01 12:00 — Test observation"));
	});

	it("strips all ledger bookkeeping — no IDs, no relevance markers", () => {
		const ref = makeReflection({ id: "fee1111111111111", content: "Test reflection" });
		const obs = makeObservation({ id: "aaa1111111111111", content: "Test observation", relevance: "high", timestamp: "2025-06-17 14:30" });
		const summary = renderHandoverSummary([ref], [obs]);
		assert.ok(!summary.includes("[fee1111111111111]"));
		assert.ok(!summary.includes("[aaa1111111111111]"));
		assert.ok(!summary.includes("[high]"));
		assert.ok(!summary.includes("[medium]"));
	});

	it("includes handover-specific instructions (not compaction instructions)", () => {
		const summary = renderHandoverSummary([makeReflection()], [makeObservation()]);
		assert.ok(summary.includes("handover document"));
		assert.ok(summary.includes("Durable Facts"));
	});

	it("renders multiple reflections as bullet list", () => {
		const ref1 = makeReflection({ id: "fee1111111111111", content: "Fact A" });
		const ref2 = makeReflection({ id: "fee2222222222222", content: "Fact B" });
		const summary = renderHandoverSummary([ref1, ref2], []);
		assert.ok(summary.includes("- Fact A"));
		assert.ok(summary.includes("- Fact B"));
	});

	it("renders multiple observations with timestamps as bullet list", () => {
		const obs1 = makeObservation({ id: "aaa1111111111111", content: "Event A", timestamp: "2025-06-17 10:00" });
		const obs2 = makeObservation({ id: "bbb2222222222222", content: "Event B", timestamp: "2025-06-17 11:00" });
		const summary = renderHandoverSummary([], [obs1, obs2]);
		assert.ok(summary.includes("- 2025-06-17 10:00 — Event A"));
		assert.ok(summary.includes("- 2025-06-17 11:00 — Event B"));
	});
});
