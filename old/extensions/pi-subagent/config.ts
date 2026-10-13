/**
 * config.ts — Read/write subagent.json configuration.
 */

import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SubagentConfig {
  maxRetries: number;
  timeoutMs: number;
  permissionConfigPath: string;
  permissionExtensionPath: string;
  concurrencyLimit: number;
}

const CONFIG_FILENAME = "subagent.json";

function resolveTilde(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function tildePath(path: string): string {
  const home = homedir();
  if (path === home) return "~";
  if (path.startsWith(home + "/")) return `~${path.slice(home.length)}`;
  return path;
}

export function getDefaultConfig(): SubagentConfig {
  return {
    maxRetries: 2,
    timeoutMs: 900_000,
    permissionConfigPath: join(homedir(), ".pi", "agent", "permissions.json"),
    permissionExtensionPath: "",
    concurrencyLimit: 4,
  };
}

export function getConfigPath(): string {
  return join(homedir(), ".pi", "agent", CONFIG_FILENAME);
}

export function loadConfig(): SubagentConfig {
  const configPath = getConfigPath();

  if (!existsSync(configPath)) {
    return getDefaultConfig();
  }

  try {
    const raw = readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<SubagentConfig>;
    const defaults = getDefaultConfig();

    const maxRetries =
      typeof parsed.maxRetries === "number" ? parsed.maxRetries : defaults.maxRetries;
    const concurrencyLimit =
      typeof parsed.concurrencyLimit === "number"
        ? parsed.concurrencyLimit
        : defaults.concurrencyLimit;

    // Validate bounds
    return {
      maxRetries: Math.max(0, maxRetries),
      timeoutMs:
        typeof parsed.timeoutMs === "number" && parsed.timeoutMs > 0
          ? parsed.timeoutMs
          : defaults.timeoutMs,
      permissionConfigPath:
        typeof parsed.permissionConfigPath === "string"
          ? resolveTilde(parsed.permissionConfigPath)
          : defaults.permissionConfigPath,
      permissionExtensionPath:
        typeof parsed.permissionExtensionPath === "string"
          ? resolveTilde(parsed.permissionExtensionPath)
          : defaults.permissionExtensionPath,
      concurrencyLimit: Math.max(1, concurrencyLimit),
    };
  } catch {
    return getDefaultConfig();
  }
}

export async function saveConfig(config: SubagentConfig): Promise<void> {
  const configPath = getConfigPath();
  const serializable = {
    maxRetries: config.maxRetries,
    timeoutMs: config.timeoutMs,
    permissionConfigPath: tildePath(config.permissionConfigPath),
    permissionExtensionPath: tildePath(config.permissionExtensionPath),
    concurrencyLimit: config.concurrencyLimit,
  };
  await writeFile(configPath, `${JSON.stringify(serializable, null, 2)}\n`, "utf8");
}
