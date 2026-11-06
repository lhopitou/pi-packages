import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import type { Runtime } from "../runtime.ts";
import type { Config, ConfiguredModel } from "../config.ts";
import { DEFAULTS, THINKING_LEVEL_VALUES } from "../config.ts";

const SETTINGS_DIR = resolve(homedir(), ".pi/agent");
const SETTINGS_PATH = resolve(SETTINGS_DIR, "settings.json");
const NAMESPACE = "pi-om";

const NUMBER_KEYS = [
  "observeAfterTokens",
  "reflectAfterTokens",
  "compactAfterTokens",
  "observationsPoolTargetTokens",
  "agentMaxTurns",
  "handoverSuggestTokens",
] as const satisfies readonly (keyof Config & string)[];

const BOOLEAN_KEYS = [
  "passive",
  "debugLog",
] as const satisfies readonly (keyof Config & string)[];

const ALL_KEYS = [...NUMBER_KEYS, ...BOOLEAN_KEYS] as readonly string[];

const KEYS_HELP: Record<string, string> = {
  observeAfterTokens: "Tokens after which the observer runs (default: 10000)",
  reflectAfterTokens: "Tokens after which the reflector runs (default: 40000)",
  compactAfterTokens: "Tokens after which compaction triggers (default: 81000)",
  observationsPoolTargetTokens:
    "Target observation pool size in tokens (default: 20000)",
  agentMaxTurns: "Max turns per consolidation agent loop (default: 16)",
  handoverSuggestTokens:
    "Tokens after which handover suggestion appears (default: 120000)",
  passive:
    "Passive mode — consolidate but don't trigger compaction (default: false)",
  debugLog:
    "Write debug log to ~/.pi/agent/pi-om/debug.ndjson (default: false)",
};

function readSettingsJson(): Record<string, unknown> {
  if (!existsSync(SETTINGS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(SETTINGS_PATH, "utf-8")) as Record<
      string,
      unknown
    >;
  } catch {
    return {};
  }
}

function writeSettingsJson(data: Record<string, unknown>): void {
  writeFileSync(SETTINGS_PATH, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function getNamespace(data: Record<string, unknown>): Record<string, unknown> {
  const ns = data[NAMESPACE];
  return typeof ns === "object" && ns !== null
    ? (ns as Record<string, unknown>)
    : {};
}

function formatConfig(config: Config): string[] {
  const lines: string[] = [];
  for (const key of NUMBER_KEYS) {
    const value = config[key];
    const def = DEFAULTS[key];
    const isDefault = value === def;
    const marker = isDefault ? "" : " *";
    lines.push(`  ${key}: ${value}${marker}`);
  }
  for (const key of BOOLEAN_KEYS) {
    const value = config[key];
    const def = DEFAULTS[key];
    const isDefault = value === def;
    const marker = isDefault ? "" : " *";
    lines.push(`  ${key}: ${String(value)}${marker}`);
  }
  if (config.model) {
    const m = config.model;
    const thinking = m.thinking ? ` (thinking: ${m.thinking})` : "";
    lines.push(`  model: ${m.provider}/${m.id}${thinking} *`);
  }
  lines.push("");
  lines.push("* = non-default. Use /om:config set <key> <value> to change.");
  return lines;
}

function renderHelp(): string {
  const data = readSettingsJson();
  const ns = getNamespace(data);
  const lines: string[] = ["/om:config — view and set pi-om settings\n"];
  lines.push("Usage:");
  lines.push("  /om:config              Show all settings");
  lines.push("  /om:config set <key> <val>  Set a setting");
  lines.push("");
  lines.push("Numeric keys:");
  for (const key of NUMBER_KEYS) {
    const help = KEYS_HELP[key];
    const def = DEFAULTS[key];
    const curr = ns[key];
    lines.push(`  ${key} — ${help} (current: ${curr ?? def})`);
  }
  lines.push("");
  lines.push("Boolean keys:");
  for (const key of BOOLEAN_KEYS) {
    lines.push(`  ${key} — ${KEYS_HELP[key]}`);
  }
  lines.push("");
  lines.push("Model:");
  lines.push("  set model.provider <provider>  Set model provider");
  lines.push("  set model.id <id>              Set model ID");
  lines.push(
    "  set model.thinking <level>      Set thinking level (off/minimal/low/medium/high/xhigh)",
  );
  lines.push("  set model.clear                 Remove model override");
  return lines.join("\n");
}

function setNumericKey(key: string, valueStr: string): string | undefined {
  const value = Number(valueStr);
  if (!Number.isInteger(value) || value <= 0) {
    return `${key} must be a positive integer, got: ${valueStr}`;
  }
  const data = readSettingsJson();
  const ns = getNamespace(data);
  ns[key] = value;
  data[NAMESPACE] = ns;
  writeSettingsJson(data);
  return undefined;
}

function setBooleanKey(key: string, valueStr: string): string | undefined {
  const lower = valueStr.toLowerCase();
  let value: boolean;
  if (["true", "1", "yes", "on"].includes(lower)) {
    value = true;
  } else if (["false", "0", "no", "off"].includes(lower)) {
    value = false;
  } else {
    return `${key} must be true or false, got: ${valueStr}`;
  }
  const data = readSettingsJson();
  const ns = getNamespace(data);
  ns[key] = value;
  data[NAMESPACE] = ns;
  writeSettingsJson(data);
  return undefined;
}

function setModelField(field: string, valueStr: string): string | undefined {
  const data = readSettingsJson();
  const ns = getNamespace(data);
  const existing = (
    typeof ns["model"] === "object" && ns["model"] !== null
      ? (ns["model"] as Record<string, unknown>)
      : {}
  ) as Record<string, unknown>;

  if (field === "provider") {
    existing.provider = valueStr;
  } else if (field === "id") {
    existing.id = valueStr;
  } else if (field === "thinking") {
    if (!(THINKING_LEVEL_VALUES as readonly string[]).includes(valueStr)) {
      return `Invalid thinking level: ${valueStr}. Use: ${THINKING_LEVEL_VALUES.join(", ")}`;
    }
    existing.thinking = valueStr;
  }

  ns["model"] = existing;
  data[NAMESPACE] = ns;
  writeSettingsJson(data);
  return undefined;
}

function clearModel(): string | undefined {
  const data = readSettingsJson();
  const ns = getNamespace(data);
  delete (ns as any)["model"];
  if (Object.keys(ns).length === 0) {
    delete (data as any)[NAMESPACE];
  } else {
    (ns as any)["model"] = undefined; // ensures null -> removed on next load
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(ns)) {
      if (v !== undefined) {
        clean[k] = v;
      }
    }
    data[NAMESPACE] = clean;
  }
  writeSettingsJson(data);
  return undefined;
}

export function registerConfigCommand(
  runtime: Runtime,
): (args: string, ctx: ExtensionCommandContext) => Promise<void> {
  return async (args: string, ctx: ExtensionCommandContext) => {
    const parts = (args ?? "").trim().split(/\s+/);
    const subcommand = parts[0];

    if (!subcommand || subcommand === "help") {
      ctx.ui.notify(renderHelp(), "info");
      return;
    }

    if (subcommand === "view" || subcommand === "show") {
      await runtime.ensureConfig(ctx.cwd);
      const lines = ["pi-om settings:\n", ...formatConfig(runtime.config)];
      lines.push("\nApply changes with /reload or restart pi.");
      ctx.ui.notify(lines.join("\n"), "info");
      return;
    }

    if (subcommand === "set") {
      const key = parts[1];
      const valueStr = parts.slice(2).join(" ");

      if (!key || parts.length < 3) {
        ctx.ui.notify(
          "Usage: /om:config set <key> <value>\nRun /om:config help for available keys.",
          "warning",
        );
        return;
      }

      // Handle model sub-keys
      if (
        key === "model.provider" ||
        key === "model.id" ||
        key === "model.thinking"
      ) {
        const field = key.split(".")[1];
        const error = setModelField(field, valueStr);
        if (error) {
          ctx.ui.notify(error, "error");
          return;
        }
        ctx.ui.notify(
          `✅ Set model.${field} = ${valueStr}\nChanges take effect on next session (or /reload).`,
          "info",
        );
        return;
      }

      if (key === "model.clear") {
        const error = clearModel();
        if (error) {
          ctx.ui.notify(error, "error");
          return;
        }
        ctx.ui.notify(
          "✅ Removed model override\nChanges take effect on next session.",
          "info",
        );
        return;
      }

      if ((NUMBER_KEYS as readonly string[]).includes(key)) {
        const error = setNumericKey(key, valueStr);
        if (error) {
          ctx.ui.notify(error, "error");
          return;
        }
        ctx.ui.notify(
          `✅ Set ${key} = ${valueStr}\nChanges take effect on next session (or /reload).`,
          "info",
        );
        return;
      }

      if ((BOOLEAN_KEYS as readonly string[]).includes(key)) {
        const error = setBooleanKey(key, valueStr);
        if (error) {
          ctx.ui.notify(error, "error");
          return;
        }
        ctx.ui.notify(
          `✅ Set ${key} = ${valueStr}\nChanges take effect on next session (or /reload).`,
          "info",
        );
        return;
      }

      ctx.ui.notify(
        `Unknown key: ${key}\nRun /om:config help for available keys.`,
        "warning",
      );
      return;
    }

    ctx.ui.notify("Unknown subcommand. Use: view, set, or help.", "warning");
  };
}
