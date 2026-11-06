/**
 * viewer.ts — Overlay conversation viewer for inspecting subagent sessions.
 *
 * Uses ctx.ui.custom() with overlay: true to show a scrollable, live-updating
 * view of a subagent's conversation. Keyboard-navigable with arrow keys,
 * PageUp/PageDown, Home/End. Escape or 'q' to close.
 */

import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { ConversationEntry, MonitorStatus } from "./monitor.ts";
import { statusIcon, statusLabel } from "./monitor.ts";
import { formatMetadataDetailed } from "./runner.ts";
import type { SubagentMetadata } from "./runner.ts";

// ── Monitor registry ─────────────────────────────────────────────────

export interface ViewerAgentState {
  agentName: string;
  agentScope: string;
  task: string;
  status: MonitorStatus;
  metadata: SubagentMetadata;
  conversation: ConversationEntry[];
  lastAssistantText?: string;
  error?: string;
  startedAt: number;
  completedAt?: number;
}

/** Module-level registry of active subagent monitors. */
const monitorRegistry = new Map<string, ViewerAgentState>();

/** Active viewer component (if overlay is open). */
let activeViewer: SubagentViewer | undefined;

let nextViewerId = 0;

/** Register a monitor for viewer access. Returns a unique ID. */
export function registerViewerAgent(initialState: ViewerAgentState): string {
  const id = `v-${++nextViewerId}`;
  monitorRegistry.set(id, initialState);
  return id;
}

/** Update a registered monitor's state. */
export function updateViewerAgent(
  id: string,
  patch: Partial<ViewerAgentState>,
): void {
  const existing = monitorRegistry.get(id);
  if (!existing) return;
  monitorRegistry.set(id, { ...existing, ...patch });
  // Notify active viewer if it's showing this agent
  if (activeViewer) {
    activeViewer.notifyUpdate();
  }
}

/** Get a registered monitor's state. */
export function getViewerAgent(id: string): ViewerAgentState | undefined {
  return monitorRegistry.get(id);
}

/** Remove a registered monitor from the registry. */
export function removeViewerAgent(id: string): void {
  monitorRegistry.delete(id);
}

/** List all registered agents (for the /subagents menu). */
export function listViewerAgents(): Array<{
  id: string;
  state: ViewerAgentState;
}> {
  return [...monitorRegistry.entries()].map(([id, state]) => ({ id, state }));
}

/** Clean up completed agents that have been in the registry for a while. */
export function cleanupViewerRegistry(maxAgeMs: number = 600_000): void {
  const now = Date.now();
  for (const [id, state] of monitorRegistry.entries()) {
    // Only clean up finished agents
    if (state.status === "running") continue;
    // Remove if older than maxAge
    const age = state.completedAt ?? state.startedAt;
    if (now - age > maxAgeMs) {
      monitorRegistry.delete(id);
    }
  }
}

/** Set the active viewer component (called when overlay opens). */
export function setActiveViewer(viewer: SubagentViewer | undefined): void {
  activeViewer = viewer;
}

// ── Helpers ────────────────────────────────────────────────────────────

function formatDuration(startedAt: number, completedAt?: number): string {
  if (completedAt) return `${((completedAt - startedAt) / 1000).toFixed(1)}s`;
  return `${((Date.now() - startedAt) / 1000).toFixed(1)}s (running)`;
}

// ── Component ─────────────────────────────────────────────────────────

type Theme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
};

export class SubagentViewer {
  private scrollOffset = 0;
  private autoScroll = true;
  private closed = false;
  private lastConversationLength = 0;
  private lastStatus: string = "";

  constructor(
    private tui: any,
    private agentId: string,
    private theme: Theme,
    private done: (result: undefined) => void,
  ) {
    const state = getViewerAgent(this.agentId);
    this.lastConversationLength = state?.conversation?.length ?? 0;
    this.lastStatus = state?.status ?? "";
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "q")) {
      this.closed = true;
      this.done(undefined);
      return;
    }

    const totalLines = this.buildContentLines(this.lastInnerW).length;
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, totalLines - viewportHeight);

    if (matchesKey(data, "up") || matchesKey(data, "k")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (matchesKey(data, "down") || matchesKey(data, "j")) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (matchesKey(data, "pageUp")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - viewportHeight);
      this.autoScroll = false;
    } else if (matchesKey(data, "pageDown")) {
      this.scrollOffset = Math.min(
        maxScroll,
        this.scrollOffset + viewportHeight,
      );
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (matchesKey(data, "home")) {
      this.scrollOffset = 0;
      this.autoScroll = false;
    } else if (matchesKey(data, "end") || matchesKey(data, "G")) {
      this.scrollOffset = maxScroll;
      this.autoScroll = true;
    }

    this.tui.requestRender?.();
  }

  private lastInnerW = 0;

  render(width: number): string[] {
    if (width < 6) return [];

    const th = this.theme;
    const innerW = width - 4; // border + padding
    this.lastInnerW = innerW;

    const state = getViewerAgent(this.agentId);
    if (!state) {
      return [
        th.fg("border", `╭${"─".repeat(width - 2)}╮`),
        th.fg("border", `│`) +
          " " +
          th.fg("dim", "Agent session expired".padEnd(innerW)) +
          " " +
          th.fg("border", `│`),
        th.fg("border", `╰${"─".repeat(width - 2)}╯`),
      ];
    }

    const pad = (s: string, len: number) => {
      const vis = visibleWidth(s);
      return s + " ".repeat(Math.max(0, len - vis));
    };
    const row = (content: string) =>
      th.fg("border", "│") +
      " " +
      truncateToWidth(pad(content, innerW), innerW) +
      " " +
      th.fg("border", "│");
    const hrTop = th.fg("border", `╭${"─".repeat(width - 2)}╮`);
    const hrBot = th.fg("border", `╰${"─".repeat(width - 2)}╯`);
    const hrMid = row(th.fg("dim", "─".repeat(innerW)));

    const lines: string[] = [];

    // Header
    lines.push(hrTop);
    const icon = statusIcon(state.status, th);
    const label = statusLabel(state.status, th);
    const duration = formatDuration(state.startedAt, state.completedAt);
    const scopeTag =
      state.agentScope !== "global" ? ` (${state.agentScope})` : "";
    const metaStr = formatMetadataDetailed(state.metadata);
    lines.push(
      row(
        `${icon} ${label} ${th.bold(state.agentName)}${scopeTag}  ${th.fg("muted", state.task.slice(0, 60))} ${th.fg("dim", "·")} ${th.fg("dim", metaStr || duration)}`,
      ),
    );
    lines.push(hrMid);

    // Content — rebuild every render (live data)
    const contentLines = this.buildContentLines(innerW);
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, contentLines.length - viewportHeight);

    if (this.autoScroll) {
      this.scrollOffset = maxScroll;
    }

    const visibleStart = Math.min(this.scrollOffset, maxScroll);
    const visible = contentLines.slice(
      visibleStart,
      visibleStart + viewportHeight,
    );

    for (let i = 0; i < viewportHeight; i++) {
      lines.push(row(visible[i] ?? ""));
    }

    // Footer
    lines.push(hrMid);
    const scrollPct =
      contentLines.length <= viewportHeight
        ? "100%"
        : `${Math.round(((visibleStart + viewportHeight) / contentLines.length) * 100)}%`;
    const footerLeft = th.fg(
      "dim",
      `${contentLines.length} lines · ${scrollPct}`,
    );
    const footerRight = th.fg(
      "dim",
      "↑↓ scroll · PgUp/PgDn · Home/End · Esc close",
    );
    const footerGap = Math.max(
      1,
      innerW - visibleWidth(footerLeft) - visibleWidth(footerRight),
    );
    lines.push(row(footerLeft + " ".repeat(footerGap) + footerRight));
    lines.push(hrBot);

    return lines;
  }

  invalidate(): void {
    // No cached state to clear
  }

  /** Called externally when new conversation data arrives. */
  notifyUpdate(): void {
    if (this.closed) return;
    const state = getViewerAgent(this.agentId);
    if (!state) return;

    const currentLength = state.conversation?.length ?? 0;
    const currentStatus = state.status;

    if (
      currentLength !== this.lastConversationLength ||
      currentStatus !== this.lastStatus
    ) {
      this.lastConversationLength = currentLength;
      this.lastStatus = currentStatus;
      this.tui.requestRender?.();
    }
  }

  // ── Private ────────────────────────────────────────────────────

  private viewportHeight(): number {
    const rows = this.tui?.terminal?.rows ?? 30;
    // Chrome: top border + header + header sep + footer sep + footer + bottom border = 6
    return Math.max(3, rows - 6);
  }

  private buildContentLines(width: number): string[] {
    const th = this.theme;
    const state = getViewerAgent(this.agentId);
    if (!state) return [th.fg("dim", "(session expired)")];

    const lines: string[] = [];
    const conversation = state.conversation;

    if (conversation.length === 0) {
      if (state.status === "running") {
        lines.push(th.fg("dim", "(waiting for first message...)"));
      } else {
        lines.push(th.fg("dim", "(no conversation entries)"));
      }
      return lines.map((l) => truncateToWidth(l, width));
    }

    let needsSeparator = false;
    for (const entry of conversation) {
      if (needsSeparator) lines.push(th.fg("dim", "───"));

      if (entry.role === "user") {
        lines.push(th.fg("accent", "[User]"));
        const text =
          entry.text.length > 200
            ? entry.text.slice(0, 197) + "..."
            : entry.text;
        for (const line of wrapTextWithAnsi(text, width)) {
          lines.push(th.fg("muted", line));
        }
      } else if (entry.role === "assistant") {
        lines.push(th.bold("[Assistant]"));
        const text =
          entry.text.length > 1000
            ? entry.text.slice(0, 997) + "..."
            : entry.text;
        for (const line of wrapTextWithAnsi(text.trim(), width)) {
          lines.push(line);
        }
      } else if (entry.role === "tool") {
        const icon = entry.isError
          ? th.fg("error", "✗")
          : th.fg("success", "→");
        const color = entry.isError ? "error" : "muted";
        lines.push(`${icon} ${th.fg(color, entry.text)}`);
      }

      needsSeparator = true;
    }

    // Final report for completed agents
    if (state.status === "completed" && state.lastAssistantText) {
      lines.push("");
      lines.push(th.fg("dim", "─── final report ───"));
      const reportText = state.lastAssistantText.trim();
      for (const line of wrapTextWithAnsi(reportText, width)) {
        lines.push(line);
      }
    }

    // Error display
    if (state.error && state.status !== "completed") {
      lines.push("");
      lines.push(th.fg("error", `Error: ${state.error}`));
    }

    // Running indicator
    if (state.status === "running") {
      lines.push("");
      lines.push(th.fg("accent", "▍ ") + th.fg("dim", "running…"));
    }

    return lines.map((l) => truncateToWidth(l, width));
  }
}
