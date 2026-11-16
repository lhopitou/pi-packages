/**
 * socket — the mux wire protocol, peer descriptor, and unix-socket server.
 *
 * Every pi agent running mux inside zellij is a peer:
 *
 * 1. Listens on a unix socket at `$TMPDIR/pi-mux/<zellij-session>/<pane>.sock`.
 * 2. Publishes a descriptor at `$TMPDIR/pi-mux/<zellij-session>/<pane>.json`
 *    (mode 0600): `{ socketPath, token, pid, sessionName, startedAt }`.
 * 3. Serves two request types (connect–send–close, one NDJSON line per
 *    request, one reply line): `message` (inject as user message —
 *    agent-to-agent with a `[mux] from pane …` provenance prefix,
 *    `human` messages verbatim, as if typed) and `state` (live
 *    activity snapshot).
 *
 * Discovery is a pure function of the pane id: senders re-read the target
 * descriptor for every request (fresh token), so a /reload costs at worst a
 * brief window of delivery failures, not a protocol event.
 *
 * Descriptor lifecycle: best-effort removal at the source (session_shutdown)
 * plus authoritative verification at every use — hot path (`send`, `read`)
 * checks `kill(pid, 0)`, cold path (`list`) additionally correlates against
 * `zellij action list-panes`. Prunes re-read the descriptor immediately
 * before unlinking and abort if the on-disk pid changed (a /reload raced
 * us and rewrote the file — unlinking would drop a live peer).
 */

import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

// ── Paths ──────────────────────────────────────────────────────────────

export interface MuxPaths {
  dir: string;
  socketPath: string;
  descriptorPath: string;
}

/** Per-zellij-session descriptor directory: `$TMPDIR/pi-mux/<session>`. */
export function muxDir(sessionName: string): string {
  return join(tmpdir(), "pi-mux", sessionName);
}

/** Deterministic per-(session, pane) paths; discovery needs no registry. */
export function muxPaths(sessionName: string, paneId: string): MuxPaths {
  const dir = muxDir(sessionName);
  return {
    dir,
    socketPath: join(dir, `${paneId}.sock`),
    descriptorPath: join(dir, `${paneId}.json`),
  };
}

// ── Descriptor ─────────────────────────────────────────────────────────

export interface MuxDescriptor {
  socketPath: string;
  token: string;
  pid: number;
  sessionName: string;
  startedAt: number;
}

/** Read and validate a descriptor; null when absent or malformed. */
export function readDescriptor(path: string): MuxDescriptor | null {
  try {
    const raw = JSON.parse(
      readFileSync(path, "utf8"),
    ) as Partial<MuxDescriptor>;
    const pid = raw.pid;
    if (
      typeof raw.socketPath !== "string" ||
      typeof raw.token !== "string" ||
      typeof pid !== "number" ||
      !Number.isInteger(pid)
    ) {
      return null;
    }
    return {
      socketPath: raw.socketPath,
      token: raw.token,
      pid,
      sessionName: typeof raw.sessionName === "string" ? raw.sessionName : "",
      startedAt: typeof raw.startedAt === "number" ? raw.startedAt : 0,
    };
  } catch {
    return null;
  }
}

/** Every descriptor file in a session dir, keyed by bare pane id. */
export function listDescriptors(dir: string): Array<{
  paneId: string;
  path: string;
  descriptor: MuxDescriptor;
}> {
  const out: Array<{
    paneId: string;
    path: string;
    descriptor: MuxDescriptor;
  }> = [];
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return out;
  }
  for (const file of files) {
    if (!/^\d+\.json$/.test(file)) continue;
    const path = join(dir, file);
    const descriptor = readDescriptor(path);
    if (descriptor)
      out.push({ paneId: file.replace(/\.json$/, ""), path, descriptor });
  }
  return out;
}

/** Unlink a peer's descriptor and socket. Same-user, idempotent, race-safe. */
export function pruneFiles(paths: MuxPaths): void {
  try {
    rmSync(paths.socketPath);
  } catch {
    // ENOENT: concurrent prune, or the peer cleaned up. Ignore.
  }
  try {
    rmSync(paths.descriptorPath);
  } catch {
    // Ditto.
  }
}

/** Fresh per-runtime auth token. Rotates on every /reload. */
export function newToken(): string {
  return randomBytes(24).toString("hex");
}

// ── pid liveness ───────────────────────────────────────────────────────

/**
 * Signal-0 liveness check. EPERM counts as alive (the process exists but is
 * owned by another user). Catches killed/crashed peers whose pane still
 * shows `exited`; it cannot catch pid reuse — `list` adds the pane-existence
 * signal for that.
 */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// ── Wire types ─────────────────────────────────────────────────────────

export interface MessageRequest {
  type: "message";
  token: string;
  /** Origin pane id (bare number), as reported to the recipient. */
  fromPane: string;
  fromSessionName: string;
  text: string;
  /**
   * Human-typed message (the `/broadcast` slash command): injected
   * verbatim, as a regular user message — no `[mux] from pane …`
   * prefix. Absent → agent-to-agent → prefixed with the origin pane.
   */
  human?: boolean;
}

export interface StateRequest {
  type: "state";
  token: string;
}

export type MuxRequest = MessageRequest | StateRequest;

export interface OkReply {
  type: "ok";
  /** How the recipient delivered a message: turn while idle, steer if busy. */
  delivery?: "turn" | "steer";
}

export interface ErrorReply {
  type: "error";
  error: string;
}

export interface StateReply {
  type: "state";
  state: "idle" | "working";
  currentToolCall: {
    name: string;
    /** Truncated single-line rendering of the input (e.g. the bash command). */
    input: string;
    runningMs: number;
  } | null;
  /** Tail of the assistant text currently streaming, if any. */
  streamingTail: string;
  lastUserMessage: string | null;
  lastAssistantText: string | null;
  sessionFile: string | null;
  sessionName: string;
}

export type MuxReply = OkReply | ErrorReply | StateReply;

// ── Live peer state ────────────────────────────────────────────────────

/**
 * What this peer is doing right now, assembled from events the extension
 * already receives. Served on demand from the socket; never pushed.
 */
export class PeerState {
  private working = false;
  /** Active tool calls by id; parallel calls all register, snapshot shows the longest-running. */
  private readonly activeCalls = new Map<
    string,
    { name: string; input: string; startedAt: number }
  >();
  private streamingTail = "";
  private lastUserMessage: string | null = null;
  private lastAssistantText: string | null = null;
  sessionFile: string | null = null;
  sessionName = "";

  onAgentStart(): void {
    this.working = true;
  }

  onAgentSettled(): void {
    this.working = false;
    this.activeCalls.clear();
    this.streamingTail = "";
  }

  onToolStart(toolCallId: string, name: string, input: string): void {
    this.activeCalls.set(toolCallId, { name, input, startedAt: Date.now() });
  }

  onToolEnd(toolCallId: string): void {
    this.activeCalls.delete(toolCallId);
  }

  /** Assistant streaming text: keep a short tail. */
  onAssistantStream(text: string): void {
    this.streamingTail = text.length > 300 ? text.slice(-300) : text;
  }

  onMessageEnd(role: string, text: string | null): void {
    if (text === null) return;
    if (role === "user") this.lastUserMessage = text;
    else if (role === "assistant") {
      this.lastAssistantText = text;
      this.streamingTail = "";
    }
  }

  snapshot(): StateReply {
    let current: { name: string; input: string; startedAt: number } | null =
      null;
    for (const call of this.activeCalls.values()) {
      if (!current || call.startedAt < current.startedAt) current = call;
    }
    return {
      type: "state",
      state: this.working ? "working" : "idle",
      currentToolCall: current
        ? {
            name: current.name,
            input: current.input,
            runningMs: Math.max(0, Date.now() - current.startedAt),
          }
        : null,
      streamingTail: this.streamingTail,
      lastUserMessage: this.lastUserMessage,
      lastAssistantText: this.lastAssistantText,
      sessionFile: this.sessionFile,
      sessionName: this.sessionName,
    };
  }
}

/**
 * Compact rendered summary line of a state reply — `idle`, or
 * `working: bash — cargo test (41s)`. This is what `wait_for` patterns
 * match against for view "state", which is what makes
 * `wait_for: "^idle$"` meaningful.
 */
export function renderStateSummary(reply: StateReply): string {
  if (reply.state !== "working") return "idle";
  const call = reply.currentToolCall;
  if (!call) return "working: no active tool call";
  return `working: ${call.name} — ${call.input} (${Math.round(call.runningMs / 1000)}s)`;
}

// ── Server ─────────────────────────────────────────────────────────────

export interface MuxServerOptions {
  paths: MuxPaths;
  sessionName: string;
  state: PeerState;
  /**
   * Inject a delivered message into the agent loop. Receives the already
   * formatted text; returns how it was delivered ("turn" when idle,
   * "steer" when busy) for the delivery receipt.
   */
  onMessage: (text: string) => "turn" | "steer";
}

/**
 * The per-peer listener. Created on session_start (never from the factory —
 * background resources are forbidden there), removed on session_shutdown.
 */
export class MuxServer {
  private token = "";
  private listening = false;
  private stopServer: () => void = () => {};
  private readonly opts: MuxServerOptions;

  constructor(opts: MuxServerOptions) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    const { paths } = this.opts;
    this.token = newToken();
    mkdirSync(paths.dir, { recursive: true });
    // Stale socket from a crashed process would make listen() fail; it is
    // garbage by definition (the descriptor's pid is dead or rewritten).
    try {
      rmSync(paths.socketPath);
    } catch {
      // Absent — fine.
    }
    const descriptor: MuxDescriptor = {
      socketPath: paths.socketPath,
      token: this.token,
      pid: process.pid,
      sessionName: this.opts.sessionName,
      startedAt: Date.now(),
    };
    writeFileSync(
      paths.descriptorPath,
      JSON.stringify(descriptor, null, 2) + "\n",
      {
        mode: 0o600,
      },
    );
    await new Promise<void>((resolve, reject) => {
      const server = createServer((socket) => this.onConnection(socket));
      server.once("error", reject);
      server.listen(paths.socketPath, () => {
        server.removeListener("error", reject);
        // Same-user hardening; the honest threat model is the OS account.
        try {
          chmodSync(paths.socketPath, 0o600);
        } catch {
          // Best-effort only.
        }
        resolve();
      });
      this.stopServer = () => {
        try {
          server.close();
        } catch {
          // Already closed.
        }
      };
    });
    this.listening = true;
  }

  /** Close the listener and unlink descriptor + socket (best effort). */
  stop(): void {
    this.listening = false;
    this.stopServer();
    pruneFiles(this.opts.paths);
  }

  private onConnection(socket: Socket): void {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        void this.dispatch(line)
          .then((reply) => {
            try {
              socket.write(JSON.stringify(reply) + "\n");
            } catch {
              // Sender hung up; the message was still delivered.
            }
          })
          .catch((err: unknown) => {
            try {
              socket.write(
                JSON.stringify({
                  type: "error",
                  error: err instanceof Error ? err.message : String(err),
                } satisfies ErrorReply) + "\n",
              );
            } catch {
              // Sender hung up.
            }
          });
      }
    });
    socket.on("error", () => {
      // Sender closed early. Nothing to clean up: delivery is stateless.
    });
  }

  private async dispatch(line: string): Promise<MuxReply> {
    let request: MuxRequest;
    try {
      request = JSON.parse(line) as MuxRequest;
    } catch {
      return { type: "error", error: "request is not valid JSON" };
    }
    if (request?.type !== "message" && request?.type !== "state") {
      return {
        type: "error",
        error: `unknown request type: ${JSON.stringify((request as { type?: unknown })?.type)}`,
      };
    }
    if (request.token !== this.token) {
      return { type: "error", error: "token mismatch" };
    }
    if (request.type === "state") {
      return this.opts.state.snapshot();
    }
    // Human messages (the /broadcast command) arrive verbatim, like a
    // regular user message; agent-to-agent messages carry provenance.
    const text = request.human
      ? request.text
      : `[mux] from pane ${request.fromPane} (${request.fromSessionName}): ${request.text}`;
    try {
      return { type: "ok", delivery: this.opts.onMessage(text) };
    } catch (err) {
      return {
        type: "error",
        error: `injection failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}

// ── Client ─────────────────────────────────────────────────────────────

/**
 * Connect–send–close request: write one NDJSON line, read one reply line.
 * Rejects on connect errors (callers distinguish ECONNREFUSED), timeouts,
 * and truncated replies.
 */
export function muxRequest(
  socketPath: string,
  request: MuxRequest,
  timeoutMs = 5_000,
): Promise<MuxReply> {
  return new Promise<MuxReply>((resolve, reject) => {
    let settled = false;
    let buffer = "";
    const socket = connect({ path: socketPath });
    socket.setEncoding("utf8");
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      settle();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error("mux socket request timed out"))),
      timeoutMs,
    );
    socket.on("connect", () => {
      socket.write(JSON.stringify(request) + "\n");
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const nl = buffer.indexOf("\n");
      if (nl < 0) return;
      const line = buffer.slice(0, nl);
      finish(() => {
        try {
          const reply = JSON.parse(line) as MuxReply;
          if (
            reply &&
            (reply.type === "ok" ||
              reply.type === "error" ||
              reply.type === "state")
          ) {
            resolve(reply);
          } else {
            reject(new Error(`invalid mux reply: ${line.slice(0, 200)}`));
          }
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
    socket.on("error", (err: Error) => finish(() => reject(err)));
    socket.on("close", () =>
      finish(() => reject(new Error("mux socket closed before a reply"))),
    );
  });
}

/** Sleep that rejects when aborted (used by wait loops). */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}
