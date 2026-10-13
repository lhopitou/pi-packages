/**
 * agents.ts — Agent discovery from .md files with YAML frontmatter.
 *
 * Scans ~/.pi/agent/agents/ (global) and .pi/agents/ (project-local).
 * Project agents override global agents with the same name.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export interface AgentDefinition {
  name: string;
  description: string;
  tools: string[];
  model?: string;
  thinking?: string;
  delegateWhen?: string;
  extensions: string[];
  skills: string[];
  promptMode: "replace" | "append";
  inheritContext: boolean;
  systemPrompt: string;
  scope: "global" | "project";
  filePath: string;
}

function loadAgentsFromDir(
  dir: string,
  scope: "global" | "project",
): AgentDefinition[] {
  if (!existsSync(dir)) return [];

  const agents: AgentDefinition[] = [];
  const allTools = ["read", "bash", "edit", "write", "grep", "find", "ls"];

  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const filePath = join(dir, entry.name);
    let content: string;
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }

    let frontmatter: Record<string, unknown>;
    let body: string;
    try {
      const parsed = parseFrontmatter<Record<string, unknown>>(content);
      frontmatter = parsed.frontmatter;
      body = parsed.body;
    } catch (err) {
      console.warn(`[pi-subagent] Skipping ${filePath}: frontmatter parse error: ${err}`);
      continue;
    }

    if (!frontmatter.description || typeof frontmatter.description !== "string") {
      console.warn(`[pi-subagent] Skipping ${filePath}: missing or invalid "description" in frontmatter`);
      continue;
    }

    const name = entry.name.replace(/\.md$/, "");

    const tools = (() => {
      const raw = frontmatter.tools;
      if (typeof raw === "string") {
        return raw
          .split(",")
          .map((t: string) => t.trim())
          .filter((t: string) => t.length > 0);
      }
      return [...allTools];
    })();

    const extensions = (() => {
      const raw = frontmatter.extensions;
      if (Array.isArray(raw)) return raw.map(String);
      return [];
    })();

    const skills = (() => {
      const raw = frontmatter.skills;
      if (Array.isArray(raw)) return raw.map(String);
      return [];
    })();

    const promptMode = (() => {
      const raw = frontmatter.prompt_mode ?? frontmatter.promptMode;
      if (raw === "append") return "append" as const;
      return "replace" as const;
    })();

    agents.push({
      name,
      description: frontmatter.description,
      tools,
      model:
        typeof frontmatter.model === "string" ? frontmatter.model : undefined,
      thinking:
        typeof frontmatter.thinking === "string" ? frontmatter.thinking : undefined,
      delegateWhen:
        typeof frontmatter.delegate_when === "string"
          ? frontmatter.delegate_when
          : undefined,
      extensions,
      skills,
      promptMode,
      inheritContext:
        frontmatter.inherit_context === true ||
        frontmatter.inheritContext === true,
      systemPrompt: body.trim(),
      scope,
      filePath,
    });
  }

  return agents;
}

function findNearestProjectAgentsDir(cwd: string): string | null {
  let currentDir = cwd;
  for (;;) {
    const candidate = join(currentDir, ".pi", "agents");
    if (existsSync(candidate)) return candidate;
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

export interface AgentDiscoveryResult {
  agents: Map<string, AgentDefinition>;
  globalDir: string;
  projectDir: string | null;
}

export function discoverAgents(cwd: string): AgentDiscoveryResult {
  const globalDir = join(getAgentDir(), "agents");
  const projectDir = findNearestProjectAgentsDir(cwd);

  const agents = new Map<string, AgentDefinition>();

  // Global agents loaded first
  for (const agent of loadAgentsFromDir(globalDir, "global")) {
    agents.set(agent.name, agent);
  }

  // Project agents override globals with the same name
  if (projectDir) {
    for (const agent of loadAgentsFromDir(projectDir, "project")) {
      agents.set(agent.name, agent);
    }
  }

  return { agents, globalDir, projectDir };
}

/** Check if an agent has any write-capable tools. */
export function hasWriteTools(agent: AgentDefinition): boolean {
  const writeTools = new Set(["edit", "write", "bash"]);
  return agent.tools.some((t) => writeTools.has(t));
}

/** Build the one-line description for the subagent tool listing. */
export function buildAgentSummary(agents: Map<string, AgentDefinition>): string {
  if (agents.size === 0) return "No agents defined.";
  const entries = [...agents.entries()]
    .map(([name, def]) => `${name} (${def.description})`)
    .join(", ");
  return entries;
}

/** Build the full list_subagents output. */
export function buildAgentCatalog(agents: Map<string, AgentDefinition>): string {
  if (agents.size === 0) return "No agents defined.";

  const sections: string[] = [];
  for (const [name, def] of agents) {
    let section = `## ${name}\n`;
    section += `- Description: ${def.description}\n`;
    section += `- Scope: ${def.scope}\n`;
    section += `- Tools: ${def.tools.join(", ")}\n`;
    if (def.model) section += `- Model: ${def.model}\n`;
    if (def.thinking) section += `- Thinking: ${def.thinking}\n`;
    section += `- Prompt mode: ${def.promptMode}\n`;
    section += `- Inherit context: ${def.inheritContext}\n`;
    if (def.extensions.length > 0)
      section += `- Extensions: ${def.extensions.join(", ")}\n`;
    if (def.skills.length > 0)
      section += `- Skills: ${def.skills.join(", ")}\n`;
    if (def.delegateWhen) {
      section += `- Delegate when: ${def.delegateWhen.replace(/\n/g, " ").trim()}\n`;
    }
    sections.push(section);
  }

  return sections.join("\n");
}
