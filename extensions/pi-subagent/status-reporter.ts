/**
 * status-reporter.ts — Companion extension loaded by background subagent children.
 *
 * Hooks into tool_result and message_end events, writing a lightweight
 * status.json snapshot to the directory specified by PI_SUBAGENT_STATUS_DIR.
 * On completion, writes result.json with the final output + metadata.
 *
 * This extension is loaded via `-e` in the child pi process. It is NOT
 * loaded by the parent extension.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface StatusSnapshot {
  state: "running" | "complete" | "failed";
  pid: number;
  agent: string;
  task: string;
  turnCount: number;
  toolCount: number;
  currentTool?: string;
  currentPath?: string;
  lastActivityAt: number;
  startedAt: number;
  sessionFile: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
  durationMs: number;
  model?: string;
  stopReason?: string;
  error?: string;
}

interface ResultSnapshot {
  text: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
  durationMs: number;
  turns: number;
  toolCalls: number;
  model?: string;
  stopReason?: string;
  sessionFile: string;
  success: boolean;
  error?: string;
}

const STATUS_DIR = process.env.PI_SUBAGENT_STATUS_DIR;
if (!STATUS_DIR) {
  // Not a background subagent — skip silently
  // (export empty function so the extension loads without error)
}

export default function statusReporterExtension(pi: ExtensionAPI) {
  if (!STATUS_DIR) return;

  const statusPath = join(STATUS_DIR, "status.json");
  const resultPath = join(STATUS_DIR, "result.json");
  const startedAt = Date.now();
  const pid = process.pid;

  let turnCount = 0;
  let toolCount = 0;
  let currentTool: string | undefined;
  let currentPath: string | undefined;
  let lastAssistantText = "";
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let totalTokens = 0;
  let cost = 0;
  let model: string | undefined;
  let stopReason: string | undefined;
  let error: string | undefined;
  let sessionFile = "";

  function writeStatus(state: StatusSnapshot["state"]): void {
    try {
      const snapshot: StatusSnapshot = {
        state,
        pid,
        agent: process.env.PI_SUBAGENT_AGENT_NAME ?? "unknown",
        task: (process.env.PI_SUBAGENT_TASK ?? "").slice(0, 200),
        turnCount,
        toolCount,
        currentTool,
        currentPath,
        lastActivityAt: Date.now(),
        startedAt,
        sessionFile,
        input,
        output,
        cacheRead,
        cacheWrite,
        totalTokens,
        cost,
        durationMs: Date.now() - startedAt,
        model,
        stopReason,
        error,
      };
      writeFileSync(statusPath, JSON.stringify(snapshot, null, 2), "utf8");
    } catch {
      // Best-effort status reporting
    }
  }

  function writeResult(success: boolean): void {
    try {
      const result: ResultSnapshot = {
        text: lastAssistantText || "(no output)",
        input,
        output,
        cacheRead,
        cacheWrite,
        totalTokens,
        cost,
        durationMs: Date.now() - startedAt,
        turns: turnCount,
        toolCalls: toolCount,
        model,
        stopReason,
        sessionFile,
        success,
        error,
      };
      writeFileSync(resultPath, JSON.stringify(result, null, 2), "utf8");
    } catch {
      // Best-effort
    }
  }

  // Initial status
  writeStatus("running");

  // Track tool execution starts
  pi.on("tool_execution_start", (event: any) => {
    toolCount++;
    currentTool = event.toolName;

    // Extract a path-like field from args for display
    const args = event.args as Record<string, unknown> | undefined;
    if (args) {
      currentPath =
        (typeof args.path === "string" ? args.path : undefined) ??
        (typeof args.command === "string" ? args.command : undefined) ??
        (typeof args.pattern === "string" ? args.pattern : undefined) ??
        (typeof args.url === "string" ? args.url : undefined);
    }

    writeStatus("running");
  });

  // Track tool execution ends
  pi.on("tool_execution_end", (_event: any) => {
    currentTool = undefined;
    currentPath = undefined;
    writeStatus("running");
  });

  // Track agent messages (accumulate usage)
  pi.on("message_end", (event: any) => {
    const msg = event.message as Record<string, unknown> | undefined;
    if (!msg) return;

    if (msg.role === "assistant") {
      turnCount++;
      const usage = msg.usage as Record<string, number | { total?: number }> | undefined;
      if (usage) {
        input += (usage.input as number) ?? 0;
        output += (usage.output as number) ?? 0;
        cacheRead += (usage.cacheRead as number) ?? 0;
        cacheWrite += (usage.cacheWrite as number) ?? 0;
        totalTokens += (usage.totalTokens as number) ?? 0;
        cost += (usage.cost as { total?: number })?.total ?? 0;
      }

      if (msg.model && typeof msg.model === "string") model = msg.model;
      if (msg.stopReason && typeof msg.stopReason === "string") stopReason = msg.stopReason;

      // Extract assistant text
      const content = msg.content;
      if (typeof content === "string") {
        lastAssistantText = content;
      } else if (Array.isArray(content)) {
        lastAssistantText = content
          .filter((c: any) => c?.type === "text")
          .map((c: any) => c.text)
          .join("\n");
      }
    }

    writeStatus("running");
  });

  // On session shutdown, write final result
  pi.on("session_shutdown", (_event) => {
    writeStatus("complete");
    writeResult(true);
  });

  // Capture session file path from the first session_start
  pi.on("session_start", (_event, ctx) => {
    // Pi stores session file internally; we approximate from the CWD + session identity
    // The parent provides the expected path via env
    sessionFile = process.env.PI_SUBAGENT_SESSION_FILE ?? "";
  });

  // Handle errors
  process.on("uncaughtException", (err) => {
    error = err.message;
    writeStatus("failed");
    writeResult(false);
  });
}