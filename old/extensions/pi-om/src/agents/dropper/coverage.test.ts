import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  reflectionSupportCounts,
  reflectionCoverageTierForCount,
  reflectionCoverageMap,
  coverageTierForObservation,
  observationToDropperLine,
  summarizeCoverageByRelevance,
  emptyCoverageSummaryByRelevance,
  REFLECTION_COVERAGE_DROP_RANK,
  type ReflectionCoverageTier,
} from "./coverage.ts";
import type { Observation, Reflection } from "../../ledger/types.ts";

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

// ── reflectionSupportCounts ──

describe("reflectionSupportCounts", () => {
  it("counts reflections per observation id", () => {
    const ref1 = makeReflection({
      supportingObservationIds: ["aaa1111111111111", "bbb2222222222222"],
    });
    const ref2 = makeReflection({
      supportingObservationIds: ["aaa1111111111111"],
    });
    const counts = reflectionSupportCounts([ref1, ref2]);
    assert.equal(counts.get("aaa1111111111111"), 2);
    assert.equal(counts.get("bbb2222222222222"), 1);
  });

  it("returns empty map for no reflections", () => {
    const counts = reflectionSupportCounts([]);
    assert.equal(counts.size, 0);
  });

  it("deduplicates ids within single reflection", () => {
    const ref1 = makeReflection({
      supportingObservationIds: ["aaa1111111111111", "aaa1111111111111"],
    });
    const counts = reflectionSupportCounts([ref1]);
    assert.equal(counts.get("aaa1111111111111"), 1);
  });
});

// ── reflectionCoverageTierForCount ──

describe("reflectionCoverageTierForCount", () => {
  it("returns 'none' for 0 reflections", () => {
    assert.equal(reflectionCoverageTierForCount(0), "none");
  });

  it("returns 'partial' for 1 reflection", () => {
    assert.equal(reflectionCoverageTierForCount(1), "partial");
  });

  it("returns 'strong' for 2+ reflections", () => {
    assert.equal(reflectionCoverageTierForCount(2), "strong");
    assert.equal(reflectionCoverageTierForCount(10), "strong");
  });

  it("returns 'none' for negative count", () => {
    assert.equal(reflectionCoverageTierForCount(-1), "none");
  });
});

// ── reflectionCoverageMap ──

describe("reflectionCoverageMap", () => {
  it("maps observations to coverage tiers", () => {
    const obs1 = makeObservation({ id: "aaa1111111111111" });
    const obs2 = makeObservation({ id: "bbb2222222222222" });
    const ref1 = makeReflection({
      supportingObservationIds: ["aaa1111111111111"],
    });
    const ref2 = makeReflection({
      supportingObservationIds: ["aaa1111111111111"],
    });
    const map = reflectionCoverageMap([obs1, obs2], [ref1, ref2]);
    assert.equal(map.get("aaa1111111111111"), "strong");
    assert.equal(map.get("bbb2222222222222"), "none");
  });

  it("returns 'none' for observations with no reflections", () => {
    const obs1 = makeObservation({ id: "aaa1111111111111" });
    const map = reflectionCoverageMap([obs1], []);
    assert.equal(map.get("aaa1111111111111"), "none");
  });
});

// ── coverageTierForObservation ──

describe("coverageTierForObservation", () => {
  it("returns tier from map", () => {
    const obs = makeObservation({ id: "aaa1111111111111" });
    const map = new Map<string, ReflectionCoverageTier>([
      ["aaa1111111111111", "partial"],
    ]);
    assert.equal(coverageTierForObservation(obs, map), "partial");
  });

  it("returns 'none' for missing id", () => {
    const obs = makeObservation({ id: "aaa1111111111111" });
    assert.equal(coverageTierForObservation(obs, new Map()), "none");
  });
});

// ── observationToDropperLine ──

describe("observationToDropperLine", () => {
  it("formats observation with coverage tier", () => {
    const obs = makeObservation({
      id: "aaa1111111111111",
      timestamp: "2025-06-17 14:30",
      relevance: "high",
      content: "Critical decision",
    });
    assert.equal(
      observationToDropperLine(obs, "strong"),
      "[aaa1111111111111] 2025-06-17 14:30 [high] [coverage: strong] Critical decision",
    );
  });
});

// ── summarizeCoverageByRelevance ──

describe("summarizeCoverageByRelevance", () => {
  it("summarizes empty observations", () => {
    const summary = summarizeCoverageByRelevance([], new Map());
    assert.equal(summary.low.none.count, 0);
    assert.equal(summary.medium.none.count, 0);
    assert.equal(summary.high.none.count, 0);
    assert.equal(summary.critical.none.count, 0);
  });

  it("summarizes observations by relevance and coverage", () => {
    const obs1 = makeObservation({
      id: "aaa1111111111111",
      relevance: "high",
      tokenCount: 100,
    });
    const obs2 = makeObservation({
      id: "bbb2222222222222",
      relevance: "low",
      tokenCount: 50,
    });
    const map = new Map<string, ReflectionCoverageTier>([
      ["aaa1111111111111", "partial"],
      ["bbb2222222222222", "none"],
    ]);
    const summary = summarizeCoverageByRelevance([obs1, obs2], map);
    assert.equal(summary.high.partial.count, 1);
    assert.equal(summary.high.partial.tokens, 100);
    assert.equal(summary.low.none.count, 1);
    assert.equal(summary.low.none.tokens, 50);
  });
});

// ── emptyCoverageSummaryByRelevance ──

describe("emptyCoverageSummaryByRelevance", () => {
  it("creates empty summary with all zeroed buckets", () => {
    const summary = emptyCoverageSummaryByRelevance();
    for (const relevance of ["low", "medium", "high", "critical"] as const) {
      for (const tier of ["none", "partial", "strong"] as const) {
        assert.equal(summary[relevance][tier].count, 0);
        assert.equal(summary[relevance][tier].tokens, 0);
      }
    }
  });
});

// ── REFLECTION_COVERAGE_DROP_RANK ──

describe("REFLECTION_COVERAGE_DROP_RANK", () => {
  it("ranks 'strong' lowest (safest to drop), 'none' highest (least safe)", () => {
    assert.equal(REFLECTION_COVERAGE_DROP_RANK.strong, 0);
    assert.equal(REFLECTION_COVERAGE_DROP_RANK.partial, 1);
    assert.equal(REFLECTION_COVERAGE_DROP_RANK.none, 2);
  });
});
