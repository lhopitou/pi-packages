/**
 * pi-worktree — status tracking for parallel git-worktree pi agents.
 *
 * Two modes:
 *
 * 1. Reporter mode (worktree agent): active when PI_WORKTREE_STATUS_DIR and
 *    PI_WORKTREE_HANDLE are set (done by the worktree skill's spawn command).
 *    Writes a status JSON file on session/agent events and renames its own
 *    tab+pane (zellij) or window (tmux) with a ●/✓ state marker.
 *
 * 2. Coordinator mode (main session): active when the env vars are absent.
 *    Registers `worktree_status` and `worktree_wait` tools that read the
 *    status directory of the current project's worktrees.
 *
 * Status files live at `<project>__worktrees/.status/<handle>.json` and are
 * deleted by the merge/remove workflow.
 */

import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

// ── Shared types ─────────────────────────────────────────────────────

type Mux = "zellij" | "tmux" | null;

interface WorktreeStatus {
  handle: string;
  state: "working" | "done";
  /** Set to "aborted" when the last run was interrupted; state stays "working". */
  stopReason: string | null;
  pid: number;
  mux: Mux;
  /** Pane id: zellij `terminal_N` or tmux `%N`. */
  paneTarget: string | null;
  /** Multiplexer session name. */
  session: string | null;
  /** Path to the agent's session JSONL (set at session_start). */
  sessionFile: string | null;
  startedAt: number;
  updatedAt: number;
}

/**
 * Effective states. "interrupted" (aborted, awaiting user input) is a display
 * state only: worktree_wait keeps treating such agents as working until
 * they finish, die, or the timeout hits.
 */
type Effective = "working" | "done" | "crashed" | "interrupted";

const WAIT_SETTLED: ReadonlySet<Effective> = new Set(["done", "crashed"]);
const POLL_INTERVAL_MS = 2000;
const DEFAULT_TIMEOUT_S = 3600;

const STATUS_DIR = process.env.PI_WORKTREE_STATUS_DIR ?? null;
const HANDLE = process.env.PI_WORKTREE_HANDLE ?? null;

function run(cmd: string, args: string[], timeoutMs = 5000): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout) => {
      resolve(err ? "" : String(stdout).trim());
    });
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}

function pidAlive(pid?: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but is owned by someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function effectiveState(status: WorktreeStatus, alive: boolean): Effective {
  if (status.state === "done") return "done";
  if (!alive) return "crashed";
  if (status.stopReason === "aborted") return "interrupted";
  return "working";
}

export default function worktreeExtension(pi: ExtensionAPI) {
  if (STATUS_DIR && HANDLE) {
    registerReporter(pi);
  } else {
    registerCoordinator(pi);
  }
}

// ── Reporter mode ─────────────────────────────────────────────────────

function registerReporter(pi: ExtensionAPI) {
  const statusFile = join(STATUS_DIR!, `${HANDLE}.json`);
  const mux: Mux = process.env.ZELLIJ_PANE_ID
    ? "zellij"
    : process.env.TMUX_PANE
      ? "tmux"
      : null;
  const paneTarget =
    process.env.ZELLIJ_PANE_ID ?? process.env.TMUX_PANE ?? null;

  const status: WorktreeStatus = {
    handle: HANDLE!,
    state: "working",
    stopReason: null,
    pid: process.pid,
    mux,
    paneTarget,
    session: process.env.ZELLIJ_SESSION_NAME ?? null,
    sessionFile: null,
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };

  let tmuxWindowId: string | null = null;
  let zellijTabId: number | null = null;
  let zellijTabIdResolved = false;

  function flush() {
    status.updatedAt = Date.now();
    mkdirSync(STATUS_DIR!, { recursive: true });
    writeFileSync(statusFile, JSON.stringify(status, null, 2) + "\n");
  }

  /** Map our pane id ("148" or "terminal_148") to its tab's stable id. */
  function findZellijTabId(listPanesJson: string): number | null {
    try {
      const panes = JSON.parse(listPanesJson) as Array<{
        id?: number;
        is_plugin?: boolean;
        tab_id?: number;
      }>;
      const numeric = Number(paneTarget!.replace(/^(terminal|plugin)_/, ""));
      const pane = panes.find(
        (p) => !p.is_plugin && p.id === numeric && p.tab_id != null,
      );
      return pane?.tab_id ?? null;
    } catch {
      return null;
    }
  }

  async function rename(marker: string) {
    const label = `${marker} wt-${HANDLE}`;
    if (mux === "zellij" && paneTarget) {
      await run("zellij", [
        "action",
        "rename-pane",
        "--pane-id",
        paneTarget,
        label,
      ]);
      // Pane names are only visible when pane frames are drawn (multi-pane
      // tabs). Rename the tab too so the marker shows in the tab bar.
      if (!zellijTabIdResolved) {
        zellijTabIdResolved = true;
        zellijTabId = findZellijTabId(
          await run("zellij", ["action", "list-panes", "--tab", "--json"]),
        );
      }
      if (zellijTabId !== null) {
        await run("zellij", [
          "action",
          "rename-tab",
          "--tab-id",
          String(zellijTabId),
          label,
        ]);
      }
    } else if (mux === "tmux" && paneTarget) {
      if (!tmuxWindowId) {
        tmuxWindowId =
          (await run("tmux", [
            "display-message",
            "-p",
            "-t",
            paneTarget,
            "#{window_id}",
          ])) || null;
      }
      if (tmuxWindowId) {
        await run("tmux", ["rename-window", "-t", tmuxWindowId, label]);
      }
    }
  }

  function latestAssistantWasAborted(ctx: ExtensionContext): boolean {
    const branch = ctx.sessionManager.getBranch() as Array<{
      type?: string;
      message?: { role?: string; stopReason?: string; errorMessage?: string };
    }>;
    for (let index = branch.length - 1; index >= 0; index--) {
      const entry = branch[index];
      if (entry?.type !== "message" || entry.message?.role !== "assistant")
        continue;
      return (
        entry.message.stopReason === "aborted" ||
        (entry.message.stopReason === "error" &&
          /\boperation was aborted\b/i.test(entry.message.errorMessage ?? ""))
      );
    }
    return false;
  }

  pi.on("session_start", async (_event, ctx) => {
    status.sessionFile = ctx.sessionManager.getSessionFile() ?? null;
    if (mux === "tmux" && paneTarget && !status.session) {
      status.session =
        (await run("tmux", [
          "display-message",
          "-p",
          "-t",
          paneTarget,
          "#{session_name}",
        ])) || null;
    }
    flush();
    await rename("●");
  });

  pi.on("agent_start", async () => {
    status.state = "working";
    status.stopReason = null;
    flush();
    await rename("●");
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (latestAssistantWasAborted(ctx)) {
      // Interrupted by the user: keep state "working" — they may re-engage.
      // The recorded stopReason lets worktree_status report "interrupted".
      // worktree_wait keeps treating this agent as working until it settles.
      status.stopReason = "aborted";
      flush();
      return;
    }
    status.state = "done";
    status.stopReason = null;
    flush();
    await rename("✓");
  });
}

// ── Coordinator mode ──────────────────────────────────────────────────

interface AgentInfo {
  handle: string;
  status: WorktreeStatus;
  effective: Effective;
  alive: boolean;
}

function readAgents(statusDir: string): AgentInfo[] {
  if (!existsSync(statusDir)) return [];
  const agents: AgentInfo[] = [];
  for (const file of readdirSync(statusDir)) {
    if (!file.endsWith(".json")) continue;
    try {
      const status = JSON.parse(
        readFileSync(join(statusDir, file), "utf8"),
      ) as WorktreeStatus;
      if (!status.handle) continue;
      const alive = pidAlive(status.pid);
      agents.push({
        handle: status.handle,
        status,
        effective: effectiveState(status, alive),
        alive,
      });
    } catch {
      // Skip unreadable/partial writes.
    }
  }
  agents.sort((a, b) => a.handle.localeCompare(b.handle));
  return agents;
}

async function findStatusDir(): Promise<{
  dir: string | null;
  root: string | null;
  expected: string | null;
}> {
  const root = await run("git", ["rev-parse", "--show-toplevel"]);
  if (!root) return { dir: null, root: null, expected: null };
  const expected = join(
    dirname(root),
    `${basename(root)}__worktrees`,
    ".status",
  );
  return { dir: existsSync(expected) ? expected : null, root, expected };
}

function formatAgent(a: AgentInfo): string {
  const age = Math.round((Date.now() - a.status.startedAt) / 1000);
  const mins = Math.floor(age / 60);
  const ageStr = mins > 0 ? `${mins}m` : `${age}s`;
  const bits = [
    `state=${a.status.state}`,
    a.status.stopReason ? `stopReason=${a.status.stopReason}` : null,
    a.alive ? `pid=${a.status.pid}` : `pid=${a.status.pid} DEAD`,
    a.status.mux ? `${a.status.mux}:${a.status.paneTarget}` : null,
    a.status.session ? `session=${a.status.session}` : null,
  ]
    .filter(Boolean)
    .join(" ");
  const note =
    a.effective === "crashed"
      ? " — CRASHED (process is dead but status says working)"
      : a.effective === "interrupted"
        ? " — INTERRUPTED (aborted, awaiting user input)"
        : "";
  return `${a.handle}: ${a.effective} (${ageStr} old; ${bits})${note}`;
}

// ── worktree_message helpers ───────────────────────────────────────────

interface AssistantSnapshot {
  text: string;
  timestamp: string;
  model: string;
  stopReason: string;
}

/**
 * Read the last `count` assistant messages that carry text from a session
 * JSONL, scanning backwards. Skips malformed lines (partial writes) and
 * tool-call-only assistant messages.
 */
function readAssistantMessages(
  sessionFile: string,
  count: number,
): AssistantSnapshot[] {
  let content: string;
  try {
    content = readFileSync(sessionFile, "utf8");
  } catch {
    return [];
  }
  const lines = content.split("\n");
  const out: AssistantSnapshot[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < count; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry: {
      type?: string;
      timestamp?: string;
      message?: {
        role?: string;
        content?: Array<{ type?: string; text?: string }>;
        provider?: string;
        model?: string;
        stopReason?: string;
      };
    };
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // partial write — skip
    }
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (message?.role !== "assistant") continue;
    const text = (message.content ?? [])
      .filter((c) => c?.type === "text")
      .map((c) => c.text ?? "")
      .join("\n")
      .trim();
    if (!text) continue; // tool-call-only assistant message
    out.push({
      text,
      timestamp: entry.timestamp ?? "",
      model: `${message.provider ?? "?"}/${message.model ?? "?"}`,
      stopReason: message.stopReason ?? "?",
    });
  }
  return out.reverse(); // oldest first
}

/**
 * Resolve the session file for an agent. Uses the sessionFile recorded in its
 * status file; falls back to the most recent session for the worktree cwd
 * (covers agents spawned before sessionFile tracking, or removed files).
 */
async function resolveSessionFile(
  agent: AgentInfo,
  statusDir: string,
): Promise<string | null> {
  if (agent.status.sessionFile && existsSync(agent.status.sessionFile)) {
    return agent.status.sessionFile;
  }
  const worktreeCwd = join(dirname(statusDir), agent.handle);
  try {
    const sessions = await SessionManager.list(worktreeCwd);
    if (sessions.length) {
      sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
      return sessions[0].path;
    }
  } catch {
    // Best-effort fallback: no session directory for this worktree.
  }
  return null;
}

// ── worktree_wait rendering (bash-style) ───────────────────────────────

interface WaitRenderState {
  startedAt?: number;
  endedAt?: number;
  interval?: ReturnType<typeof setInterval>;
}

function formatWaitDuration(ms: number): string {
  const secs = ms / 1000;
  if (secs < 60) return `${secs.toFixed(1)}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${Math.round(secs % 60)}s`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}

function registerCoordinator(pi: ExtensionAPI) {
  pi.registerTool({
    name: "worktree_status",
    label: "Worktree agent status",
    description:
      "List parallel worktree agents for the current project and their live status: " +
      "working, done, crashed (process died while working), or interrupted (aborted, awaiting input). " +
      "Use before and while coordinating worktree agents.",
    promptSnippet:
      "List worktree agents and their live status (working/done/crashed/interrupted)",
    parameters: Type.Object({
      handles: Type.Optional(
        Type.Array(Type.String(), {
          description: "Restrict to these handles. Default: all.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { dir, root, expected } = await findStatusDir();
      if (!root) {
        return {
          content: [
            {
              type: "text",
              text: "Not inside a git repository — cannot resolve worktree status dir.",
            },
          ],
          details: {},
        };
      }
      if (!dir) {
        return {
          content: [
            {
              type: "text",
              text: `No worktree agents (no status dir at ${expected}).`,
            },
          ],
          details: {},
        };
      }
      let agents = readAgents(dir);
      if (params.handles?.length) {
        const wanted = new Set(params.handles);
        const unknown = params.handles.filter(
          (h) => !agents.some((a) => a.handle === h),
        );
        agents = agents.filter((a) => wanted.has(a.handle));
        if (unknown.length) {
          const lines = [
            `Unknown handle(s): ${unknown.join(", ")}`,
            `Known handles: ${
              readAgents(dir)
                .map((a) => a.handle)
                .join(", ") || "(none)"
            }`,
          ];
          if (!agents.length)
            return {
              content: [{ type: "text", text: lines.join("\n") }],
              details: {},
            };
          lines.push("", ...agents.map(formatAgent));
          return {
            content: [{ type: "text", text: lines.join("\n") }],
            details: {},
          };
        }
      }
      if (!agents.length) {
        return {
          content: [
            { type: "text", text: `No worktree agents found in ${dir}.` },
          ],
          details: {},
        };
      }
      return {
        content: [{ type: "text", text: agents.map(formatAgent).join("\n") }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "worktree_message",
    label: "Worktree agent message",
    description:
      "Read the latest assistant message(s) from a worktree agent's session file. " +
      "Works for working, done, crashed, and interrupted agents. Use to review " +
      "agent output instead of capturing the multiplexer pane.",
    promptSnippet:
      "Read the latest assistant message(s) from a worktree agent's session",
    parameters: Type.Object({
      handle: Type.String({ description: "Worktree agent handle." }),
      count: Type.Optional(
        Type.Number({
          description:
            "Number of recent assistant messages to return. Default: 1.",
        }),
      ),
    }),
    renderCall(args, theme, context) {
      const text =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      let content =
        theme.fg("toolTitle", theme.bold("worktree_message ")) +
        theme.fg("toolTitle", args.handle ?? "...");
      if (args.count !== undefined) {
        content += theme.fg("muted", ` (last ${args.count})`);
      }
      text.setText(content);
      return text;
    },
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { dir, root, expected } = await findStatusDir();
      if (!root) {
        return {
          content: [
            {
              type: "text",
              text: "Not inside a git repository — cannot resolve worktree status dir.",
            },
          ],
          details: {},
        };
      }
      if (!dir) {
        return {
          content: [
            {
              type: "text",
              text: `No worktree agents (no status dir at ${expected}).`,
            },
          ],
          details: {},
        };
      }
      const agents = readAgents(dir);
      const agent = agents.find((a) => a.handle === params.handle);
      if (!agent) {
        return {
          content: [
            {
              type: "text",
              text:
                `Unknown handle: ${params.handle}\n` +
                `Known handles: ${
                  agents.map((a) => a.handle).join(", ") || "(none)"
                }`,
            },
          ],
          details: {},
        };
      }

      const count = Math.max(1, Math.floor(params.count ?? 1));
      const sessionFile = await resolveSessionFile(agent, dir);
      if (!sessionFile) {
        return {
          content: [
            {
              type: "text",
              text:
                `No session file found for ${agent.handle} (no sessionFile in ` +
                `status and no sessions for its worktree directory). The agent ` +
                `may not have started yet, or its session is ephemeral.`,
            },
          ],
          details: { handle: agent.handle, effective: agent.effective },
        };
      }

      const messages = readAssistantMessages(sessionFile, count);
      if (!messages.length) {
        return {
          content: [
            {
              type: "text",
              text:
                `No assistant messages yet in ${agent.handle}'s session ` +
                `(state: ${agent.effective}). The agent may still be starting ` +
                `or has only emitted tool calls so far.`,
            },
          ],
          details: {
            handle: agent.handle,
            sessionFile,
            effective: agent.effective,
          },
        };
      }

      const blocks = messages.map((m) => m.text);
      const header =
        messages.length === 1
          ? `wt-${agent.handle} — last assistant message (state: ${agent.effective}):`
          : `wt-${agent.handle} — ${messages.length} most recent assistant messages (state: ${agent.effective}), oldest first:`;
      return {
        content: [
          { type: "text", text: `${header}\n\n${blocks.join("\n\n────\n\n")}` },
        ],
        details: {
          handle: agent.handle,
          sessionFile,
          effective: agent.effective,
          stopReason: messages[messages.length - 1].stopReason,
          count: messages.length,
        },
      };
    },
  });

  pi.registerTool({
    name: "worktree_wait",
    label: "Wait for worktree agents",
    description:
      "Block until worktree agents settle: done (finished) or crashed (process died). " +
      "Interrupted agents (aborted, awaiting user input) still count as working — the wait " +
      "continues until they finish, die, or the timeout hits. Polls status files. Use after " +
      "spawning agents and between merge rounds.",
    promptSnippet:
      "Block until worktree agents settle (done/crashed), with any/timeout options",
    parameters: Type.Object({
      handles: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Handles to wait for. Default: all agents currently known.",
        }),
      ),
      any: Type.Optional(
        Type.Boolean({
          description:
            "Return as soon as the FIRST agent settles instead of waiting for all. " +
            "Recommended when multiple agents run: review and merge each finisher immediately.",
        }),
      ),
      timeoutSeconds: Type.Optional(
        Type.Number({
          description: `Give up after this many seconds. Default: ${DEFAULT_TIMEOUT_S}.`,
        }),
      ),
    }),
    renderCall(args, theme, context) {
      const state = context.state as WaitRenderState;
      if (context.executionStarted && state.startedAt === undefined) {
        state.startedAt = Date.now();
        state.endedAt = undefined;
      }
      const text =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);

      const target = args.handles?.length
        ? args.handles.join(", ")
        : context.argsComplete
          ? "all agents"
          : "...";
      const flags: string[] = [];
      if (args.any) flags.push("any");
      if (args.timeoutSeconds !== undefined)
        flags.push(`timeout ${args.timeoutSeconds}s`);
      let content =
        theme.fg("toolTitle", theme.bold("worktree_wait ")) +
        theme.fg("toolTitle", target);
      if (flags.length) content += theme.fg("muted", ` (${flags.join(", ")})`);

      // Live elapsed timer, bash-style. The result slot stays empty until the
      // first onUpdate, so the header is the only place to show progress.
      if (state.startedAt !== undefined) {
        const done = state.endedAt !== undefined;
        const label = done ? " — took " : " — ";
        content += theme.fg(
          "muted",
          `${label}${formatWaitDuration((state.endedAt ?? Date.now()) - state.startedAt)}`,
        );
        if (!done && !state.interval) {
          state.interval = setInterval(() => context.invalidate(), 1000);
          state.interval.unref?.();
        }
      }
      text.setText(content);
      return text;
    },
    renderResult(result, options, theme, context) {
      const state = context.state as WaitRenderState;
      if (!options.isPartial || context.isError) {
        if (state.interval) {
          clearInterval(state.interval);
          state.interval = undefined;
        }
        if (state.startedAt !== undefined && state.endedAt === undefined) {
          state.endedAt = Date.now();
          // Freeze the header's timer at the final duration with one extra
          // render pass. Deferred because context.invalidate() synchronously
          // re-enters updateDisplay() mid-render: called inline it recursed
          // until the stack overflowed and stacked one copy of the result
          // component per level, printing the timeout message many times.
          queueMicrotask(() => context.invalidate());
        }
      }
      const text =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const output = result.content
        .filter((c) => c.type === "text")
        .map((c) => (c as { text: string }).text)
        .join("\n")
        .trim();
      text.setText(
        output
          ? output
              .split("\n")
              .map((line) => theme.fg("toolOutput", line))
              .join("\n")
          : "",
      );
      return text;
    },
    async execute(_toolCallId, params, signal, onUpdate, _ctx) {
      const { dir, root } = await findStatusDir();
      if (!root || !dir) {
        return {
          content: [
            {
              type: "text",
              text: "No worktree agent status dir found — nothing to wait on.",
            },
          ],
          details: {},
        };
      }
      const all = readAgents(dir);
      let handles = params.handles?.length
        ? params.handles
        : all.map((a) => a.handle);
      if (!handles.length) {
        return {
          content: [
            {
              type: "text",
              text: `No worktree agents found in ${dir} — nothing to wait on.`,
            },
          ],
          details: {},
        };
      }
      const unknown = handles.filter((h) => !all.some((a) => a.handle === h));
      if (unknown.length) {
        return {
          content: [
            {
              type: "text",
              text:
                `Unknown handle(s): ${unknown.join(", ")}\n` +
                `Known handles: ${all.map((a) => a.handle).join(", ") || "(none)"}`,
            },
          ],
          details: {},
        };
      }
      const timeoutMs = (params.timeoutSeconds ?? DEFAULT_TIMEOUT_S) * 1000;
      const deadline = Date.now() + timeoutMs;
      const pending = new Set(handles);
      const outcomes: string[] = [];

      try {
        while (pending.size > 0) {
          if (signal?.aborted) break;
          const agents = readAgents(dir);
          const present = new Map(agents.map((a) => [a.handle, a]));
          const changed: string[] = [];
          for (const handle of [...pending]) {
            const a = present.get(handle);
            if (!a) {
              // Status file vanished mid-wait: merged or removed — treat as settled.
              pending.delete(handle);
              changed.push(handle);
              outcomes.push(
                `${handle}: gone (status file removed — merged or removed)`,
              );
              continue;
            }
            if (WAIT_SETTLED.has(a.effective)) {
              pending.delete(handle);
              changed.push(handle);
              outcomes.push(formatAgent(a));
            }
          }
          if (changed.length) {
            const total = handles.length;
            const settled = total - pending.size;
            onUpdate?.({
              content: [
                {
                  type: "text",
                  text: `Settled: ${changed.join(", ")} (${settled}/${total}). Waiting for: ${[...pending].join(", ") || "none"}...`,
                },
              ],
              details: {},
            });
            if (params.any) break;
            if (pending.size === 0) break;
          }
          if (Date.now() >= deadline) break;
          await sleep(POLL_INTERVAL_MS, signal);
        }
      } catch {
        // sleep aborted
      }

      if (signal?.aborted) {
        return {
          content: [
            {
              type: "text",
              text:
                `Wait aborted by user. Settled so far:\n${outcomes.join("\n") || "(none)"}\n` +
                `Still working: ${[...pending].join(", ") || "(none)"}`,
            },
          ],
          details: { aborted: true },
        };
      }

      const timedOut = pending.size > 0;
      const header = timedOut
        ? `Timed out after ${params.timeoutSeconds ?? DEFAULT_TIMEOUT_S}s. Still working: ${[...pending].join(", ")}`
        : params.any
          ? "First agent settled:"
          : "All agents settled:";
      return {
        content: [{ type: "text", text: `${header}\n${outcomes.join("\n")}` }],
        details: {
          timedOut,
          settled: handles.length - pending.size,
          total: handles.length,
        },
      };
    },
  });
}
