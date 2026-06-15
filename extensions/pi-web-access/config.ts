import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_PATH = join(homedir(), ".pi", "web-search.json");

export interface WebSearchConfig {
  exaApiKey?: string;
  githubClone?: {
    enabled?: boolean;
    maxRepoSizeMB?: number;
    cloneTimeoutSeconds?: number;
    clonePath?: string;
  };
}

const DEFAULT_CONFIG: WebSearchConfig = {
  githubClone: {
    enabled: true,
    maxRepoSizeMB: 350,
    cloneTimeoutSeconds: 30,
    clonePath: "/tmp/pi-github-repos",
  },
};

let cached: WebSearchConfig | null = null;

export function loadConfig(): WebSearchConfig {
  if (cached) return cached;

  if (!existsSync(CONFIG_PATH)) {
    cached = { ...DEFAULT_CONFIG };
    return cached;
  }

  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as Partial<WebSearchConfig>;
    cached = {
      ...DEFAULT_CONFIG,
      ...raw,
      githubClone: { ...DEFAULT_CONFIG.githubClone, ...raw.githubClone },
    };
    return cached;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[pi-web-access] Failed to parse ${CONFIG_PATH}: ${message}`);
    cached = { ...DEFAULT_CONFIG };
    return cached;
  }
}

export function getExaApiKey(): string | null {
  const envRaw = process.env.EXA_API_KEY;
  const env = envRaw != null ? String(envRaw).trim() : null;
  if (env && env.length > 0) return env;
  const cfgRaw = loadConfig().exaApiKey;
  const cfg = cfgRaw != null ? String(cfgRaw).trim() : null;
  return (cfg && cfg.length > 0) ? cfg : null;
}

export function getGitHubCloneConfig(): NonNullable<WebSearchConfig["githubClone"]> {
  const val = loadConfig().githubClone;
  return val != null ? val : DEFAULT_CONFIG.githubClone!;
}
