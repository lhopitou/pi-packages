/**
 * index.ts — Extension entry point.
 *
 * Discovers agent definitions, registers tools, and wires up the subagent system.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverAgents, type AgentDiscoveryResult } from "./agents.ts";
import { registerTools } from "./tool.ts";
import { loadConfig } from "./config.ts";
import { listViewerAgents, SubagentViewer, setActiveViewer } from "./viewer.ts";

// Mutable discovery result, refreshed on session_start and reload
let currentDiscovery: AgentDiscoveryResult = {
  agents: new Map(),
  globalDir: "",
  projectDir: null,
};

function getDiscovery(): AgentDiscoveryResult {
  return currentDiscovery;
}

export default function subagentExtension(pi: ExtensionAPI) {
  // Discover agents on session start
  pi.on("session_start", async (_event, ctx) => {
    currentDiscovery = discoverAgents(ctx.cwd);
    const agentCount = currentDiscovery.agents.size;
    if (agentCount > 0 && ctx.hasUI) {
      ctx.ui.notify(
        `Subagent: ${agentCount} agent${agentCount === 1 ? "" : "s"} loaded`,
        "info",
      );
    }
  });

  // Re-discover on resource reload
  pi.on("resources_discover", async (_event, ctx) => {
    currentDiscovery = discoverAgents(ctx.cwd);
  });

  // Register the subagent and list_subagents tools
  registerTools(pi, getDiscovery);

  // Register a /subagents command for manual inspection
  pi.registerCommand("subagents", {
    description: "List available subagent types and their configuration",
    handler: async (_args, ctx) => {
      const discovery = discoverAgents(ctx.cwd);
      const config = loadConfig();

      const agentList = [...discovery.agents.entries()]
        .map(([name, def]) => {
          const scope = def.scope === "project" ? " (project)" : "";
          const tools = def.tools.join(", ");
          const model = def.model ?? "parent";
          const writeFlag = ["edit", "write", "bash"].some((t) =>
            def.tools.includes(t),
          )
            ? " [write-capable]"
            : "";
          return `  ${name}${scope}: ${def.description}\n    tools: ${tools} | model: ${model}${writeFlag}`;
        })
        .join("\n");

      const info = [
        `Subagents: ${discovery.agents.size} defined`,
        "",
        agentList || "  No agents defined",
        "",
        `Config: timeout=${Math.round(config.timeoutMs / 60000)}m, maxRetries=${config.maxRetries}, concurrency=${config.concurrencyLimit}`,
        `Permission extension: ${config.permissionExtensionPath || "(none)"}`,
        "",
        `Global agents: ${discovery.globalDir}`,
        discovery.projectDir
          ? `Project agents: ${discovery.projectDir}`
          : "Project agents: (none)",
      ].join("\n");

      ctx.ui.notify(info, "info");
    },
  });

  // /subagent-view — Open an overlay to inspect a subagent's conversation
  pi.registerCommand("subagent-view", {
    description: "View a subagent's conversation in a scrollable overlay",
    handler: async (_args, ctx) => {
      const agents = listViewerAgents();
      if (agents.length === 0) {
        ctx.ui.notify("No subagent sessions to view. Run a subagent first.", "info");
        return;
      }

      // If only one agent, open it directly
      if (agents.length === 1) {
        await openViewer(ctx, agents[0].id);
        return;
      }

      // Multiple — let user pick by index (not indexOf, which breaks on duplicates)
      const options = agents.map(({ state }, idx) => {
        const icon = state.status === "running" ? "●" : state.status === "completed" ? "✓" : "✗";
        const duration = state.completedAt
          ? `${((state.completedAt - state.startedAt) / 1000).toFixed(1)}s`
          : "running";
        return `${idx + 1}. ${icon} ${state.agentName} — ${state.task.slice(0, 50)} · ${duration}`;
      });

      const choice = await ctx.ui.select("View subagent", options);
      if (!choice) return;

      // Parse the index from the choice string (format: "N. ...")
      const chosenIdx = parseInt(choice.split(".")[0], 10) - 1;
      if (chosenIdx >= 0 && chosenIdx < agents.length) {
        await openViewer(ctx, agents[chosenIdx].id);
      }
    },
  });

  async function openViewer(ctx: any, agentId: string) {
    setActiveViewer(undefined);
    await ctx.ui.custom<undefined>(
      (tui: any, theme: any, _keybindings: any, done: (result: undefined) => void) => {
        const v = new SubagentViewer(tui, agentId, theme, done);
        setActiveViewer(v);
        return v;
      },
      {
        overlay: true,
        overlayOptions: { anchor: "center", width: "90%" },
      },
    );
    setActiveViewer(undefined);
  }
}
