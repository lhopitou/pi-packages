/**
 * runner.ts — Child process spawn, event streaming, abort, and result collection.
 */

import { existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { AgentDefinition } from "./agents.ts";
import type { SubagentConfig } from "./config.ts";
import { resolvePermissionExtensionPath } from "./permissions.ts";

// ── Types ────────────────────────────────────────────────────────────

export interface SubagentEvent {
  type:
    | "tool_execution_start"
    | "tool_execution_end"
    | "message_start"
    | "message_update"
    | "message_end"
    | "tool_result_end";
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  message?: {
    role?: string;
    content?: unknown;
    usage?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      totalTokens?: number;
      cost?: { total?: number };
    };
    model?: string;
    stopReason?: string;
    errorMessage?: string;
  };
  args?: Record<string, unknown>;
}

export interface SubagentMetadata {
  turns: number;
  toolCalls: number;
  failedToolCalls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
  durationMs: number;
  model?: string;
  stopReason?: string;
}

export interface SubagentResult {
  success: boolean;
  text: string;
  metadata: SubagentMetadata;
  aborted: boolean;
  timedOut: boolean;
  error?: string;
}

export type EventCallback = (event: SubagentEvent) => void;

export interface RunOptions {
  agent: AgentDefinition;
  task: string;
  cwd: string;
  parentModel?: { provider: string; id: string };
  parentConversation?: string;
  config: SubagentConfig;
  signal?: AbortSignal;
  onEvent?: EventCallback;
  retryHint?: string;
}

// ── Shared helpers ───────────────────────────────────────────────────

/** Extract assistant text content from a message object. */
export function extractAssistantText(message: Record<string, unknown>): string {
  const content = message?.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part: unknown) => {
      if (!part || typeof part !== "object") return [];
      const p = part as { type?: string; text?: string };
      if (p.type !== "text" || typeof p.text !== "string") return [];
      return p.text.trim() ? [p.text.trim()] : [];
    })
    .join("\n");
}

function formatTokens(count: number): string {
  if (count < 1_000) return count.toString();
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

function emptyMetadata(): SubagentMetadata {
  return {
    turns: 0,
    toolCalls: 0,
    failedToolCalls: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: 0,
    durationMs: 0,
  };
}

// ── Process invocation ───────────────────────────────────────────────

function getPiCommand(): { command: string; args: string[] } {
  // Try to use the same runtime that loaded pi
  const currentScript = process.argv[1];
  if (currentScript && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript] };
  }

  const execName = (process.execPath ?? "").split("/").pop()?.toLowerCase();
  const isGeneric = /^(node|bun)(\.exe)?$/.test(execName ?? "");
  if (!isGeneric) {
    return { command: process.execPath, args: [] };
  }

  return { command: "pi", args: [] };
}

async function writePromptToTempFile(
  agentName: string,
  prompt: string,
): Promise<{ dir: string; filePath: string }> {
  const tmpDir = await mkdtemp(join(tmpdir(), "pi-subagent-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = join(tmpDir, `prompt-${safeName}.md`);
  writeFileSync(filePath, prompt, { encoding: "utf8", mode: 0o600 });
  return { dir: tmpDir, filePath };
}

// ── Main runner ──────────────────────────────────────────────────────

export async function runSubagent(options: RunOptions): Promise<SubagentResult> {
  const { agent, task, cwd, config, signal, onEvent, retryHint } = options;
  const startedAt = Date.now();
  const metadata = emptyMetadata();
  const messages: unknown[] = [];
  let lastAssistantText = "";
  let timedOut = false;
  let aborted = false;
  let exitCode = 0;
  let stderrText = "";

  // Build Pi invocation arguments
  const piBase = getPiCommand();
  const args: string[] = [
    ...piBase.args,
    "--mode",
    "json",
    "--no-session",
    "--no-prompt-templates",
    "--no-context-files",
  ];

  // Tools whitelist
  if (agent.tools.length > 0) {
    args.push("--tools", agent.tools.join(","));
  }

  // Skills: only pass the agent's specific skills
  if (agent.skills.length > 0) {
    args.push("--skills", agent.skills.join(","));
  } else {
    args.push("--no-skills");
  }

  // Model: agent-defined > parent model > Pi session default
  if (agent.model) {
    args.push("--model", agent.model);
  } else if (options.parentModel) {
    args.push("--model", `${options.parentModel.provider}/${options.parentModel.id}`);
  }

  // Thinking level
  if (agent.thinking) {
    args.push("--thinking", agent.thinking);
  }

  // Prevent auto-discovery of ALL extensions (including pi-subagent itself).
  // Only load explicitly requested extensions.
  args.push("--no-extensions");

  // Permission extension — always load via -e since we disabled auto-discovery
  const permExtPath = resolvePermissionExtensionPath(config);
  if (permExtPath) {
    args.push("-e", permExtPath);
  }

  // Agent extensions
  for (const extPath of agent.extensions) {
    args.push("-e", extPath);
  }

  // System prompt
  let tmpPromptDir: string | undefined;
  let tmpPromptPath: string | undefined;

  const effectivePrompt = retryHint
    ? `${task}\n\n[Note: ${retryHint}]`
    : task;

  if (agent.systemPrompt.trim()) {
    const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
    tmpPromptDir = tmp.dir;
    tmpPromptPath = tmp.filePath;
    args.push("--append-system-prompt", tmpPromptPath);
  }

  // Inherit context — written with mode 0o600 to prevent local disclosure
  let tmpContextDir: string | undefined;
  let tmpContextPath: string | undefined;
  if (options.parentConversation && agent.inheritContext) {
    const tmpDir2 = await mkdtemp(join(tmpdir(), "pi-subagent-ctx-"));
    const ctxFile = join(tmpDir2, "parent-context.md");
    writeFileSync(ctxFile, options.parentConversation, { encoding: "utf8", mode: 0o600 });
    tmpContextDir = tmpDir2;
    tmpContextPath = ctxFile;
    args.push("--append-system-prompt", tmpContextPath);
  }

  // Task as the final prompt argument
  args.push(effectivePrompt);

  // Timeout setup
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

  // Spawn the child process
  const proc = spawn(piBase.command, args, {
    cwd,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PI_SUBAGENT_CHILD: "1",
    },
  });

  let stdoutBuffer = "";

  const processLine = (line: string) => {
    if (!line.trim()) return;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }

    if (!event || typeof event !== "object") return;
    const e = event as Record<string, unknown>;

    // Emit typed event (skip streaming deltas — monitor only needs message_end)
    const typedEvent = e as unknown as SubagentEvent;
    if (typedEvent.type !== "message_update" && typedEvent.type !== "message_start") {
      onEvent?.(typedEvent);
    }

    // Track tool calls
    if (e.type === "tool_execution_start") {
      metadata.toolCalls++;
    }
    if (e.type === "tool_execution_end") {
      if (e.isError === true) metadata.failedToolCalls++;
    }

    // Track messages
    if (e.type === "message_end" && e.message) {
      messages.push(e.message);
      const msg = e.message as Record<string, unknown>;
      if (msg.role === "assistant") {
        metadata.turns++;
        const usage = msg.usage as SubagentEvent["message"]["usage"];
        if (usage) {
          metadata.input += usage.input ?? 0;
          metadata.output += usage.output ?? 0;
          metadata.cacheRead += usage.cacheRead ?? 0;
          metadata.cacheWrite += usage.cacheWrite ?? 0;
          metadata.totalTokens += usage.totalTokens ?? 0;
          metadata.cost += usage.cost?.total ?? 0;
        }
        const text = extractAssistantText(msg);
        if (text) lastAssistantText = text;
        if (msg.model && typeof msg.model === "string")
          metadata.model = msg.model;
        if (msg.stopReason && typeof msg.stopReason === "string")
          metadata.stopReason = msg.stopReason;
      }
    }
  };

  proc.stdout.on("data", (data: Buffer) => {
    stdoutBuffer += data.toString();
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) processLine(line);
  });

  proc.stderr.on("data", (data: Buffer) => {
    stderrText += data.toString();
  });

  // Wire abort signal
  let abortListener: (() => void) | undefined;
  if (signal) {
    const onAbort = () => {
      aborted = true;
      try {
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!proc.killed) proc.kill("SIGKILL");
        }, 5000);
      } catch {
        // Process may already be dead
      }
    };
    if (signal.aborted) onAbort();
    else {
      abortListener = onAbort;
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  // Wire timeout
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill("SIGTERM");
      } catch {
        // Process may already be dead
      }
      resolve("timeout");
    }, config.timeoutMs);
  });

  // Wait for child process to exit
  const exitPromise = new Promise<number>((resolve) => {
    proc.on("close", (code) => {
      // Flush remaining stdout
      if (stdoutBuffer.trim()) processLine(stdoutBuffer);
      resolve(code ?? 0);
    });
    proc.on("error", () => {
      resolve(1);
    });
  });

  const raceResult = await Promise.race([
    exitPromise.then((code): { type: "exit"; code: number } => ({ type: "exit", code })),
    timeoutPromise.then((): { type: "timeout" } => ({ type: "timeout" })),
  ]);

  // Cleanup
  if (timeoutTimer) clearTimeout(timeoutTimer);
  if (abortListener && signal) {
    signal.removeEventListener("abort", abortListener);
  }

  // Clean temp files and directories (use rmSync for directories)
  if (tmpPromptPath) {
    try { unlinkSync(tmpPromptPath); } catch {}
  }
  if (tmpPromptDir) {
    try { rmSync(tmpPromptDir, { recursive: true, force: true }); } catch {}
  }
  if (tmpContextPath) {
    try { unlinkSync(tmpContextPath); } catch {}
  }
  if (tmpContextDir) {
    try { rmSync(tmpContextDir, { recursive: true, force: true }); } catch {}
  }

  metadata.durationMs = Date.now() - startedAt;

  // Build result — check aborted/timedOut first, then extract exit code
  if (aborted) {
    return {
      success: false,
      text: "",
      metadata,
      aborted: true,
      timedOut: false,
      error: "Subagent was aborted by user",
    };
  }

  if (timedOut) {
    return {
      success: false,
      text: "",
      metadata,
      aborted: false,
      timedOut: true,
      error: `Subagent timed out after ${Math.round(config.timeoutMs / 60000)} minutes`,
    };
  }

  if (raceResult.type === "exit") {
    exitCode = raceResult.code;
  }

  if (exitCode !== 0) {
    return {
      success: false,
      text: "",
      metadata,
      aborted: false,
      timedOut: false,
      error: `Subagent process exited with code ${exitCode}${stderrText ? `: ${stderrText.trim().slice(0, 500)}` : ""}`,
    };
  }

  return {
    success: true,
    text: lastAssistantText || "(subagent completed without text output)",
    metadata,
    aborted: false,
    timedOut: false,
  };
}

// ── Format helpers for UI ────────────────────────────────────────────

export function formatMetadataCompact(m: SubagentMetadata): string {
  const parts: string[] = [];
  if (m.turns > 0) parts.push(`${m.turns}t`);
  if (m.toolCalls > 0) parts.push(`${m.toolCalls} tools`);
  if (m.input > 0) parts.push(`↑${formatTokens(m.input)}`);
  if (m.output > 0) parts.push(`↓${formatTokens(m.output)}`);
  if (m.cost > 0) parts.push(`$${m.cost.toFixed(4)}`);
  if (m.durationMs > 0) {
    if (m.durationMs < 1000) parts.push(`${m.durationMs}ms`);
    else if (m.durationMs < 60000)
      parts.push(`${(m.durationMs / 1000).toFixed(1)}s`);
    else
      parts.push(
        `${Math.floor(m.durationMs / 60000)}m${Math.floor((m.durationMs % 60000) / 1000)}s`,
      );
  }
  return parts.join(" · ");
}

export function formatMetadataDetailed(m: SubagentMetadata): string {
  const parts: string[] = [];
  if (m.turns > 0)
    parts.push(`${m.turns} ${m.turns === 1 ? "turn" : "turns"}`);
  if (m.toolCalls > 0) parts.push(`${m.toolCalls} tool calls`);
  if (m.failedToolCalls > 0) parts.push(`${m.failedToolCalls} failed`);
  if (m.input > 0) parts.push(`↑${formatTokens(m.input)}`);
  if (m.output > 0) parts.push(`↓${formatTokens(m.output)}`);
  if (m.cacheRead > 0) parts.push(`R${formatTokens(m.cacheRead)}`);
  if (m.cacheWrite > 0) parts.push(`W${formatTokens(m.cacheWrite)}`);
  if (m.totalTokens > 0) parts.push(`total ${formatTokens(m.totalTokens)}`);
  if (m.cost > 0) parts.push(`$${m.cost.toFixed(4)}`);
  if (m.model) parts.push(m.model);
  if (m.durationMs > 0) {
    if (m.durationMs < 1000) parts.push(`${m.durationMs}ms`);
    else if (m.durationMs < 60000)
      parts.push(`${(m.durationMs / 1000).toFixed(1)}s`);
    else
      parts.push(
        `${Math.floor(m.durationMs / 60000)}m${Math.floor((m.durationMs % 60000) / 1000)}s`,
      );
  }
  return parts.join(" · ");
}
