/**
 * mux — agent-to-agent messaging in zellij.
 *
 * Every pi instance running this extension inside zellij is a peer:
 *
 * - **Addressing** — `mux_send` delivers a message over a per-peer unix
 *   socket; it arrives in the recipient's conversation as a user message
 *   (turn if idle, steered mid-run if busy).
 * - **Broadcasting** — the `mux_send` broadcast action and the
 *   human-typed `/broadcast` slash command fan one message out to every
 *   live peer; the action excludes the sender's own pane, the command
 *   includes it. Agent broadcasts carry a `[mux] from pane …` prefix;
 *   human broadcasts arrive verbatim, like a regular user message.
 * - **Inspection** — `mux_pane` (action read) returns a peer's live state (exact,
 *   mid-stream, from the events this extension already receives) or its
 *   raw screen — on demand, never pushed.
 * - **Spawning** — `mux_spawn` creates a new agent pane/tab with the env
 *   footguns handled (the zellij server's environment lacks the
 *   interactive shell's vars) and the task delivered as an @file message.
 *
 * There is deliberately no parent-child protocol: any two agents are peers,
 * and who-reports-to-whom is a convention carried by prompts and skills.
 * Raw multiplexer control stays in bash (zellij skill).
 *
 * Layout: `index.ts` (this file — lifecycle wiring), `tool.ts` (the mux
 * tools + the `/broadcast` slash command), `socket.ts` (wire protocol,
 * descriptors, listener), `zellij.ts` (raw CLI wrappers — the only
 * multiplexer-specific module).
 *
 * Outside zellij the tool is hidden (`prepareLoadout` +
 * `hiddenDeclarations`, which also drops its guidelines) and nothing
 * listens: zero declaration cost, no listener to leak.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as mux from "./socket.ts";
import { registerMux, type MuxToolDeps } from "./tool.ts";
import * as zellij from "./zellij.ts";

/** Our own pane identity, from what zellij injects into every pane. */
const ZELLIJ_PANE_ID = process.env.ZELLIJ_PANE_ID ?? null;
const ZELLIJ_SESSION_NAME = process.env.ZELLIJ_SESSION_NAME ?? null;
const IN_ZELLIJ = ZELLIJ_PANE_ID !== null && ZELLIJ_SESSION_NAME !== null;

/** Shortest summary rendering of a tool call input, for state replies. */
function renderToolInput(name: string, args: unknown): string {
  let input = "";
  if (
    name === "bash" &&
    args &&
    typeof (args as { command?: unknown }).command === "string"
  ) {
    input = (args as { command: string }).command;
  } else {
    try {
      input = JSON.stringify(args) ?? "";
    } catch {
      input = String(args);
    }
  }
  const flat = input.replace(/\s+/g, " ").trim();
  return flat.length > 120 ? flat.slice(0, 119) + "…" : flat;
}

/** Text parts of a message's content, joined. */
function messageText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const text = (content as Array<{ type?: string; text?: string }>)
    .filter((part) => part?.type === "text")
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();
  return text || null;
}

/**
 * Load-time snapshot of the environment to forward to spawned agents.
 *
 * Panes spawn with the zellij *server's* environment: the interactive
 * shell's PATH never runs there, and pi boots providerless without
 * `PI_CODING_AGENT_DIR`. Snapshot at load — the extension factory is also
 * the only moment the creator's own environment is guaranteed intact.
 * Creator identity (`PI_MUX_PARENT_*`) is added per spawn in the tool.
 */
function snapshotForwardedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (
      key === "PATH" ||
      key === "PI_CODING_AGENT_DIR" ||
      key.startsWith("PI_")
    ) {
      env[key] = value;
    }
  }
  return env;
}

export default function muxExtension(pi: ExtensionAPI): void {
  const envForward = snapshotForwardedEnv();
  const state = new mux.PeerState();
  state.sessionName = ZELLIJ_SESSION_NAME ?? "";

  // ── listener lifecycle ───────────────────────────────────────────────
  // Created on session_start (never from the factory — background
  // resources are forbidden there) and only inside zellij. /reload replaces
  // the runtime: the listener returns at the same deterministic path with a
  // fresh token in the descriptor; senders re-read it per message.

  let server: mux.MuxServer | null = null;
  let currentCtx: ExtensionContext | null = null;

  function stopListener(): void {
    if (server) {
      server.stop(); // Graceful removal: closes + unlinks descriptor and socket.
      server = null;
    }
  }

  async function startListener(): Promise<void> {
    if (!IN_ZELLIJ) return;
    stopListener();
    const paths = mux.muxPaths(
      ZELLIJ_SESSION_NAME!,
      zellij.normalizePaneId(ZELLIJ_PANE_ID!),
    );
    server = new mux.MuxServer({
      paths,
      sessionName: ZELLIJ_SESSION_NAME!,
      state,
      onMessage: (text) => {
        // Idle → triggers a turn; busy → steer the current run (the message
        // enters after the current assistant turn). The delivery mode rides
        // back on the ok reply for the sender's receipt.
        if (currentCtx?.isIdle() ?? true) {
          pi.sendUserMessage(text);
          return "turn";
        }
        pi.sendUserMessage(text, { deliverAs: "steer" });
        return "steer";
      },
    });
    try {
      await server.start();
    } catch (err) {
      server = null;
      currentCtx?.ui.notify(
        `mux: listener failed to start (${err instanceof Error ? err.message : String(err)}) — this peer cannot be addressed; mux_send/mux_pane to others still works.`,
        "error",
      );
    }
  }

  pi.on("session_start", async (event, ctx) => {
    currentCtx = ctx;
    state.sessionFile = ctx.sessionManager.getSessionFile() ?? null;
    state.onAgentSettled(); // Reset transient state for the new runtime.
    adoptParentSession(event, ctx);
    await startListener();
  });

  pi.on("session_shutdown", () => {
    stopListener();
    currentCtx = null;
  });

  /**
   * A pane spawned by mux_spawn (PI_MUX_PARENT_SESSION_FILE is forwarded)
   * links the spawner's session file as its parent, so the session picker
   * nests spawned sessions under their spawner instead of listing every
   * one at the root.
   *
   * Only on a fresh startup, and only while the header carries no parent:
   * a session file is created (header first) only once the first user or
   * assistant message is persisted, so mutating the in-memory header before
   * that flush persists the link — no file rewrite needed. Every other
   * reason is too late or wrong: reload/resume of an already-flushed session
   * cannot be rewritten from here, and /new or /fork in a spawned pane is a
   * new conversation with its own lineage. The guard also keeps /reload
   * from re-adopting on every restart of the same runtime.
   */
  function adoptParentSession(
    event: { reason: "startup" | "reload" | "new" | "resume" | "fork" },
    ctx: ExtensionContext,
  ): void {
    const parentFile = process.env.PI_MUX_PARENT_SESSION_FILE;
    if (!parentFile || event.reason !== "startup") return;
    const header = ctx.sessionManager.getHeader();
    if (header && !header.parentSession) header.parentSession = parentFile;
  }

  // ── peer state wiring ────────────────────────────────────────────────
  // `state` replies are served from events the extension already receives:
  // no polling of our own process, nothing pushed to anyone.

  pi.on("agent_start", () => {
    state.onAgentStart();
  });

  pi.on("agent_settled", () => {
    state.onAgentSettled();
  });

  pi.on("tool_execution_start", (event) => {
    state.onToolStart(
      event.toolCallId,
      event.toolName,
      renderToolInput(event.toolName, event.args),
    );
  });

  pi.on("tool_execution_end", (event) => {
    state.onToolEnd(event.toolCallId);
  });

  pi.on("message_update", (event) => {
    const text = messageText((event.message as { content?: unknown }).content);
    if (text) state.onAssistantStream(text);
  });

  pi.on("message_end", (event) => {
    const message = event.message as { role?: string; content?: unknown };
    state.onMessageEnd(message.role ?? "?", messageText(message.content));
  });

  // ── ambient context injection ────────────────────────────────────────
  // Injected once per runtime, on the first LLM call after session_start:
  // ephemeral (not persisted into the session file, so it never duplicates
  // across /reload or /resume), and re-derived after every session switch.

  let contextInjected = false;
  pi.on("context", async (event) => {
    if (contextInjected) return;
    contextInjected = true;
    if (!IN_ZELLIJ) return;

    const lines = [
      `[mux] You are a pi agent running in zellij pane ${zellij.normalizePaneId(ZELLIJ_PANE_ID!)} (zellij session "${ZELLIJ_SESSION_NAME}").`,
      `Other agent panes in this zellij session are peers, addressable with the mux tools: mux_list (discover them), mux_send pane=<id> (deliver a message that arrives as a user message), mux_pane action=read pane=<id> (inspect live state or screen).`,
    ];
    if (process.env.PI_MUX_PARENT_PANE) {
      lines.push(
        `[mux] You were spawned by the agent in pane ${process.env.PI_MUX_PARENT_PANE} (zellij session "${process.env.PI_MUX_PARENT_ZELLIJ_SESSION ?? "?"}", cwd ${process.env.PI_MUX_PARENT_CWD ?? "?"}). You are peers, not parent and child: reach them with mux_send pane=${process.env.PI_MUX_PARENT_PANE}, inspect them with mux_pane action=read. Whether and when to report back is set by your task, not by the extension.`,
      );
    }
    return {
      messages: [
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: lines.join("\n") }],
          timestamp: Date.now(),
        },
        ...event.messages,
      ],
    };
  });

  // ── the tool ─────────────────────────────────────────────────────────

  const deps: MuxToolDeps = {
    ownPaneId: IN_ZELLIJ ? zellij.normalizePaneId(ZELLIJ_PANE_ID!) : null,
    sessionName: ZELLIJ_SESSION_NAME,
    envForward,
  };
  registerMux(pi, deps);
}
