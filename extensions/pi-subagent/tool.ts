/**
 * tool.ts — Register the `subagent` and `list_subagents` tools with
 * collapsed/expanded rendering. Full conversation details live in the
 * /subagent-view overlay; the main view shows status + report only.
 */

import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, keyHint } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type { AgentDefinition, AgentDiscoveryResult } from "./agents.ts";
import { hasWriteTools, buildAgentSummary, buildAgentCatalog } from "./agents.ts";
import type { SubagentConfig } from "./config.ts";
import { loadConfig } from "./config.ts";
import { runSubagent, formatMetadataCompact, formatMetadataDetailed, extractAssistantText } from "./runner.ts";
import type { SubagentResult, SubagentMetadata, SubagentEvent } from "./runner.ts";
import { SubagentMonitor, statusIcon, statusLabel, type MonitorStatus } from "./monitor.ts";
import { registerViewerAgent, updateViewerAgent, removeViewerAgent, cleanupViewerRegistry, type ViewerAgentState } from "./viewer.ts";

// ── Concurrency tracking ─────────────────────────────────────────────

let activeCount = 0;

// ── Schema ──────────────────────────────────────────────────────────

const SubagentParams = Type.Object({
  agent: Type.String({
    description:
      "Agent type name. Must match a defined agent. Call list_subagents to discover available agents.",
  }),
  task: Type.String({
    description:
      "Self-contained task for the subagent. Include objective, relevant context, constraints, and expected output format.",
  }),
  inherit_context: Type.Optional(
    Type.Boolean({
      description:
        "Fork parent conversation into the subagent. Overrides the agent's default.",
      default: false,
    }),
  ),
});

const ListSubagentsParams = Type.Object({});

// ── Details type ─────────────────────────────────────────────────────

export interface SubagentToolDetails {
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
      `Available agents: ${agentList}`,
      "Use list_subagents() for full delegation rules and agent details.",
    ].join(" "),
    promptSnippet:
      "Delegate to specialized subagents for isolated tasks. Call list_subagents() for delegation rules.",
    promptGuidelines: [
      "Prefer subagent over direct tool calls for any task that involves reading, scanning, mapping, or exploring files — even small directories. The goal is context hygiene: keep the parent session clean by offloading file reads to an isolated agent.",
      "Use subagent explore for: tasks that would require reading many files or scanning large directories — enough reads to clutter the parent context. Do not delegate explore for small tasks like reading 2-3 files; handle those directly.",
      "Use subagent reviewer for: code review, second opinion, audit, or independent verification. Must use reviewer when the user explicitly asks for review.",
      "Use subagent planner for: architecture design, migration planning, or working through ambiguous requirements before implementation. Must use planner when the user asks for a plan or approach.",
      "Do not use subagent for trivial answers answerable without reading files (e.g., 'what is the package name in package.json' — just read it), obvious typo fixes, or tasks requiring ongoing conversation context that the subagent won't have.",
      "Write-capable subagent delegation is exceptional — the parent owns implementation and final validation by default.",
      "When delegating, provide a self-contained task with objective, relevant context, constraints, and expected output format. Call list_subagents() for full agent details.",
    ],
    parameters: SubagentParams,
    executionMode: "parallel",

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const discovery = getDiscovery();
      const config = loadConfig();
      const agentDef = discovery.agents.get(params.agent);

      // Enforce concurrency limit
      if (activeCount >= config.concurrencyLimit) {
        return {
          content: [{ type: "text", text: `Concurrency limit reached (${config.concurrencyLimit} concurrent subagents). Wait for a running subagent to finish.` }],
          details: {
            agentName: params.agent,
            agentScope: "global",
            assignedTask: params.task,
            inheritContext: params.inherit_context ?? false,
            success: false, aborted: false, timedOut: false,
            error: `Concurrency limit (${config.concurrencyLimit}) reached`,
            metadata: { ...EMPTY_METADATA },
            conversationEntries: [],
            monitorStatus: "error",
            permissionDeniedCount: 0,
          } satisfies SubagentToolDetails,
        };
      }

      // Unknown agent type — soft error
      if (!agentDef) {
        const available = [...discovery.agents.keys()].join(", ") || "none";
        return {
          content: [{ type: "text", text: `Agent "${params.agent}" not found. Available agents: ${available}.` }],
          details: {
            agentName: params.agent,
            agentScope: "global",
            assignedTask: params.task,
            inheritContext: params.inherit_context ?? false,
            success: false, aborted: false, timedOut: false,
            error: `Agent "${params.agent}" not found. Available: ${available}`,
            metadata: { ...EMPTY_METADATA },
            conversationEntries: [],
            monitorStatus: "error",
            permissionDeniedCount: 0,
          } satisfies SubagentToolDetails,
        };
      }

      // Warning for write-capable agents
      if (hasWriteTools(agentDef) && ctx.hasUI) {
        const ok = await ctx.ui.confirm(
          "Write-capable subagent",
          `Agent "${agentDef.name}" can modify files. Continue?`,
        );
        if (!ok) {
          return {
            content: [{ type: "text", text: `Subagent "${agentDef.name}" invocation cancelled by user.` }],
            details: {
              agentName: agentDef.name,
              agentScope: agentDef.scope,
              assignedTask: params.task,
              inheritContext: params.inherit_context ?? agentDef.inheritContext,
              success: false, aborted: true, timedOut: false,
              error: "User cancelled write-capable agent",
              metadata: { ...EMPTY_METADATA },
              conversationEntries: [],
              monitorStatus: "aborted",
              permissionDeniedCount: 0,
            } satisfies SubagentToolDetails,
          };
        }
      }

      const inheritContext = params.inherit_context ?? agentDef.inheritContext;
      let parentConversation: string | undefined;
      if (inheritContext && parentConversationProvider) {
        parentConversation = parentConversationProvider(ctx);
      }

      // Create monitor for this invocation
      const monitor = new SubagentMonitor(agentDef, params.task || "(no task)");
      const startedAt = Date.now();

      // Register in viewer registry for /subagent-view overlay
      const viewerId = registerViewerAgent({
        agentName: agentDef.name,
        agentScope: agentDef.scope,
        task: params.task || "(no task)",
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
        // ── State tracking ─────────────────────────────────────────
        let currentMetadata: SubagentMetadata = { ...EMPTY_METADATA };

        // Emit incremental progress update to the TUI
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
              agentName: agentDef.name,
              agentScope: agentDef.scope,
              assignedTask: params.task,
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

        // ── Run with retry ────────────────────────────────────────
        const maxAttempts = config.maxRetries + 1;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          currentMetadata = { ...EMPTY_METADATA };

          const onEvent = (event: SubagentEvent) => {
            // All attempts share the same monitor — push events directly
            monitor.pushEvent(event);

            // Update incremental metadata
            if (event.type === "tool_execution_start") {
              currentMetadata.toolCalls++;
            }
            if (event.type === "tool_execution_end") {
              if (event.isError) currentMetadata.failedToolCalls++;
            }
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

            // Update viewer registry for live overlay
            updateViewerAgent(viewerId, {
              metadata: { ...currentMetadata },
              conversation: monitor.getConversation(),
              lastAssistantText,
            });
          };

          lastResult = await runSubagent({
            agent: agentDef,
            task: params.task,
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

          // Merge final metadata
          currentMetadata = lastResult.metadata;

          if (lastResult.success || lastResult.aborted) break;

          // Prepare retry hint
          if (attempt < maxAttempts) {
            if (lastResult.timedOut) {
              retryHint = "Previous attempt timed out. Be more focused.";
            } else if (lastResult.error) {
              retryHint = `Previous attempt failed: ${lastResult.error.slice(0, 100)}. Try differently.`;
            }
          }
        }

        // ── Finalize ──────────────────────────────────────────────
        // lastResult must exist here since maxAttempts >= 1 (validated by loadConfig)
        const result = lastResult!;

        if (result.success) monitor.markCompleted();
        else if (result.aborted) monitor.markAborted();
        else if (result.timedOut) monitor.markTimedOut();
        else monitor.markError();

        // Update viewer with final state
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
          agentName: agentDef.name,
          agentScope: agentDef.scope,
          assignedTask: params.task,
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
        // Periodically clean up old viewer entries
        cleanupViewerRegistry();
      }
    },

    // ── renderCall ──────────────────────────────────────────────────

    renderCall(args, theme, _context) {
      const agentName = args.agent ?? "...";
      let text =
        theme.fg("toolTitle", theme.bold("subagent ")) +
        theme.fg("accent", agentName);
      if (args.inherit_context) {
        text += theme.fg("muted", " with context");
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
