/**
 * agents.ts — Agent profile discovery, parsing, and caching.
 *
 * Scans ~/.pi/agent/agents/*.md (global) and .pi/agents/*.md (project)
 * for agent definition files with YAML frontmatter.
 *
 * Project agents override global agents with the same name.
 * Cache is rebuilt on session_start (same lifecycle as skills).
 */

import { readFileSync, existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { homedir } from "node:os";

// ── Types ──────────────────────────────────────────────────────────────────

export interface AgentDefinition {
  name: string;
  description: string;
  tools: string[] | null; // null = use default denylist
  model: string | null; // null = fall back to delegateModel → parent
  thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | null; // null = derived from effort
  body: string; // markdown after frontmatter
}

export interface AgentSummary {
  name: string;
  description: string;
  tools: string[] | null;
}

// ── YAML frontmatter parser ────────────────────────────────────────────────

function parseFrontmatter(
  raw: string,
  filename: string,
): { fields: Record<string, string>; body: string } | null {
  // Must start with --- on its own line
  if (!raw.startsWith("---\n") && !raw.startsWith("---\r\n")) return null;

  const endIndex = raw.indexOf("\n---\n");
  if (endIndex === -1) {
    const altEnd = raw.indexOf("\n---\r\n");
    if (altEnd === -1) return null;
  }

  const frontmatterEnd = endIndex !== -1 ? endIndex : raw.indexOf("\n---\r\n");
  const yamlBlock = raw.slice(4, frontmatterEnd); // strip leading "---\n"
  const body = raw.slice(frontmatterEnd + 5); // strip "\n---\n" (5 chars)

  const fields: Record<string, string> = {};
  let currentKey: string | null = null;
  let currentValue = "";

  for (const line of yamlBlock.split("\n")) {
    // New top-level key: value pair
    const kvMatch = line.match(/^(\w[\w_-]*)\s*:\s*(.*?)\s*$/);
    if (kvMatch) {
      // Flush previous key if any
      if (currentKey) {
        fields[currentKey] = currentValue.trimEnd();
      }
      currentKey = kvMatch[1];
      currentValue = kvMatch[2];
      continue;
    }

    // Multi-line continuation (indented line or `|` literal block)
    if (currentKey) {
      currentValue += "\n" + line;
      continue;
    }

    // Empty lines or comments — skip
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
  }

  // Flush last key
  if (currentKey) {
    fields[currentKey] = currentValue.trimEnd();
  }

  if (!fields.description) {
    console.warn(
      `[delegate] agent "${filename}" missing required "description" field — skipping`,
    );
    return null;
  }

  if (!body.trim()) {
    console.warn(
      `[delegate] agent "${filename}" has no body after frontmatter — skipping`,
    );
    return null;
  }

  return { fields, body: body.trim() };
}

function parseTools(raw: string | undefined): string[] | null {
  if (!raw || raw.trim() === "") return null;
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

const VALID_THINKING = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

function parseThinking(raw: string | undefined): AgentDefinition["thinking"] {
  if (!raw) return null;
  const cleaned = raw.trim().toLowerCase();
  return VALID_THINKING.has(cleaned)
    ? (cleaned as AgentDefinition["thinking"])
    : null;
}

function parseAgentFile(
  filePath: string,
  filename: string,
): AgentDefinition | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

  const parsed = parseFrontmatter(raw, filename);
  if (!parsed) return null;

  const name = basename(filename, ".md");
  const { fields, body } = parsed;

  return {
    name,
    description: fields.description,
    tools: parseTools(fields.tools),
    model: fields.model?.trim() || null,
    thinking: parseThinking(fields.thinking),
    body,
  };
}

// ── Discovery ──────────────────────────────────────────────────────────────

async function scanDir(dir: string): Promise<AgentDefinition[]> {
  if (!existsSync(dir)) return [];

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const agents: AgentDefinition[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const def = parseAgentFile(join(dir, entry), entry);
    if (def) agents.push(def);
  }
  return agents;
}

// ── Cache ───────────────────────────────────────────────────────────────────

let agentCache: Map<string, AgentDefinition> | null = null;

/**
 * Rebuild the agent cache from disk.
 * Project agents (.pi/agents/) override global agents (~/.pi/agent/agents/).
 */
export async function discoverAgents(cwd: string): Promise<void> {
  const globalDir = join(homedir(), ".pi", "agent", "agents");
  const projectDir = join(cwd, ".pi", "agents");

  const [globalAgents, projectAgents] = await Promise.all([
    scanDir(globalDir),
    scanDir(projectDir),
  ]);

  const map = new Map<string, AgentDefinition>();
  for (const agent of globalAgents) {
    map.set(agent.name, agent);
  }
  // Project agents override global
  for (const agent of projectAgents) {
    map.set(agent.name, agent);
  }

  agentCache = map;
}

/**
 * Reset the cache (used on session_end or during teardown).
 */
export function clearAgents(): void {
  agentCache = null;
}

/**
 * Get a single agent definition by name.
 */
export function getAgent(name: string): AgentDefinition | undefined {
  return agentCache?.get(name);
}

/**
 * List all agent summaries for system prompt injection.
 */
export function listAgentSummaries(): AgentSummary[] {
  if (!agentCache) return [];
  const summaries: AgentSummary[] = [];
  for (const agent of agentCache.values()) {
    summaries.push({
      name: agent.name,
      description: agent.description,
      tools: agent.tools,
    });
  }
  return summaries;
}
