/**
 * index.ts — Extension entry point.
 *
 * Discovers agent definitions, registers tools, and wires up the subagent system.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { discoverAgents, type AgentDiscoveryResult } from "./agents.ts";
import { registerTools } from "./tool.ts";
import { loadConfig } from "./config.ts";
import { listViewerAgents, SubagentViewer, setActiveViewer } from "./viewer.ts";
import {
	getAggregatedStats,
	formatAggregatedStats,
	clearStats,
} from "./stats.ts";
import { activeJobCount, listJobs as listBgJobs, recoverJobs, setUiContext, setOnChange, getJob } from "./async-tracker.ts";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { renderBackgroundWidget } from "./widget.ts";

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
  let lastCtx: ExtensionContext | null = null;
  let bgJobsNotifyCount = 0;
  const notifiedBgJobs = new Set<string>();

  // ── Send a compact completion card into the session ────────────────
  function injectCompletionCard(jobId: string): void {
    const job = getJob(jobId);
    if (!job) return;

    const resultPath = join(job.asyncDir, "result.json");
    if (!existsSync(resultPath)) return;

    let preview = "";
    let metadataStr = "";
    try {
      const raw = readFileSync(resultPath, "utf8");
      const result = JSON.parse(raw) as {
        text: string; turns: number; toolCalls: number;
        input: number; output: number; totalTokens: number;
        cost: number; durationMs: number;
        success: boolean; error?: string;
      };
      const fmt = (n: number) => n < 1000 ? String(n) : n < 10000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`;
      metadataStr = `${result.turns} turns, ${result.toolCalls} tools, ↑${fmt(result.input)} ↓${fmt(result.output)}, $${result.cost.toFixed(4)}`;
      const firstLine = result.text.split("\n")[0].slice(0, 120);
      preview = firstLine;
    } catch {
      // result.json unreadable — send minimal card
    }

    const card = [
      `[Background subagent "${job.agent}" completed — ${metadataStr}]`,
      preview ? `Preview: ${preview}` : "",
      `Use subagent({action:'collect', job_id:'${jobId}'}) for full output.`,
      `Session: ${job.sessionFile}`,
    ].filter(Boolean).join("\n");

    pi.sendUserMessage(card, { deliverAs: "followUp" });
  }

  // Discover agents on session start and set up background agent tracking
  pi.on("session_start", async (_event, ctx) => {
    currentDiscovery = discoverAgents(ctx.cwd);
    lastCtx = ctx;
    notifiedBgJobs.clear();

    const agentCount = currentDiscovery.agents.size;
    if (agentCount > 0 && ctx.hasUI) {
      ctx.ui.notify(
        `Subagent: ${agentCount} agent${agentCount === 1 ? "" : "s"} loaded`,
        "info",
      );
    }

    setUiContext(ctx);
    recoverJobs();
    bgJobsNotifyCount = activeJobCount();

    setOnChange(() => {
      if (ctx.hasUI) renderBackgroundWidget(ctx.ui);

      const newActive = activeJobCount();
      if (newActive < bgJobsNotifyCount) {
        const completed = bgJobsNotifyCount - newActive;
        ctx.ui.notify(
          `${completed} background subagent${completed > 1 ? "s" : ""} completed.`,
          "info",
        );

        // Auto-inject completion cards for newly finished jobs
        const allJobs = listBgJobs();
        for (const job of allJobs) {
          if (
            (job.status === "complete" || job.status === "failed") &&
            !notifiedBgJobs.has(job.id)
          ) {
            notifiedBgJobs.add(job.id);
            injectCompletionCard(job.id);
          }
        }
      }
      bgJobsNotifyCount = newActive;
    });

    if (ctx.hasUI) renderBackgroundWidget(ctx.ui);
  });

  // Re-discover on resource reload
  pi.on("resources_discover", async (_event, ctx) => {
    currentDiscovery = discoverAgents(ctx.cwd);
    lastCtx = ctx;
    setUiContext(ctx);
    recoverJobs();
    if (ctx.hasUI) renderBackgroundWidget(ctx.ui);
  });

  // Inject background job reminder on compaction
  pi.on("session_before_compact", (event) => {
    const active = activeJobCount();
    if (active > 0) {
      const jobs = listBgJobs().filter((j) => j.status === "running" || j.status === "queued");
      const jobList = jobs.map((j) => `  - ${j.agent} (${j.id.slice(0, 8)}): ${j.status}, ${j.turnCount} turns`).join("\n");
      const reminder = `\n\n**Reminder: ${active} background subagent${active > 1 ? "s are" : " is"} still running:**\n${jobList}\nUse subagent({action:'status'}) to check progress. Use subagent({action:'collect',job_id:'...'}) when complete.`;
      event.customInstructions = (event.customInstructions ?? "") + reminder;
    }
  });

  // Cleanup on shutdown
  pi.on("session_shutdown", () => {
    if (lastCtx?.hasUI) {
      lastCtx.ui.setWidget("bg-jobs", undefined);
    }
    setUiContext(null);
    setOnChange(null);
    notifiedBgJobs.clear();
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

  // /subagent-stats — View per-agent aggregated usage statistics
  pi.registerCommand("subagent-stats", {
    description: "View per-agent usage statistics (tokens, cost, duration). Use 'clear' to reset.",
    handler: async (args, ctx) => {
      if (args.trim() === "clear") {
        clearStats();
        ctx.ui.setStatus("subagent", undefined);
        ctx.ui.notify("Subagent stats cleared.", "info");
        return;
      }
      const stats = getAggregatedStats();
      const output = formatAggregatedStats(stats);
      ctx.ui.notify(output, "info");
    },
  });

  // Update footer status with subagent aggregate on each tool_result
  pi.on("tool_result", (event, ctx) => {
    if (event.toolName !== "subagent") return;
    if (!ctx.hasUI) return;

    // Stats are recorded from within tool.ts; here we just update the footer
    const stats = getAggregatedStats();
    const agents = Object.keys(stats);
    if (agents.length === 0) return;

    const totalRuns = Object.values(stats).reduce((sum, s) => sum + s.runs, 0);
    const totalCost = Object.values(stats).reduce((sum, s) => sum + s.totalCost, 0);
    const totalInput = Object.values(stats).reduce((sum, s) => sum + s.totalInput, 0);
    const totalOutput = Object.values(stats).reduce((sum, s) => sum + s.totalOutput, 0);

    const fmt = (n: number) =>
      n < 1000 ? String(n) : n < 10000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`;

    ctx.ui.setStatus(
      "subagent",
      `${totalRuns} run${totalRuns !== 1 ? "s" : ""} · ↑${fmt(totalInput)} ↓${fmt(totalOutput)} $${totalCost.toFixed(3)}`,
    );
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
