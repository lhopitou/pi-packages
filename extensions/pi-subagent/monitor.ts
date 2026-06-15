/**
 * monitor.ts — Live conversation state tracking for subagent sessions.
 *
 * Captures tool calls and assistant messages as ConversationEntry items.
 * Used by tool.ts for renderResult and by viewer.ts for the overlay.
 */

import type { SubagentEvent } from "./runner.ts";
import { extractAssistantText } from "./runner.ts";
import type { AgentDefinition } from "./agents.ts";

// ── Shared status helpers ───────────────────────────────────────────

export type MonitorStatus =
  | "running"
  | "completed"
  | "aborted"
  | "error"
  | "timed_out";

export function statusIcon(status: MonitorStatus, theme: { fg: (name: string, text: string) => string }): string {
  switch (status) {
    case "running": return theme.fg("muted", "⏳");
    case "completed": return theme.fg("success", "✓");
    case "aborted": return theme.fg("warning", "■");
    case "timed_out": return theme.fg("warning", "⏱");
    case "error": return theme.fg("error", "✗");
  }
}

export function statusLabel(status: MonitorStatus, theme: { fg: (name: string, text: string) => string }): string {
  switch (status) {
    case "running": return theme.fg("muted", "Running");
    case "completed": return theme.fg("success", "Completed");
    case "aborted": return theme.fg("warning", "Aborted");
    case "timed_out": return theme.fg("warning", "Timed out");
    case "error": return theme.fg("error", "Failed");
  }
}

// ── Conversation entries ─────────────────────────────────────────────

export interface ConversationEntry {
  role: "assistant" | "tool" | "user";
  text: string;
  toolName?: string;
  toolArgs?: string;
  isError?: boolean;
  timestamp: number;
}

// ── Monitor class ────────────────────────────────────────────────────

export class SubagentMonitor {
  private entries: ConversationEntry[] = [];
  private status: MonitorStatus = "running";
  private agentName: string;
  private agentScope: "global" | "project";
  private toolCallCount = 0;
  private permissionDeniedCount = 0;

  constructor(agent: AgentDefinition, task: string) {
    this.agentName = agent.name;
    this.agentScope = agent.scope;
    // Add the initial task as a user message so it appears in conversation
    this.entries.push({
      role: "user",
      text: task,
      timestamp: Date.now(),
    });
  }

  pushEvent(event: SubagentEvent): void {
    // ── Full assistant message at message_end ──────────────────
    if (event.type === "message_end" && event.message?.role === "assistant") {
      const fullText = extractAssistantText(event.message as Record<string, unknown>);

      if (fullText) {
        const lastAssistant = this.entries.findLastIndex(
          (e) => e.role === "assistant",
        );
        if (lastAssistant >= 0) {
          this.entries[lastAssistant].text = fullText;
        } else {
          this.entries.push({
            role: "assistant",
            text: fullText,
            timestamp: Date.now(),
          });
        }
      }
    }

    // ── Tool execution start ───────────────────────────────────
    if (event.type === "tool_execution_start") {
      this.toolCallCount++;
      // Extract a short preview of the tool args
      let argsPreview = "";
      if (event.args) {
        const args = event.args;
        if (args.path || args.filePath) argsPreview = String(args.path ?? args.filePath);
        else if (args.command) argsPreview = String(args.command).slice(0, 80);
        else if (args.query) argsPreview = String(args.query).slice(0, 60);
        else if (args.url) argsPreview = String(args.url).slice(0, 60);
        else if (args.pattern) argsPreview = String(args.pattern);
        else {
          const firstValue = Object.values(args).find((v) => typeof v === "string" && v.length > 0);
          if (firstValue) argsPreview = String(firstValue).slice(0, 60);
        }
      }
      this.entries.push({
        role: "tool",
        text: argsPreview
          ? `${event.toolName ?? "unknown"}: ${argsPreview}`
          : `Calling ${event.toolName ?? "unknown"}...`,
        toolName: event.toolName,
        toolArgs: argsPreview,
        timestamp: Date.now(),
      });
    }

    // ── Tool execution end ────────────────────────────────────
    if (event.type === "tool_execution_end") {
      const lastTool = this.entries.findLastIndex(
        (e) => e.role === "tool" && e.toolName === event.toolName,
      );
      if (lastTool >= 0) {
        const existing = this.entries[lastTool];
        const prefix = existing.toolArgs
          ? `${event.toolName ?? "unknown"}: ${existing.toolArgs}`
          : `${event.toolName ?? "unknown"}`;
        this.entries[lastTool].text = event.isError
          ? `${prefix} ✗ (denied)`
          : `${prefix} ✓`;
        this.entries[lastTool].isError = event.isError;
        if (event.isError) this.permissionDeniedCount++;
      }
    }
  }

  markCompleted(): void { this.status = "completed"; }
  markAborted(): void { this.status = "aborted"; }
  markError(): void { this.status = "error"; }
  markTimedOut(): void { this.status = "timed_out"; }

  getConversation(): ConversationEntry[] { return [...this.entries]; }
  getToolCallCount(): number { return this.toolCallCount; }
  getPermissionDeniedCount(): number { return this.permissionDeniedCount; }
  getStatus(): MonitorStatus { return this.status; }
  getAgentName(): string { return this.agentName; }
  getAgentScope(): "global" | "project" { return this.agentScope; }
  isRunning(): boolean { return this.status === "running"; }
  isFinal(): boolean { return this.status !== "running"; }
}
