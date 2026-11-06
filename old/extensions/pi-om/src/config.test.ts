import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig, readEnvConfig, DEFAULTS } from "./config.ts";

// ── DEFAULTS ──

describe("DEFAULTS", () => {
  it("provides sensible default values", () => {
    assert.equal(DEFAULTS.observeAfterTokens, 10_000);
    assert.equal(DEFAULTS.reflectAfterTokens, 40_000);
    assert.equal(DEFAULTS.compactAfterTokens, 81_000);
    assert.equal(DEFAULTS.observationsPoolTargetTokens, 20_000);
    assert.equal(DEFAULTS.agentMaxTurns, 16);
    assert.equal(DEFAULTS.passive, false);
    assert.equal(DEFAULTS.debugLog, false);
    assert.equal(DEFAULTS.handoverSuggestTokens, 120_000);
  });
});

// ── readEnvConfig ──

describe("readEnvConfig", () => {
  it("returns empty config when PI_OM_PASSIVE is not set", () => {
    assert.deepEqual(readEnvConfig({}), {});
  });

  it("returns passive: true for truthy values", () => {
    assert.deepEqual(readEnvConfig({ PI_OM_PASSIVE: "1" }), { passive: true });
    assert.deepEqual(readEnvConfig({ PI_OM_PASSIVE: "TRUE" }), {
      passive: true,
    });
    assert.deepEqual(readEnvConfig({ PI_OM_PASSIVE: "yes" }), {
      passive: true,
    });
    assert.deepEqual(readEnvConfig({ PI_OM_PASSIVE: "on" }), { passive: true });
  });

  it("returns passive: false for falsy values", () => {
    assert.deepEqual(readEnvConfig({ PI_OM_PASSIVE: "0" }), { passive: false });
    assert.deepEqual(readEnvConfig({ PI_OM_PASSIVE: "false" }), {
      passive: false,
    });
    assert.deepEqual(readEnvConfig({ PI_OM_PASSIVE: "no" }), {
      passive: false,
    });
    assert.deepEqual(readEnvConfig({ PI_OM_PASSIVE: "off" }), {
      passive: false,
    });
  });

  it("returns empty config for unrecognized values", () => {
    assert.deepEqual(readEnvConfig({ PI_OM_PASSIVE: "maybe" }), {});
  });
});

// ── loadConfig ──

// Helper to create a temporary test directory with .pi/settings.json
function withTempDir(fn: (tmpDir: string) => Promise<void>): Promise<void> {
  const tmpDir = path.join(
    os.tmpdir(),
    `pi-om-test-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`,
  );
  fs.mkdirSync(tmpDir, { recursive: true });
  return fn(tmpDir).finally(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
}

function writeProjectSettings(
  tmpDir: string,
  settings: Record<string, unknown>,
): void {
  const piDir = path.join(tmpDir, ".pi");
  fs.mkdirSync(piDir, { recursive: true });
  fs.writeFileSync(path.join(piDir, "settings.json"), JSON.stringify(settings));
}

describe("loadConfig", () => {
  it("falls back to defaults when no settings files exist", async () => {
    await withTempDir(async (tmpDir) => {
      const config = await loadConfig(tmpDir);
      assert.equal(config.observeAfterTokens, DEFAULTS.observeAfterTokens);
      assert.equal(config.passive, false);
    });
  });

  it("merges project settings", async () => {
    await withTempDir(async (tmpDir) => {
      writeProjectSettings(tmpDir, { "pi-om": { observeAfterTokens: 5000 } });
      const config = await loadConfig(tmpDir);
      assert.equal(config.observeAfterTokens, 5000);
    });
  });

  it("env overrides settings files", async () => {
    await withTempDir(async (tmpDir) => {
      writeProjectSettings(tmpDir, { "pi-om": { passive: true } });
      const config = await loadConfig(tmpDir, { PI_OM_PASSIVE: "0" });
      assert.equal(config.passive, false);
    });
  });

  it("derives observationsPoolTargetTokens when not specified", async () => {
    await withTempDir(async (tmpDir) => {
      writeProjectSettings(tmpDir, { "pi-om": { reflectAfterTokens: 60_000 } });
      const config = await loadConfig(tmpDir);
      assert.equal(config.reflectAfterTokens, 60_000);
      assert.equal(config.observationsPoolTargetTokens, 30_000); // half of reflectAfterTokens
    });
  });

  it("uses explicit target when valid and less than reflectAfterTokens", async () => {
    await withTempDir(async (tmpDir) => {
      writeProjectSettings(tmpDir, {
        "pi-om": {
          reflectAfterTokens: 60_000,
          observationsPoolTargetTokens: 20_000,
        },
      });
      const config = await loadConfig(tmpDir);
      assert.equal(config.observationsPoolTargetTokens, 20_000);
    });
  });

  it("rejects target >= reflectAfterTokens and falls back to derived", async () => {
    await withTempDir(async (tmpDir) => {
      writeProjectSettings(tmpDir, {
        "pi-om": {
          reflectAfterTokens: 40_000,
          observationsPoolTargetTokens: 50_000,
        },
      });
      const config = await loadConfig(tmpDir);
      assert.equal(config.observationsPoolTargetTokens, 20_000); // derived: half of reflectAfterTokens
    });
  });

  it("rejects invalid numeric values (0, negative, non-integer)", async () => {
    await withTempDir(async (tmpDir) => {
      writeProjectSettings(tmpDir, {
        "pi-om": {
          observeAfterTokens: 0,
          reflectAfterTokens: -1,
          agentMaxTurns: 1.5,
        },
      });
      const config = await loadConfig(tmpDir);
      assert.equal(config.observeAfterTokens, DEFAULTS.observeAfterTokens);
      assert.equal(config.reflectAfterTokens, DEFAULTS.reflectAfterTokens);
      assert.equal(config.agentMaxTurns, DEFAULTS.agentMaxTurns);
    });
  });

  it("handles model config with thinking level", async () => {
    await withTempDir(async (tmpDir) => {
      writeProjectSettings(tmpDir, {
        "pi-om": {
          model: {
            provider: "anthropic",
            id: "claude-sonnet",
            thinking: "high",
          },
        },
      });
      const config = await loadConfig(tmpDir);
      assert.ok(config.model);
      assert.equal(config.model!.provider, "anthropic");
      assert.equal(config.model!.id, "claude-sonnet");
      assert.equal(config.model!.thinking, "high");
    });
  });

  it("rejects model config without provider or id", async () => {
    await withTempDir(async (tmpDir) => {
      writeProjectSettings(tmpDir, {
        "pi-om": {
          model: { thinking: "high" },
        },
      });
      const config = await loadConfig(tmpDir);
      assert.equal(config.model, undefined);
    });
  });

  it("rejects invalid thinking level", async () => {
    await withTempDir(async (tmpDir) => {
      writeProjectSettings(tmpDir, {
        "pi-om": {
          model: {
            provider: "anthropic",
            id: "claude-sonnet",
            thinking: "ultra",
          },
        },
      });
      const config = await loadConfig(tmpDir);
      assert.ok(config.model);
      assert.equal(config.model!.thinking, undefined); // invalid thinking is dropped
    });
  });

  it("handles malformed JSON in settings file gracefully", async () => {
    await withTempDir(async (tmpDir) => {
      const piDir = path.join(tmpDir, ".pi");
      fs.mkdirSync(piDir, { recursive: true });
      fs.writeFileSync(path.join(piDir, "settings.json"), "not json");
      const config = await loadConfig(tmpDir);
      assert.equal(config.observeAfterTokens, DEFAULTS.observeAfterTokens);
    });
  });

  it("handles settings file without pi-om key", async () => {
    await withTempDir(async (tmpDir) => {
      writeProjectSettings(tmpDir, { "other-extension": { foo: "bar" } });
      const config = await loadConfig(tmpDir);
      assert.equal(config.observeAfterTokens, DEFAULTS.observeAfterTokens);
    });
  });
});
