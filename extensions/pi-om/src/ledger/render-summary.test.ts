import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { observationToSummaryLine, reflectionToSummaryLine, renderSummary } from "./render-summary.ts";
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

	it("includes recall tool instructions", () => {
		const summary = renderSummary([makeReflection()], [makeObservation()]);
		assert.ok(summary.includes("recall tool"));
	});
});
