import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  observationTokenSum,
  observationPoolFullness,
  droppableObservationCount,
  maxDropCountForPool,
  observationPoolMetrics,
} from "./pool.ts";
import type { Observation } from "../../ledger/types.ts";

function makeObservation(overrides: Partial<Observation> = {}): Observation {
  return {
    id: overrides.id ?? "aaa1111111111111",
    content: overrides.content ?? "Test",
    timestamp: overrides.timestamp ?? "2025-01-01 12:00",
    relevance: overrides.relevance ?? "medium",
    sourceEntryIds: overrides.sourceEntryIds ?? ["src1"],
    tokenCount: overrides.tokenCount ?? 10,
  };
}

// ── observationTokenSum ──

describe("observationTokenSum", () => {
  it("returns sum of all observation token counts", () => {
    const obs1 = makeObservation({ tokenCount: 100 });
    const obs2 = makeObservation({ tokenCount: 200 });
    assert.equal(observationTokenSum([obs1, obs2]), 300);
  });

  it("returns 0 for empty array", () => {
    assert.equal(observationTokenSum([]), 0);
  });
});

// ── observationPoolFullness ──

describe("observationPoolFullness", () => {
  it("returns ratio of observation tokens to target", () => {
    assert.equal(observationPoolFullness(5000, 2500), 2);
  });

  it("returns 0 when observation tokens are zero", () => {
    assert.equal(observationPoolFullness(0, 2500), 0);
  });

  it("returns 0 when target tokens are zero", () => {
    assert.equal(observationPoolFullness(5000, 0), 0);
  });

  it("returns 0 when values are NaN", () => {
    assert.equal(observationPoolFullness(NaN, 2500), 0);
    assert.equal(observationPoolFullness(5000, NaN), 0);
  });

  it("returns 0 when values are negative", () => {
    assert.equal(observationPoolFullness(-1000, 2500), 0);
    assert.equal(observationPoolFullness(5000, -2500), 0);
  });
});

// ── droppableObservationCount ──

describe("droppableObservationCount", () => {
  it("returns number of observations", () => {
    assert.equal(
      droppableObservationCount([makeObservation(), makeObservation()]),
      2,
    );
  });

  it("returns 0 for empty observations", () => {
    assert.equal(droppableObservationCount([]), 0);
  });
});

// ── maxDropCountForPool ──

describe("maxDropCountForPool", () => {
  it("returns 0 when no observations", () => {
    assert.equal(maxDropCountForPool([], 5000, 2500), 0);
  });

  it("returns 0 when observation tokens are at or below target", () => {
    const obs1 = makeObservation({ tokenCount: 100 });
    assert.equal(maxDropCountForPool([obs1], 100, 2500), 0);
  });

  it("returns estimated drops when pool is over target", () => {
    const obs1 = makeObservation({ tokenCount: 100 });
    const obs2 = makeObservation({ tokenCount: 100 });
    // 5000 tokens, 2500 target => 2500 over target, avg 2500 => ceil(2500/2500) = 1, capped at min 1
    assert.equal(maxDropCountForPool([obs1, obs2], 5000, 2500), 1);
  });

  it("caps drops at observation count", () => {
    const observations = Array.from({ length: 5 }, (_, i) =>
      makeObservation({ tokenCount: 100 }),
    );
    // 500 tokens, 2500 target => impossible, pool not over target
    assert.equal(maxDropCountForPool(observations, 500, 2500), 0);
  });

  it("returns at least 1 drop when over target with observations", () => {
    const obs1 = makeObservation({ tokenCount: 100 });
    // 2500 tokens, 2000 target => 500 over, ceil(500/100) = 5, capped at 1
    assert.equal(maxDropCountForPool([obs1], 2500, 2000), 1);
  });

  it("returns 0 when observation tokens are invalid", () => {
    const obs1 = makeObservation({ tokenCount: 100 });
    assert.equal(maxDropCountForPool([obs1], NaN, 2500), 0);
    assert.equal(maxDropCountForPool([obs1], 5000, NaN), 0);
  });
});

// ── observationPoolMetrics ──

describe("observationPoolMetrics", () => {
  it("returns correct metrics for observations over target", () => {
    const observations = [
      makeObservation({ tokenCount: 1000 }),
      makeObservation({ tokenCount: 2000 }),
    ];
    const metrics = observationPoolMetrics(observations, 2500);
    assert.equal(metrics.observationTokens, 3000);
    assert.equal(metrics.targetTokens, 2500);
    assert.equal(metrics.tokensOverTarget, 500);
    assert.equal(metrics.fullness, 1.2);
    assert.equal(metrics.activeObservationCount, 2);
    assert.equal(metrics.droppableCount, 2);
    assert.equal(metrics.overTarget, true);
    assert.ok(metrics.maxDropsAllowed >= 1);
    assert.equal(metrics.ready, true);
  });

  it("returns not ready when pool is under target", () => {
    const observations = [makeObservation({ tokenCount: 500 })];
    const metrics = observationPoolMetrics(observations, 2500);
    assert.equal(metrics.overTarget, false);
    assert.equal(metrics.tokensOverTarget, 0);
    assert.equal(metrics.maxDropsAllowed, 0);
    assert.equal(metrics.ready, false);
  });

  it("returns zero metrics for empty observations", () => {
    const metrics = observationPoolMetrics([], 2500);
    assert.equal(metrics.observationTokens, 0);
    assert.equal(metrics.activeObservationCount, 0);
    assert.equal(metrics.droppableCount, 0);
    assert.equal(metrics.ready, false);
  });
});
