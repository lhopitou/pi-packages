import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  recallMemorySources,
  type RecallResult,
  type Entry,
  type Observation,
  type Reflection,
} from "./recall.ts";
import {
  OM_OBSERVATIONS_RECORDED,
  OM_REFLECTIONS_RECORDED,
  OM_OBSERVATIONS_DROPPED,
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
    supportingObservationIds: overrides.supportingObservationIds ?? [
      "a1b2c3d4e5f6a1b2",
    ],
    tokenCount: overrides.tokenCount ?? 8,
  };
}

function makeEntry(type: string, overrides: Partial<Entry> = {}): Entry {
  return {
    type,
    id: overrides.id ?? `e${Math.random().toString(36).slice(2, 8)}`,
    ...overrides,
  };
}

function makeObservationsRecordedEntry(
  observations: Observation[],
  coversUpToId: string,
  overrides: Partial<Entry> = {},
): Entry {
  return makeEntry("custom", {
    customType: OM_OBSERVATIONS_RECORDED,
    data: { observations, coversUpToId },
    ...overrides,
  });
}

function makeReflectionsRecordedEntry(
  reflections: Reflection[],
  coversUpToId: string,
  overrides: Partial<Entry> = {},
): Entry {
  return makeEntry("custom", {
    customType: OM_REFLECTIONS_RECORDED,
    data: { reflections, coversUpToId },
    ...overrides,
  });
}

function makeObservationsDroppedEntry(
  observationIds: string[],
  coversUpToId: string,
): Entry {
  return makeEntry("custom", {
    customType: OM_OBSERVATIONS_DROPPED,
    data: { observationIds, coversUpToId },
  });
}

function makeMessageEntry(id: string): Entry {
  return makeEntry("message", {
    id,
    message: {
      role: "user",
      content: [{ type: "text", text: "hello" }],
      timestamp: Date.now(),
    },
  });
}

// ── Not found ──

describe("recallMemorySources — not_found", () => {
  it("returns not_found for unknown memory id", () => {
    const result = recallMemorySources([], "unknown00000");
    assert.equal(result.status, "not_found");
    assert.equal(result.kind, undefined);
    assert.equal(result.collision, false);
    assert.equal(result.partial, false);
  });

  it("returns not_found when id is not in any entry", () => {
    const obs1 = makeObservation({ id: "aaa1111111111111" });
    const entries = [makeObservationsRecordedEntry([obs1], "src1")];
    const result = recallMemorySources(entries, "unknown00000");
    assert.equal(result.status, "not_found");
  });
});

// ── Observation recall ──

describe("recallMemorySources — observation", () => {
  it("finds observation by id", () => {
    const obs1 = makeObservation({
      id: "aaa1111111111111",
      sourceEntryIds: ["src1"],
    });
    const msgEntry = makeMessageEntry("src1");
    const entries = [msgEntry, makeObservationsRecordedEntry([obs1], "src1")];
    const result = recallMemorySources(entries, "aaa1111111111111") as Extract<
      RecallResult,
      { status: "found" }
    >;
    assert.equal(result.status, "found");
    assert.equal(result.kind, "observation");
    assert.equal(result.observations.length, 1);
    assert.equal(result.observations[0].observation.id, "aaa1111111111111");
    assert.equal(result.observations[0].status, "active");
  });

  it("marks observation as dropped when a drop entry exists", () => {
    const obs1 = makeObservation({
      id: "aaa1111111111111",
      sourceEntryIds: ["src1"],
    });
    const msgEntry = makeMessageEntry("src1");
    const entries = [
      msgEntry,
      makeObservationsRecordedEntry([obs1], "src1"),
      makeObservationsDroppedEntry(["aaa1111111111111"], "src1"),
    ];
    const result = recallMemorySources(entries, "aaa1111111111111") as Extract<
      RecallResult,
      { status: "found" }
    >;
    assert.equal(result.observations[0].status, "dropped");
  });

  it("resolves source entries from sourceEntryIds", () => {
    const obs1 = makeObservation({
      id: "aaa1111111111111",
      sourceEntryIds: ["src1"],
    });
    const msgEntry = makeMessageEntry("src1");
    const entries = [msgEntry, makeObservationsRecordedEntry([obs1], "src1")];
    const result = recallMemorySources(entries, "aaa1111111111111") as Extract<
      RecallResult,
      { status: "found" }
    >;
    assert.equal(result.observations[0].sourceEntries.length, 1);
    assert.equal(result.observations[0].sourceEntries[0].id, "src1");
    assert.equal(result.observations[0].missingSourceEntryIds.length, 0);
  });

  it("reports missing source entries", () => {
    const obs1 = makeObservation({
      id: "aaa1111111111111",
      sourceEntryIds: ["missing_src"],
    });
    const entries = [makeObservationsRecordedEntry([obs1], "src1")];
    const result = recallMemorySources(entries, "aaa1111111111111") as Extract<
      RecallResult,
      { status: "found" }
    >;
    assert.equal(result.observations[0].missingSourceEntryIds.length, 1);
    assert.equal(
      result.observations[0].missingSourceEntryIds[0],
      "missing_src",
    );
    assert.equal(result.partial, true);
  });
});

// ── Reflection recall ──

describe("recallMemorySources — reflection", () => {
  it("finds reflection by id", () => {
    const ref1 = makeReflection({
      id: "fee1111111111111",
      supportingObservationIds: ["aaa1111111111111"],
    });
    const obs1 = makeObservation({
      id: "aaa1111111111111",
      sourceEntryIds: ["src1"],
    });
    const msgEntry = makeMessageEntry("src1");
    const entries = [
      msgEntry,
      makeObservationsRecordedEntry([obs1], "src1"),
      makeReflectionsRecordedEntry([ref1], "src1"),
    ];
    const result = recallMemorySources(entries, "fee1111111111111") as Extract<
      RecallResult,
      { status: "found" }
    >;
    assert.equal(result.status, "found");
    assert.equal(result.kind, "reflection");
    assert.equal(result.reflections.length, 1);
    assert.equal(result.reflections[0].reflection.id, "fee1111111111111");
  });

  it("pulls supporting observations into recalled result", () => {
    const ref1 = makeReflection({
      id: "fee1111111111111",
      supportingObservationIds: ["aaa1111111111111"],
    });
    const obs1 = makeObservation({
      id: "aaa1111111111111",
      sourceEntryIds: ["src1"],
    });
    const msgEntry = makeMessageEntry("src1");
    const entries = [
      msgEntry,
      makeObservationsRecordedEntry([obs1], "src1"),
      makeReflectionsRecordedEntry([ref1], "src1"),
    ];
    const result = recallMemorySources(entries, "fee1111111111111") as Extract<
      RecallResult,
      { status: "found" }
    >;
    assert.equal(result.observations.length, 1);
    assert.equal(result.observations[0].observation.id, "aaa1111111111111");
  });

  it("reports missing supporting observation ids", () => {
    const ref1 = makeReflection({
      id: "fee1111111111111",
      supportingObservationIds: ["missing_obs"],
    });
    const entries = [makeReflectionsRecordedEntry([ref1], "src1")];
    const result = recallMemorySources(entries, "fee1111111111111") as Extract<
      RecallResult,
      { status: "found" }
    >;
    assert.equal(result.missingSupportingObservationIds.length, 1);
    assert.equal(result.missingSupportingObservationIds[0], "missing_obs");
    assert.equal(result.partial, true);
  });
});

// ── Mixed collision ──

describe("recallMemorySources — collision", () => {
  it("reports collision when id matches both observation and reflection", () => {
    // Using the same id for both (which shouldn't happen in practice but tests the collision logic)
    const sharedId = "abc123456789abcd";
    const obs1 = makeObservation({ id: sharedId, sourceEntryIds: ["src1"] });
    const ref1 = makeReflection({
      id: sharedId,
      supportingObservationIds: [sharedId],
    });
    const msgEntry = makeMessageEntry("src1");
    const entries = [
      msgEntry,
      makeObservationsRecordedEntry([obs1], "src1"),
      makeReflectionsRecordedEntry([ref1], "src1"),
    ];
    const result = recallMemorySources(entries, sharedId) as Extract<
      RecallResult,
      { status: "found" }
    >;
    assert.equal(result.kind, "mixed");
    assert.equal(result.collision, true);
  });
});
