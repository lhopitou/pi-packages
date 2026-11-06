import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Runtime } from "./runtime.ts";
import { DEFAULTS } from "./config.ts";
import type { Config } from "./config.ts";

// ── Runtime state ──

describe("Runtime — state", () => {
  it("initializes with default config", () => {
    const runtime = new Runtime();
    assert.deepEqual(runtime.config, DEFAULTS);
    assert.equal(runtime.configLoaded, false);
    assert.equal(runtime.consolidationInFlight, false);
    assert.equal(runtime.compactInFlight, false);
    assert.equal(runtime.compactHookInFlight, false);
    assert.equal(runtime.handoverSuggested, false);
  });

  it("ensureConfig loads config and sets configLoaded", async () => {
    const runtime = new Runtime();
    await runtime.ensureConfig("/tmp");
    assert.equal(runtime.configLoaded, true);
    assert.ok(runtime.config.observeAfterTokens > 0);
  });

  it("ensureConfig only loads once", async () => {
    const runtime = new Runtime();
    await runtime.ensureConfig("/tmp");
    const firstConfig = runtime.config;
    await runtime.ensureConfig("/tmp");
    assert.deepEqual(runtime.config, firstConfig);
  });
});

// ── Runtime — resolveModel ──

describe("Runtime — resolveModel", () => {
  it("returns ok with model and apiKey when model is available", async () => {
    const runtime = new Runtime();
    await runtime.ensureConfig("/tmp");
    const mockModel = { provider: "test", id: "test-model" };
    const result = await runtime.resolveModel({
      model: mockModel,
      modelRegistry: {
        find: () => mockModel,
        getApiKeyAndHeaders: async () => ({
          ok: true,
          apiKey: "test-key",
          headers: {},
        }),
      },
      hasUI: false,
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.apiKey, "test-key");
    }
  });

  it("returns failure when no model is available", async () => {
    const runtime = new Runtime();
    await runtime.ensureConfig("/tmp");
    const result = await runtime.resolveModel({
      model: null,
      modelRegistry: {
        find: () => null,
        getApiKeyAndHeaders: async () => ({ ok: false }),
      },
      hasUI: false,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.reason.includes("no model"));
    }
  });

  it("uses configured model when available", async () => {
    const runtime = new Runtime();
    await runtime.ensureConfig("/tmp");
    runtime.config.model = { provider: "custom", id: "custom-model" };
    const customModel = { provider: "custom", id: "custom-model" };
    const result = await runtime.resolveModel({
      model: { provider: "default", id: "default-model" },
      modelRegistry: {
        find: (_provider: string, _id: string) => customModel,
        getApiKeyAndHeaders: async () => ({
          ok: true,
          apiKey: "custom-key",
          headers: {},
        }),
      },
      hasUI: false,
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.apiKey, "custom-key");
    }
  });

  it("falls back to session model when configured model is not found", async () => {
    const runtime = new Runtime();
    await runtime.ensureConfig("/tmp");
    runtime.config.model = { provider: "custom", id: "custom-model" };
    const sessionModel = { provider: "default", id: "default-model" };
    const notifyCalls: string[] = [];
    const result = await runtime.resolveModel({
      model: sessionModel,
      modelRegistry: {
        find: () => null, // configured model not found
        getApiKeyAndHeaders: async () => ({
          ok: true,
          apiKey: "session-key",
          headers: {},
        }),
      },
      hasUI: true,
      ui: {
        notify: (msg: string) => {
          notifyCalls.push(msg);
        },
      },
    });
    assert.equal(result.ok, true);
    assert.ok(notifyCalls.length > 0);
    assert.ok(notifyCalls[0].includes("not found"));
  });

  it("returns failure when API key is not available", async () => {
    const runtime = new Runtime();
    await runtime.ensureConfig("/tmp");
    const result = await runtime.resolveModel({
      model: { provider: "test" },
      modelRegistry: {
        find: () => null,
        getApiKeyAndHeaders: async () => ({ ok: false }),
      },
      hasUI: false,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.reason.includes("no API key"));
    }
  });
});

// ── Runtime — recordConsolidationStageError ──

describe("Runtime — recordConsolidationStageError", () => {
  it("records error message for observer phase", () => {
    const runtime = new Runtime();
    const notifyCalls: string[] = [];
    runtime.recordConsolidationStageError(
      {
        hasUI: true,
        ui: {
          notify: (msg: string) => {
            notifyCalls.push(msg);
          },
        },
      },
      "observer",
      new Error("test observer error"),
    );
    assert.equal(runtime.lastObserverError, "test observer error");
    assert.ok(notifyCalls.length > 0);
  });

  it("records error message for reflector phase", () => {
    const runtime = new Runtime();
    runtime.recordConsolidationStageError(
      { hasUI: false },
      "reflector",
      "string error",
    );
    assert.equal(runtime.lastReflectorError, "string error");
  });

  it("records error message for dropper phase", () => {
    const runtime = new Runtime();
    runtime.recordConsolidationStageError(
      { hasUI: false },
      "dropper",
      new Error("dropper fail"),
    );
    assert.equal(runtime.lastDropperError, "dropper fail");
  });
});
