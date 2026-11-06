import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeDropObservationIds, selectDropCandidates } from "./agent.ts";
import type { Observation } from "../../ledger/types.ts";

function makeObservation(overrides: Partial<Observation> = {}): Observation {
  return {
    id: overrides.id ?? "aaa1111111111111",
    content: overrides.content ?? "Test observation",
    timestamp: overrides.timestamp ?? "2025-01-01 12:00",
    relevance: overrides.relevance ?? "medium",
    sourceEntryIds: overrides.sourceEntryIds ?? ["src1"],
    tokenCount: overrides.tokenCount ?? 10,
  };
}

// ── normalizeDropObservationIds ──

describe("normalizeDropObservationIds", () => {
  it("returns undefined for undefined input", () => {
    assert.equal(
      normalizeDropObservationIds(undefined, [makeObservation()]),
      undefined,
    );
  });

  it("returns undefined for empty array", () => {
    assert.equal(
      normalizeDropObservationIds([], [makeObservation()]),
      undefined,
    );
  });

  it("returns valid ids that exist in observations", () => {
    const obs = [
      makeObservation({ id: "aaa1111111111111" }),
      makeObservation({ id: "bbb2222222222222" }),
    ];
    const result = normalizeDropObservationIds(
      ["aaa1111111111111", "bbb2222222222222"],
      obs,
    );
    assert.deepEqual(result, ["aaa1111111111111", "bbb2222222222222"]);
  });

  it("filters out ids not in observations", () => {
    const obs = [makeObservation({ id: "aaa1111111111111" })];
    const result = normalizeDropObservationIds(
      ["aaa1111111111111", "unknown00000"],
      obs,
    );
    assert.deepEqual(result, ["aaa1111111111111"]);
  });

  it("returns undefined when all ids are invalid", () => {
    const obs = [makeObservation({ id: "aaa1111111111111" })];
    assert.equal(
      normalizeDropObservationIds(["unknown00000", "invalid0000"], obs),
      undefined,
    );
  });

  it("deduplicates ids", () => {
    const obs = [makeObservation({ id: "aaa1111111111111" })];
    const result = normalizeDropObservationIds(
      ["aaa1111111111111", "aaa1111111111111"],
      obs,
    );
    assert.deepEqual(result, ["aaa1111111111111"]);
  });
});

// ── selectDropCandidates ──

describe("selectDropCandidates", () => {
  it("returns empty array when maxDrops is 0", () => {
    const ids = ["aaa1111111111111"];
    const obs = [makeObservation({ id: "aaa1111111111111" })];
    assert.deepEqual(selectDropCandidates(ids, obs, 0), []);
  });

  it("returns empty array when ids is empty", () => {
    assert.deepEqual(selectDropCandidates([], [makeObservation()], 5), []);
  });

  it("selects candidates limited by maxDrops", () => {
    const obs1 = makeObservation({
      id: "aaa1111111111111",
      relevance: "low",
      timestamp: "2025-01-01 12:00",
    });
    const obs2 = makeObservation({
      id: "bbb2222222222222",
      relevance: "low",
      timestamp: "2025-01-02 12:00",
    });
    const obs3 = makeObservation({
      id: "ccc3333333333333",
      relevance: "low",
      timestamp: "2025-01-03 12:00",
    });
    const result = selectDropCandidates(
      ["aaa1111111111111", "bbb2222222222222", "ccc3333333333333"],
      [obs1, obs2, obs3],
      2,
    );
    assert.equal(result.length, 2);
  });

  it("prefers lower relevance for dropping", () => {
    const obsLow = makeObservation({
      id: "aaa1111111111111",
      relevance: "low",
      timestamp: "2025-01-01 12:00",
    });
    const obsHigh = makeObservation({
      id: "bbb2222222222222",
      relevance: "high",
      timestamp: "2025-01-01 12:00",
    });
    const result = selectDropCandidates(
      ["aaa1111111111111", "bbb2222222222222"],
      [obsLow, obsHigh],
      1,
    );
    assert.equal(result.length, 1);
    assert.equal(result[0], "aaa1111111111111"); // low relevance drops first
  });

  it("prefers older observations for dropping", () => {
    const obsOld = makeObservation({
      id: "aaa1111111111111",
      relevance: "medium",
      timestamp: "2025-01-01 12:00",
    });
    const obsNew = makeObservation({
      id: "bbb2222222222222",
      relevance: "medium",
      timestamp: "2025-06-01 12:00",
    });
    const result = selectDropCandidates(
      ["aaa1111111111111", "bbb2222222222222"],
      [obsOld, obsNew],
      1,
    );
    assert.equal(result.length, 1);
    assert.equal(result[0], "aaa1111111111111"); // older drops first with same relevance
  });

  it("filters out ids not matching any observation", () => {
    const obs = [makeObservation({ id: "aaa1111111111111", relevance: "low" })];
    const result = selectDropCandidates(
      ["aaa1111111111111", "unknown00000"],
      obs,
      5,
    );
    assert.equal(result.length, 1);
    assert.equal(result[0], "aaa1111111111111");
  });

  it("prefers strong coverage (safest to drop) over none coverage", () => {
    const obsStrong = makeObservation({
      id: "aaa1111111111111",
      relevance: "medium",
      timestamp: "2025-01-01 12:00",
    });
    const obsNone = makeObservation({
      id: "bbb2222222222222",
      relevance: "medium",
      timestamp: "2025-01-01 12:00",
    });
    // Create reflections to provide coverage
    // coverage map: aaa -> strong, bbb -> none
    const reflections = [
      {
        id: "fee1111111111111",
        content: "r1",
        supportingObservationIds: ["aaa1111111111111"],
        tokenCount: 5,
      },
      {
        id: "fee2222222222222",
        content: "r2",
        supportingObservationIds: ["aaa1111111111111"],
        tokenCount: 5,
      },
    ];
    const result = selectDropCandidates(
      ["aaa1111111111111", "bbb2222222222222"],
      [obsStrong, obsNone],
      1,
      reflections as any,
    );
    assert.equal(result.length, 1);
    // Strong coverage observation is safer to drop (rank 0) than none coverage (rank 2)
    assert.equal(result[0], "aaa1111111111111");
  });
});
