/**
 * tool.ts — Register the `subagent` and `list_subagents` tools with
 * collapsed/expanded rendering. Full conversation details live in the
 * /subagent-view overlay; the main view shows status + report only.
 */

import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, keyHint } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type { AgentDefinition, AgentDiscoveryResult } from "./agents.ts";
import { hasWriteTools, buildAgentSummary, buildAgentCatalog } from "./agents.ts";
import type { SubagentConfig } from "./config.ts";
import { loadConfig } from "./config.ts";
import { runSubagent, spawnBackgroundAgent, formatMetadataCompact, formatMetadataDetailed, extractAssistantText } from "./runner.ts";
import { recordAgentRun } from "./stats.ts";
import type { SubagentResult, SubagentMetadata, SubagentEvent } from "./runner.ts";
import { SubagentMonitor, statusIcon, statusLabel, type MonitorStatus } from "./monitor.ts";
import { registerViewerAgent, updateViewerAgent, removeViewerAgent, cleanupViewerRegistry, type ViewerAgentState } from "./viewer.ts";
import { getJob, listJobs as listBgJobs, cancelJob, activeJobCount } from "./async-tracker.ts";

// ── Concurrency tracking ─────────────────────────────────────────────

let activeCount = 0;
const BG_CONCURRENCY_LIMIT = 4;

// ── Schema ──────────────────────────────────────────────────────────

const SubagentAction = Type.Union([
  Type.Literal("run"),
  Type.Literal("run_bg"),
  Type.Literal("status"),
  Type.Literal("collect"),
  Type.Literal("cancel"),
]);

const SubagentParams = Type.Object({
  action: Type.Optional(SubagentAction),
  agent: Type.Optional(Type.String({
    description: "Agent type name. Required for 'run' and 'run_bg' actions.",
  })),
  task: Type.Optional(Type.String({
    description: "Self-contained task. Required for 'run' and 'run_bg' actions.",
  })),
  inherit_context: Type.Optional(
    Type.Boolean({
      description:
        "Fork parent conversation into the subagent. Only for 'run' and 'run_bg'. Overrides the agent's default.",
      default: false,
    }),
  ),
  job_id: Type.Optional(Type.String({
    description: "Job ID. Required for 'collect' and 'cancel' actions.",
  })),
});

const ListSubagentsParams = Type.Object({});

// ── Details type ─────────────────────────────────────────────────────

export interface SubagentToolDetails {
  action?: string;
  agentName: string;
  agentScope: "global" | "project";
  assignedTask: string;
  inheritContext: boolean;
  success: boolean;
  aborted: boolean;
  timedOut: boolean;
  error?: string;
  metadata: SubagentMetadata;
  retryHint?: string;
  conversationEntries: { role: string; text: string; toolName?: string; isError?: boolean }[];
  monitorStatus: MonitorStatus;
  permissionDeniedCount: number;
  lastAssistantText?: string;
  bgJobId?: string;
  bgJobPid?: number;
  bgJobs?: Array<{
    id: string;
    agent: string;
    status: string;
    elapsed: number;
    turns: number;
    toolCount: number;
    currentPath?: string;
  }>;
  sessionFile?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────

const EMPTY_METADATA: SubagentMetadata = {
  turns: 0, toolCalls: 0, failedToolCalls: 0,
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
  totalTokens: 0, cost: 0, durationMs: 0,
};

// ── Tool registration ───────────────────────────────────────────────

export function registerTools(
  pi: ExtensionAPI,
  getDiscovery: () => AgentDiscoveryResult,
  parentConversationProvider?: (ctx: ExtensionContext) => string,
): void {
  const discovery = getDiscovery();
  const agentList = buildAgentSummary(discovery.agents);

  // ── subagent tool ────────────────────────────────────────────────

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: [
      "Delegate a task to a specialized subagent with isolated context.",
      "Actions: 'run' (foreground, default), 'run_bg' (background detached), 'status' (list bg jobs), 'collect' (get bg result), 'cancel' (kill bg job).",
      `Available agents: ${agentList}`,
      "Use list_subagents() for full delegation rules and agent details.",
    ].join(" "),
    promptSnippet:
      "Delegate to specialized subagents for isolated tasks. Actions: run, run_bg (background), status, collect, cancel. Call list_subagents() for delegation rules.",
    promptGuidelines: [
      "Prefer subagent over direct tool calls for any task that involves reading, scanning, mapping, exploring files, web-searching or context-heavy tasks. The goal is context hygiene: keep the parent session clean by offloading file reads to an isolated agent.",
      "Use subagent explore for: tasks that would require reading many files or scanning large directories — enough reads to clutter the parent context. Do not delegate explore for small tasks like reading 2-3 files; handle those directly.",
      "Use subagent reviewer for: code review, second opinion, audit, or independent verification. Must use reviewer when the user explicitly asks for review.",
      "Use subagent planner for: architecture design, migration planning, or working through ambiguous requirements before implementation. Must use planner when the user asks for a plan or approach.",
      "Use subagent web-searcher for: searches the web, fetches page content, finds code examples, and synthesizes information from multiple sources.",
      "Do not use subagent for trivial answers answerable without reading files (e.g., 'what is the package name in package.json' — just read it), obvious typo fixes, or tasks requiring ongoing conversation context that the subagent won't have.",
      "Write-capable subagent delegation is exceptional — the parent owns implementation and final validation by default.",
      "When delegating, provide a self-contained task with objective, relevant context, constraints, and expected output format. Call list_subagents() for full agent details.",
      "Use action: 'run_bg' for long-running tasks to avoid blocking — the agent returns a jobId immediately. Check status with subagent({action:'status'}) and collect results with subagent({action:'collect',job_id:'...'}). Cancel with subagent({action:'cancel',job_id:'...'}).",
    ],
    parameters: SubagentParams,
    executionMode: "parallel",

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const action = params.action ?? "run";
      const discovery = getDiscovery();
      const config = loadConfig();

      // ── action: status ──────────────────────────────────────────
      if (action === "status") {
        const jobId = params.job_id;
        const rawJobs = jobId ? [getJob(jobId)].filter(Boolean) : listBgJobs();
        const bgJobs = rawJobs.map((j) => ({
          id: j!.id,
          agent: j!.agent,
          status: j!.status,
          elapsed: Date.now() - j!.startedAt,
          turns: j!.turnCount,
          toolCount: j!.toolCount,
          currentPath: j!.currentPath,
        }));
        const formatted = bgJobs.length === 0
          ? "No background subagents."
          : bgJobs.map((j) => {
            const icon = j.status === "running" ? "◉" : j.status === "complete" ? "✓" : j.status === "failed" ? "✗" : "○";
            const elapsed = j.elapsed < 60_000 ? `${Math.round(j.elapsed / 1000)}s` : `${Math.floor(j.elapsed / 60_000)}m`;
            return `${icon} ${j.agent} (${j.id.slice(0, 8)}) · ${j.status} · ${elapsed} · ${j.turns}t ${j.toolCount} tools${j.currentPath ? ` · ${j.currentPath}` : ""}`;
          }).join("\n");
        return {
          content: [{ type: "text", text: formatted }],
          details: {
            action,
            agentName: "",
            agentScope: "global",
            assignedTask: "",
            inheritContext: false,
            success: true,
            aborted: false,
            timedOut: false,
            metadata: { ...EMPTY_METADATA },
            conversationEntries: [],
            monitorStatus: "completed",
            permissionDeniedCount: 0,
            bgJobs,
          } satisfies SubagentToolDetails,
        };
      }

      // ── action: collect ─────────────────────────────────────────
      if (action === "collect") {
        const jobId = params.job_id;
        if (!jobId) {
          return {
            content: [{ type: "text", text: "Missing job_id for collect. Use subagent({action:'status'}) to see active jobs." }],
            details: { action, agentName: "", agentScope: "global", assignedTask: "", inheritContext: false, success: false, aborted: false, timedOut: false, error: "Missing job_id", metadata: { ...EMPTY_METADATA }, conversationEntries: [], monitorStatus: "error", permissionDeniedCount: 0 } satisfies SubagentToolDetails,
          };
        }
        const job = getJob(jobId);
        if (!job) {
          return {
            content: [{ type: "text", text: `Job "${jobId}" not found. It may have been cleaned up. Use subagent({action:'status'}) to see active jobs.` }],
            details: { action, agentName: "", agentScope: "global", assignedTask: "", inheritContext: false, success: false, aborted: false, timedOut: false, error: `Job ${jobId} not found`, metadata: { ...EMPTY_METADATA }, conversationEntries: [], monitorStatus: "error", permissionDeniedCount: 0 } satisfies SubagentToolDetails,
          };
        }
        if (job.status === "running" || job.status === "queued") {
          return {
            content: [{ type: "text", text: `Job "${jobId}" (${job.agent}) is still ${job.status}. Wait for completion, then collect.` }],
            details: { action, agentName: job.agent, agentScope: "global", assignedTask: job.task, inheritContext: false, success: false, aborted: false, timedOut: false, error: `Job still ${job.status}`, metadata: { ...EMPTY_METADATA }, conversationEntries: [], monitorStatus: "running", permissionDeniedCount: 0 } satisfies SubagentToolDetails,
          };
        }
        // Read result.json
        const resultPath = join(job.asyncDir, "result.json");
        if (!existsSync(resultPath)) {
          return {
            content: [{ type: "text", text: `No result file for job "${jobId}". The subagent may have crashed before writing results.` }],
            details: { action, agentName: job.agent, agentScope: "global", assignedTask: job.task, inheritContext: false, success: false, aborted: false, timedOut: false, error: "result.json not found", metadata: { ...EMPTY_METADATA }, conversationEntries: [], monitorStatus: "error", permissionDeniedCount: 0 } satisfies SubagentToolDetails,
          };
        }
        try {
          const raw = readFileSync(resultPath, "utf8");
          const result = JSON.parse(raw) as { text: string; turns: number; toolCalls: number; input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: number; durationMs: number; sessionFile: string; success: boolean; error?: string };
          const metadata: SubagentMetadata = {
            turns: result.turns,
            toolCalls: result.toolCalls,
            failedToolCalls: 0,
            input: result.input,
            output: result.output,
            cacheRead: result.cacheRead,
            cacheWrite: result.cacheWrite,
            totalTokens: result.totalTokens,
            cost: result.cost,
            durationMs: result.durationMs,
          };
          return {
            content: [{ type: "text", text: result.text || "(no output)" }],
            details: {
              action,
              agentName: job.agent,
              agentScope: "global",
              assignedTask: job.task,
              inheritContext: false,
              success: result.success,
              aborted: false,
              timedOut: false,
              error: result.error,
              metadata,
              conversationEntries: [],
              monitorStatus: result.success ? "completed" : "error",
              permissionDeniedCount: 0,
              sessionFile: result.sessionFile,
            } satisfies SubagentToolDetails,
          };
        } catch (e) {
          return {
            content: [{ type: "text", text: `Failed to read result for job "${jobId}": ${(e as Error).message}` }],
            details: { action, agentName: job.agent, agentScope: "global", assignedTask: job.task, inheritContext: false, success: false, aborted: false, timedOut: false, error: (e as Error).message, metadata: { ...EMPTY_METADATA }, conversationEntries: [], monitorStatus: "error", permissionDeniedCount: 0 } satisfies SubagentToolDetails,
          };
        }
      }

      // ── action: cancel ──────────────────────────────────────────
      if (action === "cancel") {
        const jobId = params.job_id;
        if (!jobId) {
          return {
            content: [{ type: "text", text: "Missing job_id for cancel. Use subagent({action:'status'}) to see active jobs." }],
            details: { action, agentName: "", agentScope: "global", assignedTask: "", inheritContext: false, success: false, aborted: false, timedOut: false, error: "Missing job_id", metadata: { ...EMPTY_METADATA }, conversationEntries: [], monitorStatus: "error", permissionDeniedCount: 0 } satisfies SubagentToolDetails,
          };
        }
        const job = getJob(jobId);
        if (!job) {
          return {
            content: [{ type: "text", text: `Job "${jobId}" not found.` }],
            details: { action, agentName: "", agentScope: "global", assignedTask: "", inheritContext: false, success: false, aborted: false, timedOut: false, error: `Job ${jobId} not found`, metadata: { ...EMPTY_METADATA }, conversationEntries: [], monitorStatus: "error", permissionDeniedCount: 0 } satisfies SubagentToolDetails,
          };
        }
        if (job.status !== "running" && job.status !== "queued") {
          return {
            content: [{ type: "text", text: `Job "${jobId}" is ${job.status}. Only queued/running jobs can be cancelled.` }],
            details: { action, agentName: job.agent, agentScope: "global", assignedTask: job.task, inheritContext: false, success: false, aborted: false, timedOut: false, error: `Job not cancellable (${job.status})`, metadata: { ...EMPTY_METADATA }, conversationEntries: [], monitorStatus: "error", permissionDeniedCount: 0 } satisfies SubagentToolDetails,
          };
        }
        // SIGTERM, then SIGKILL after 5s
        if (job.pid) {
          try { process.kill(job.pid, "SIGTERM"); } catch {}
          setTimeout(() => {
            try { process.kill(job.pid as number, "SIGKILL"); } catch {}
          }, 5000).unref();
        }
        cancelJob(jobId);
        return {
          content: [{ type: "text", text: `Cancelled agent "${job.agent}" (id: ${jobId.slice(0, 8)}).` }],
          details: { action, agentName: job.agent, agentScope: "global", assignedTask: job.task, inheritContext: false, success: true, aborted: true, timedOut: false, metadata: { ...EMPTY_METADATA }, conversationEntries: [], monitorStatus: "aborted", permissionDeniedCount: 0 } satisfies SubagentToolDetails,
        };
      }

      // ── action: run (foreground) ────────────────────────────────
      const agentName = params.agent;
      const task = params.task;

      if (!agentName) {
        const available = [...discovery.agents.keys()].join(", ") || "none";
        return {
          content: [{ type: "text", text: `Missing agent. Available agents: ${available}.` }],
          details: { action, agentName: "", agentScope: "global", assignedTask: task ?? "", inheritContext: false, success: false, aborted: false, timedOut: false, error: "Missing agent", metadata: { ...EMPTY_METADATA }, conversationEntries: [], monitorStatus: "error", permissionDeniedCount: 0 } satisfies SubagentToolDetails,
        };
      }
      if (!task) {
        return {
          content: [{ type: "text", text: "Missing task." }],
          details: { action, agentName, agentScope: "global", assignedTask: "", inheritContext: false, success: false, aborted: false, timedOut: false, error: "Missing task", metadata: { ...EMPTY_METADATA }, conversationEntries: [], monitorStatus: "error", permissionDeniedCount: 0 } satisfies SubagentToolDetails,
        };
      }

      const agentDef = discovery.agents.get(agentName);

      // Unknown agent type — soft error
      if (!agentDef) {
        const available = [...discovery.agents.keys()].join(", ") || "none";
        return {
          content: [{ type: "text", text: `Agent "${agentName}" not found. Available agents: ${available}.` }],
          details: { action, agentName, agentScope: "global", assignedTask: task, inheritContext: params.inherit_context ?? false, success: false, aborted: false, timedOut: false, error: `Agent "${agentName}" not found. Available: ${available}`, metadata: { ...EMPTY_METADATA }, conversationEntries: [], monitorStatus: "error", permissionDeniedCount: 0 } satisfies SubagentToolDetails,
        };
      }

      // Warning for write-capable agents (foreground only)
      if (action !== "run_bg" && hasWriteTools(agentDef) && ctx.hasUI) {
        const ok = await ctx.ui.confirm(
          "Write-capable subagent",
          `Agent "${agentDef.name}" can modify files. Continue?`,
        );
        if (!ok) {
          return {
            content: [{ type: "text", text: `Subagent "${agentDef.name}" invocation cancelled by user.` }],
            details: { action, agentName: agentDef.name, agentScope: agentDef.scope, assignedTask: task, inheritContext: params.inherit_context ?? agentDef.inheritContext, success: false, aborted: true, timedOut: false, error: "User cancelled write-capable agent", metadata: { ...EMPTY_METADATA }, conversationEntries: [], monitorStatus: "aborted", permissionDeniedCount: 0 } satisfies SubagentToolDetails,
          };
        }
      }

      // ── action: run_bg (background) ─────────────────────────────
      if (action === "run_bg") {
        if (activeJobCount() >= BG_CONCURRENCY_LIMIT) {
          return {
            content: [{ type: "text", text: `Background concurrency limit reached (${BG_CONCURRENCY_LIMIT}). Wait for a running background subagent to finish or cancel one.` }],
            details: { action, agentName: agentDef.name, agentScope: agentDef.scope, assignedTask: task, inheritContext: params.inherit_context ?? agentDef.inheritContext, success: false, aborted: false, timedOut: false, error: `BG concurrency limit (${BG_CONCURRENCY_LIMIT}) reached`, metadata: { ...EMPTY_METADATA }, conversationEntries: [], monitorStatus: "error", permissionDeniedCount: 0 } satisfies SubagentToolDetails,
          };
        }

        const runId = randomUUID();
        const inheritContext = params.inherit_context ?? agentDef.inheritContext;
        let parentConversation: string | undefined;
        if (inheritContext && parentConversationProvider) {
          parentConversation = parentConversationProvider(ctx);
        }

        const { id, pid } = await spawnBackgroundAgent({
          agent: agentDef,
          task,
          cwd: ctx.cwd,
          parentModel: ctx.model
            ? { provider: ctx.model.provider, id: ctx.model.id }
            : undefined,
          parentConversation,
          config,
          runId,
        });

        ctx.ui?.notify?.(`Background subagent "${agentDef.name}" started (id: ${id.slice(0, 8)})`, "info");

        return {
          content: [{ type: "text", text: `Background agent "${agentDef.name}" spawned (id: ${id.slice(0, 8)}, pid: ${pid}). Check with subagent({action:'status'}).` }],
          details: {
            action,
            agentName: agentDef.name,
            agentScope: agentDef.scope,
            assignedTask: task,
            inheritContext,
            success: true,
            aborted: false,
            timedOut: false,
            metadata: { ...EMPTY_METADATA },
            conversationEntries: [],
            monitorStatus: "running",
            permissionDeniedCount: 0,
            bgJobId: id,
            bgJobPid: pid,
          } satisfies SubagentToolDetails,
        };
      }

      // ── action: run (foreground) — existing logic ───────────────
      // Enforce concurrency limit
      if (activeCount >= config.concurrencyLimit) {
        return {
          content: [{ type: "text", text: `Concurrency limit reached (${config.concurrencyLimit} concurrent subagents). Wait for a running subagent to finish.` }],
          details: { action, agentName: agentName, agentScope: "global", assignedTask: task, inheritContext: params.inherit_context ?? false, success: false, aborted: false, timedOut: false, error: `Concurrency limit (${config.concurrencyLimit}) reached`, metadata: { ...EMPTY_METADATA }, conversationEntries: [], monitorStatus: "error", permissionDeniedCount: 0 } satisfies SubagentToolDetails,
        };
      }

      const inheritContext = params.inherit_context ?? agentDef.inheritContext;
      let parentConversation: string | undefined;
      if (inheritContext && parentConversationProvider) {
        parentConversation = parentConversationProvider(ctx);
      }

      // Create monitor for this invocation
      const monitor = new SubagentMonitor(agentDef, task || "(no task)");
      const startedAt = Date.now();

      // Register in viewer registry for /subagent-view overlay
      const viewerId = registerViewerAgent({
        agentName: agentDef.name,
        agentScope: agentDef.scope,
        task: task || "(no task)",
        status: "running",
        metadata: { ...EMPTY_METADATA },
        conversation: [],
        lastAssistantText: undefined,
        error: undefined,
        startedAt: startedAt,
        completedAt: undefined,
      });

      activeCount++;
      let lastResult: SubagentResult | undefined;
      let lastAssistantText: string | undefined;
      let retryHint: string | undefined;

      try {
        let currentMetadata: SubagentMetadata = { ...EMPTY_METADATA };

        const emitUpdate = () => {
          onUpdate?.({
            content: [{
              type: "text",
              text: monitor.isRunning()
                ? `Running ${agentDef.name}...`
                : monitor.getStatus() === "completed"
                  ? lastAssistantText ?? "Completed"
                  : `Failed: ${lastResult?.error ?? "unknown"}`,
            }],
            details: {
              action,
              agentName: agentDef.name,
              agentScope: agentDef.scope,
              assignedTask: task,
              inheritContext,
              success: false,
              aborted: false,
              timedOut: false,
              metadata: currentMetadata,
              conversationEntries: monitor.getConversation().map((e) => ({
                role: e.role,
                text: e.text,
                toolName: e.toolName,
                isError: e.isError,
              })),
              monitorStatus: monitor.getStatus(),
              permissionDeniedCount: monitor.getPermissionDeniedCount(),
              lastAssistantText,
              retryHint,
            } satisfies SubagentToolDetails,
          });
        };

        const maxAttempts = config.maxRetries + 1;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          currentMetadata = { ...EMPTY_METADATA };

          const onEvent = (event: SubagentEvent) => {
            monitor.pushEvent(event);
            if (event.type === "tool_execution_start") currentMetadata.toolCalls++;
            if (event.type === "tool_execution_end") { if (event.isError) currentMetadata.failedToolCalls++; }
            if (event.type === "message_end" && event.message?.role === "assistant") {
              currentMetadata.turns++;
              const usage = event.message?.usage;
              if (usage) {
                currentMetadata.input += usage.input ?? 0;
                currentMetadata.output += usage.output ?? 0;
                currentMetadata.cacheRead += usage.cacheRead ?? 0;
                currentMetadata.cacheWrite += usage.cacheWrite ?? 0;
                currentMetadata.totalTokens += usage.totalTokens ?? 0;
                currentMetadata.cost += usage.cost?.total ?? 0;
              }
              const text = extractAssistantText(event.message as Record<string, unknown>);
              if (text) lastAssistantText = text;
            }
            currentMetadata.durationMs = Date.now() - startedAt;
            emitUpdate();
            updateViewerAgent(viewerId, {
              metadata: { ...currentMetadata },
              conversation: monitor.getConversation(),
              lastAssistantText,
            });
          };

          lastResult = await runSubagent({
            agent: agentDef,
            task,
            cwd: ctx.cwd,
            parentModel: ctx.model
              ? { provider: ctx.model.provider, id: ctx.model.id }
              : undefined,
            parentConversation,
            config,
            signal,
            onEvent,
            retryHint,
          });

          currentMetadata = lastResult.metadata;
          if (lastResult.success || lastResult.aborted) break;

          if (attempt < maxAttempts) {
            if (lastResult.timedOut) {
              retryHint = "Previous attempt timed out. Be more focused.";
            } else if (lastResult.error) {
              retryHint = `Previous attempt failed: ${lastResult.error.slice(0, 100)}. Try differently.`;
            }
          }
        }

        const result = lastResult!;

        recordAgentRun({
          agent: agentDef.name,
          metadata: result.metadata,
          timestamp: Date.now(),
        });

        if (result.success) monitor.markCompleted();
        else if (result.aborted) monitor.markAborted();
        else if (result.timedOut) monitor.markTimedOut();
        else monitor.markError();

        const finalViewerStatus: ViewerAgentState["status"] =
          result.success ? "completed"
          : result.aborted ? "aborted"
          : result.timedOut ? "timed_out"
          : "error";
        updateViewerAgent(viewerId, {
          status: finalViewerStatus,
          metadata: result.metadata,
          conversation: monitor.getConversation(),
          lastAssistantText,
          error: result.error,
          completedAt: Date.now(),
        });

        const finalDetails: SubagentToolDetails = {
          action,
          agentName: agentDef.name,
          agentScope: agentDef.scope,
          assignedTask: task,
          inheritContext,
          success: result.success,
          aborted: result.aborted,
          timedOut: result.timedOut,
          error: result.error,
          metadata: result.metadata,
          retryHint,
          conversationEntries: monitor.getConversation().map((e) => ({
            role: e.role,
            text: e.text,
            toolName: e.toolName,
            isError: e.isError,
          })),
          monitorStatus: monitor.getStatus(),
          permissionDeniedCount: monitor.getPermissionDeniedCount(),
          lastAssistantText,
        };

        if (!result.success) {
          let errorMsg = result.error ?? "Unknown error";
          if (result.timedOut) errorMsg += " — consider a more focused task.";
          return { content: [{ type: "text", text: errorMsg }], details: finalDetails };
        }

        return { content: [{ type: "text", text: result.text }], details: finalDetails };

      } finally {
        activeCount--;
        cleanupViewerRegistry();
      }
    },

    // ── renderCall ──────────────────────────────────────────────────

    renderCall(args, theme, _context) {
      const action = args.action ?? "run";
      const agentName = args.agent ?? "...";
      const actionLabel = action === "run_bg" ? "subagent bg " : action === "status" ? "subagent status" : action === "collect" ? "subagent collect" : action === "cancel" ? "subagent cancel" : "subagent ";
      let text =
        theme.fg("toolTitle", theme.bold(actionLabel)) +
        theme.fg("accent", agentName);
      if (args.inherit_context) {
        text += theme.fg("muted", " with context");
      }
      if (args.job_id) {
        text += theme.fg("muted", ` id=${String(args.job_id).slice(0, 8)}`);
      }
      return new Text(text, 0, 0);
    },

    // ── renderResult ────────────────────────────────────────────────

    renderResult(result, { expanded }, theme, _context) {
      const details = result.details as SubagentToolDetails | undefined;
      if (!details) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
      }

      const action = details.action ?? "run";

      // ── Non-run actions: simplified display ─────────────────────
      if (action === "status") {
        const container = new Container();
        const icon = details.success ? "✓" : "✗";
        container.addChild(new Text(`${icon} Background Subagents`, 0, 0));
        if (details.bgJobs && details.bgJobs.length > 0) {
          for (const j of details.bgJobs) {
            const sIcon = j.status === "running" ? "◉" : j.status === "complete" ? "✓" : j.status === "failed" ? "✗" : "○";
            const elapsed = j.elapsed < 60_000 ? `${Math.round(j.elapsed / 1000)}s` : `${Math.floor(j.elapsed / 60_000)}m`;
            container.addChild(new Text(theme.fg("toolOutput", `  ${sIcon} ${j.agent} (${j.id.slice(0, 8)}) · ${j.status} · ${elapsed} · ${j.turns}t ${j.toolCount} tools${j.currentPath ? ` · ${j.currentPath}` : ""}`), 0, 0));
          }
        } else {
          container.addChild(new Text(theme.fg("muted", "  No background jobs"), 0, 0));
        }
        const text = result.content[0];
        if (text?.type === "text" && expanded) {
          container.addChild(new Text(theme.fg("toolOutput", text.text), 0, 0));
        }
        return container;
      }

      if (action === "run_bg") {
        const container = new Container();
        const icon = details.success ? "◉" : "✗";
        container.addChild(new Text(`${icon} Background spawn · ${theme.fg("accent", details.agentName)}`, 0, 0));
        if (details.bgJobId) {
          container.addChild(new Text(theme.fg("muted", `  id: ${details.bgJobId.slice(0, 8)}  pid: ${details.bgJobPid ?? "?"}`), 0, 0));
        }
        const text = result.content[0];
        if (text?.type === "text") {
          container.addChild(new Text(theme.fg("toolOutput", text.text), 0, 0));
        }
        if (details.error) {
          container.addChild(new Text(theme.fg("error", details.error), 0, 0));
        }
        return container;
      }

      if (action === "cancel") {
        const container = new Container();
        const icon = details.success ? "⊘" : "✗";
        container.addChild(new Text(`${icon} Cancel · ${theme.fg("accent", details.agentName)}`, 0, 0));
        const text = result.content[0];
        if (text?.type === "text") {
          container.addChild(new Text(theme.fg("toolOutput", text.text), 0, 0));
        }
        return container;
      }

      if (action === "collect") {
        const container = new Container();
        const icon = details.success ? "✓" : "✗";
        container.addChild(new Text(`${icon} Collected · ${theme.fg("accent", details.agentName)}`, 0, 0));
        if (details.metadata.turns > 0) {
          container.addChild(new Text(theme.fg("dim", `  ${formatMetadataCompact(details.metadata)}`), 0, 0));
        }
        if (details.sessionFile) {
          container.addChild(new Text(theme.fg("muted", `  Session: ${details.sessionFile}`), 0, 0));
        }
        if (expanded && details.lastAssistantText) {
          const mdTheme = getMarkdownTheme();
          container.addChild(new Spacer(1));
          container.addChild(new Markdown(details.lastAssistantText.trim(), 0, 0, mdTheme));
        }
        if (details.error) {
          container.addChild(new Text(theme.fg("error", details.error), 0, 0));
        }
        return container;
      }

      // ── action: run (foreground) — full display ──────────────────
      const mdTheme = getMarkdownTheme();
      const icon = statusIcon(details.monitorStatus, theme);
      const label = statusLabel(details.monitorStatus, theme);
      const name = theme.fg("toolTitle", theme.bold(details.agentName));
      const scope = theme.fg("muted", ` [${details.agentScope}]`);

      // ── Collapsed ────────────────────────────────────────
      if (!expanded) {
        const container = new Container();

        // Header line
        let header = `${icon} ${name}${scope}`;
        const metaStr = formatMetadataCompact(details.metadata);
        if (metaStr) header += theme.fg("dim", ` · ${metaStr}`);
        if (details.permissionDeniedCount > 0) {
          header += theme.fg("warning", ` · ${details.permissionDeniedCount} denied`);
        }
        container.addChild(new Text(header, 0, 0));

        // Task preview
        const taskLines = details.assignedTask.trim().split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim());
        const previewLines = taskLines.slice(0, 4);
        const hidden = Math.max(0, taskLines.length - 4);
        if (previewLines.length > 0) {
          container.addChild(new Text(theme.fg("muted", "─── task ───"), 0, 0));
          container.addChild(new Text(theme.fg("toolOutput", previewLines.join("\n")), 0, 0));
          if (hidden > 0) {
            container.addChild(
              new Text(
                theme.fg("dim", `… ${hidden} more lines`) + ` · ${keyHint("app.tools.expand", "expand")}`,
                0, 0,
              ),
            );
          }
        }

        // Report preview (completed)
        if (details.success && details.lastAssistantText) {
          const reportLines = details.lastAssistantText.trim().split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim());
          const reportPreview = reportLines.slice(0, 4);
          const reportHidden = Math.max(0, reportLines.length - 4);
          if (reportPreview.length > 0) {
            container.addChild(new Text(theme.fg("muted", "─── report ───"), 0, 0));
            container.addChild(new Text(theme.fg("toolOutput", reportPreview.join("\n")), 0, 0));
            if (reportHidden > 0) {
              container.addChild(
                new Text(
                  theme.fg("dim", `… ${reportHidden} more lines`) + ` · ${keyHint("app.tools.expand", "expand report")}`,
                  0, 0,
                ),
              );
            }
          }
        } else if (details.monitorStatus === "running") {
          container.addChild(
            new Text(theme.fg("muted", `running · ${keyHint("app.tools.expand", "details")}`), 0, 0),
          );
        } else if (details.error) {
          container.addChild(new Text(theme.fg("error", details.error.slice(0, 120)), 0, 0));
        }

        return container;
      }

      // ── Expanded: status + task + report + viewer hint ──
      const container = new Container();

      // Header
      container.addChild(new Text(`${icon} ${label} ${name}${scope}`, 0, 0));
      container.addChild(
        new Text(
          keyHint("app.tools.expand", "collapse") + theme.fg("dim", ` · ${formatMetadataDetailed(details.metadata)}`),
          0, 0,
        ),
      );
      if (details.permissionDeniedCount > 0) {
        container.addChild(new Text(theme.fg("warning", `${details.permissionDeniedCount} permission denials`), 0, 0));
      }
      if (details.retryHint) {
        container.addChild(new Text(theme.fg("warning", `Retry: ${details.retryHint}`), 0, 0));
      }
      if (details.error) {
        container.addChild(new Text(theme.fg("error", `Error: ${details.error}`), 0, 0));
      }

      // Full assigned task
      container.addChild(new Spacer(1));
      container.addChild(new Text(theme.fg("muted", "─── assigned task ───"), 0, 0));
      container.addChild(new Text(theme.fg("toolOutput", details.assignedTask.trim()), 0, 0));

      // Report
      if (details.success && details.lastAssistantText) {
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("muted", "─── report ───"), 0, 0));
        container.addChild(new Markdown(details.lastAssistantText.trim(), 0, 0, mdTheme));
      } else if (details.error) {
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("muted", "─── error ───"), 0, 0));
        container.addChild(new Text(theme.fg("error", details.error), 0, 0));
      }

      // Viewer hint
      container.addChild(new Spacer(1));
      container.addChild(new Text(theme.fg("dim", `Run /subagent-view for the full conversation`), 0, 0));

      return container;
    },
  });

  // ── list_subagents tool ──────────────────────────────────────────

  pi.registerTool({
    name: "list_subagents",
    label: "List Subagents",
    description:
      "List all available subagent types with full delegation rules, tool lists, model info, and usage guidance. Call this before first delegation or when unsure which agent to use.",
    parameters: ListSubagentsParams,

    async execute() {
      const discovery = getDiscovery();
      const catalog = buildAgentCatalog(discovery.agents);
      return {
        content: [{ type: "text", text: catalog }],
        details: { agentCount: discovery.agents.size },
      };
    },

    renderResult(result, { expanded }, theme) {
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      if (!expanded) {
        const preview = text.split("\n").slice(0, 5).join("\n");
        return new Text(
          theme.fg("muted", preview) +
            (text.split("\n").length > 5
              ? `\n${theme.fg("dim", "... expand for full details")}`
              : ""),
          0,
          0,
        );
      }
      return new Text(theme.fg("muted", text), 0, 0);
    },
  });
}
