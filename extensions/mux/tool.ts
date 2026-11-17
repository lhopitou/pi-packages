/**
 * tool — the `mux` tool and its human-invoked twin, the `/broadcast`
 * slash command. The tool: one declaration, an `action` enum, flat optional
 * parameters, and cross-validation in `execute()` returning instructive
 * errors so the model self-corrects in one turn.
 *
 * Failure taxonomy (no silent or fallback paths):
 * - no descriptor     → the pane is not a mux agent (extension not loaded
 *                       there) — hard error, there is no paste fallback;
 * - dead pid (hot) / failed signal (cold) → peer died — prune + error
 *                       pointing at `mux list`;
 * - connect refused with a live pid → mid-/reload or a crashed listener —
 *                       retry-window error; `mux read view=screen` still
 *                       reaches the pane.
 */

import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  truncateTail,
  type AgentToolResult,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import * as mux from "./socket.ts";
import * as zellij from "./zellij.ts";

const TOOL_NAME = "mux";
const DEFAULT_WAIT_TIMEOUT_S = 10;
const WAIT_POLL_INTERVAL_MS = 1_000;

export interface MuxToolDeps {
  /** Bare own pane number ("3"); null outside zellij. */
  ownPaneId: string | null;
  /** Own zellij session name; null outside zellij. */
  sessionName: string | null;
  /**
   * Load-time snapshot of the environment forwarded to spawned agents:
   * `PI_CODING_AGENT_DIR`, `PATH`, and every `PI_*` variable. Snapshotted at
   * load because the interactive shell's vars never reach the zellij server's
   * environment otherwise.
   */
  envForward: Record<string, string>;
}

/** One loose details shape across every result of the tool. */
export interface MuxDetails {
  action: string;
  pane?: string;
  summary?: string;
  pruned?: string[];
  delivery?: string;
  /** Broadcast fan-out: per-pane outcomes. */
  deliveredTo?: string[];
  failed?: string[];
  handle?: string;
  sessionId?: string;
  /** Spawned pane id (bare number), when a pane was created. */
  paneId?: string;
  matched?: boolean;
  timedOut?: boolean;
  aborted?: boolean;
}

export type MuxResult = AgentToolResult<MuxDetails>;

/** A read probe: `subject` is what wait_for tests, `final` is the full render. */
interface Probe {
  subject: string;
  final: string;
}

/** One broadcast fan-out outcome, shared by the tool action and the
 *  `/broadcast` slash command. */
interface BroadcastOutcome {
  /** Full multi-line per-pane report. */
  report: string;
  deliveredTo: string[];
  failed: string[];
  /** Prune receipts from the scan. */
  pruned: string[];
  /** Fan-out target count (0 → nothing to deliver to, not an error). */
  targetCount: number;
}

const parameters = Type.Object({
  action: StringEnum(
    ["list", "send", "broadcast", "read", "spawn", "stop"] as const,
    {
      description: "What to do (see the tool description).",
    },
  ),
  pane: Type.Optional(
    Type.String({
      description:
        'Target pane id: bare number or "terminal_<n>" ("17" ≡ "terminal_17"). Titles never address anything.',
    }),
  ),
  text: Type.Optional(
    Type.String({
      description:
        "send/broadcast: message body. Delivered verbatim — keep it brief; bulk data travels by file path.",
    }),
  ),
  view: Type.Optional(
    StringEnum(["state", "screen"] as const, {
      description:
        "read: what to inspect. state (default): live snapshot from the peer. screen: raw zellij dump-screen (last resort — works on non-agent panes too).",
    }),
  ),
  wait_for: Type.Optional(
    Type.String({
      description:
        'read: JavaScript regex. Blocks until it matches — for view=state, against the summary line ("idle" / "working: bash — cargo test (41s)"); for screen, the terminal output.',
    }),
  ),
  timeout_s: Type.Optional(
    Type.Number({
      description: `read with wait_for: give up after this many seconds. Default ${DEFAULT_WAIT_TIMEOUT_S}.`,
    }),
  ),
  handle: Type.Optional(
    Type.String({
      description:
        "spawn: name for the new pane/tab and the pi --session-id prefix (stable identity a human can /resume later). Default: generated.",
    }),
  ),
  task: Type.Optional(
    Type.String({
      description:
        "spawn: inline task text. Written to a prompt file and passed as an @file message so the agent starts working immediately.",
    }),
  ),
  task_file: Type.Optional(
    Type.String({
      description:
        "spawn: existing prompt file to pass as the @file task (mutually exclusive with task).",
    }),
  ),
  cwd: Type.Optional(
    Type.String({
      description:
        "spawn: working directory for the new agent. Default: this session's cwd.",
    }),
  ),
  model: Type.Optional(
    Type.String({
      description:
        'spawn: model for the new agent, "provider/modelId". Default: the child\'s own settings.',
    }),
  ),
  placement: Type.Optional(
    StringEnum(["right", "down", "tab"] as const, {
      description:
        "spawn: where to open. right (default) / down: a pane. tab: a new tab (needs an attached client — zellij destroys tabs in headless sessions).",
    }),
  ),
  focus: Type.Optional(
    Type.Boolean({
      description: "spawn: steal focus to the new pane. Default false.",
    }),
  ),
  pi_args: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'spawn: extra pi CLI flags passed through verbatim before the task file, e.g. ["--profile", "reviewer"]. No validation — must be valid pi flags the child knows.',
    }),
  ),
});

// ── small helpers ───────────────────────────────────────────────────────

function result(text: string, details: MuxDetails, isError = false): MuxResult {
  return { content: [{ type: "text", text }], details, isError };
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

/** First text part of a result's content; "" when none (reach errors are
 *  text-shaped, but the content union admits image parts). */
function textOf(content: MuxResult["content"]): string {
  for (const part of content) {
    if (part.type === "text") return part.text;
  }
  return "";
}

function isConnRefused(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === "ECONNREFUSED";
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function compileWaitFor(pattern: string): RegExp {
  try {
    return new RegExp(pattern, "m");
  } catch (err) {
    throw new Error(
      `wait_for is not a valid regular expression: ${errText(err)}`,
    );
  }
}

/** Discriminate read-probe results: probes carry a match subject. */
function isProbe(value: Probe | MuxResult): value is Probe {
  return (value as Probe).subject !== undefined;
}

/** Last few lines of a rendered subject, for wait timeout/abort receipts. */
function tailLines(text: string): string {
  return text.split("\n").slice(-3).join("\n");
}

// ── the tool ───────────────────────────────────────────────────────────

export function registerMux(pi: ExtensionAPI, deps: MuxToolDeps): void {
  /** Hot path: resolve a target descriptor, verifying liveness. Never
   *  spawns a zellij process. */
  function reach(
    paneRaw: string,
  ):
    | { ok: true; paneId: string; descriptor: mux.MuxDescriptor }
    | { ok: false; error: MuxResult } {
    const sessionName = deps.sessionName!;
    const paneId = zellij.normalizePaneId(paneRaw);
    const paths = mux.muxPaths(sessionName, paneId);
    const descriptor = mux.readDescriptor(paths.descriptorPath);
    if (!descriptor) {
      return {
        ok: false,
        error: result(
          `pane ${paneId} is not a mux agent — no descriptor at ${paths.descriptorPath}.\n` +
            `The mux extension is not loaded in that pane; there is no paste fallback. Use mux list to see which panes are live agents.`,
          { action: "reach", pane: paneId },
          true,
        ),
      };
    }
    if (!mux.pidAlive(descriptor.pid)) {
      // Reload-race guard: re-read immediately before unlinking. A /reload
      // rewrites the descriptor (fresh token); if the pid moved, the prune
      // is aborted so a live peer is not dropped from the mesh.
      const fresh = mux.readDescriptor(paths.descriptorPath);
      if (!fresh) {
        return {
          ok: false,
          error: result(
            `pane ${paneId}'s descriptor vanished mid-check (pruned concurrently?) — retry, or run mux list.`,
            { action: "reach", pane: paneId },
            true,
          ),
        };
      }
      const current = fresh.pid !== descriptor.pid ? fresh : descriptor;
      if (mux.pidAlive(current.pid)) {
        return { ok: true, paneId, descriptor: current };
      }
      mux.pruneFiles(paths);
      return {
        ok: false,
        error: result(
          `pane ${paneId}'s agent is dead (pid ${current.pid}) — pruned its stale descriptor and socket.\n` +
            `Use mux list to see the live agents.`,
          { action: "reach", pane: paneId, pruned: [paneId] },
          true,
        ),
      };
    }
    return { ok: true, paneId, descriptor };
  }

  /** Retry-window error: connect refused / token mismatch with a live pid. */
  function retryWindow(paneId: string, pid: number, cause: string): MuxResult {
    return result(
      `${cause}\n` +
        `pane ${paneId}'s pid ${pid} is alive, so this is a mid-/reload window or a crashed listener, not a dead peer. ` +
        `Retry after a moment. If it persists, the peer is wedged — mux read pane=${paneId} view=screen still reaches the pane; mux list re-verifies.`,
      { action: "reach", pane: paneId, summary: "retry-window" },
      true,
    );
  }

  // ── actions ────────────────────────────────────────────────────────

  /** Cold path: correlate every descriptor against list-panes and prune on
   *  either failed signal. Shared by list (render) and broadcast (fan-out). */
  async function scanAgents(): Promise<{
    panes: zellij.ZellijPane[];
    agents: Map<string, mux.MuxDescriptor>;
    pruned: string[];
  }> {
    const sessionName = deps.sessionName!;
    const panes = (await zellij.listPanes()).filter((p) => !p.is_plugin);
    const descriptors = mux.listDescriptors(mux.muxDir(sessionName));
    const paneExists = (paneId: string): boolean =>
      panes.some((p) => String(p.id) === paneId);

    const agents = new Map<string, mux.MuxDescriptor>();
    const pruned: string[] = [];
    for (const entry of descriptors) {
      const alive = mux.pidAlive(entry.descriptor.pid);
      if (alive && paneExists(entry.paneId)) {
        agents.set(entry.paneId, entry.descriptor);
        continue;
      }
      // Verification failed: prune, but re-read first — a /reload racing us
      // rewrites the descriptor, and unlinking the fresh one would drop a
      // live peer from the mesh until its next reload.
      const fresh = mux.readDescriptor(entry.path);
      if (fresh && fresh.pid !== entry.descriptor.pid) {
        if (mux.pidAlive(fresh.pid) && paneExists(entry.paneId)) {
          agents.set(entry.paneId, fresh);
        }
        continue; // Abort the prune: the descriptor was rewritten.
      }
      mux.pruneFiles(mux.muxPaths(sessionName, entry.paneId));
      const reason = alive
        ? "pane gone from list-panes (pid reuse?)"
        : `pid ${entry.descriptor.pid} dead`;
      pruned.push(`pane ${entry.paneId} (${reason})`);
    }
    return { panes, agents, pruned };
  }

  /** list: cold path — scan, prune, render. */
  async function doList(): Promise<MuxResult> {
    const { panes, agents, pruned } = await scanAgents();

    // Render live agents only. Bare panes are not mux-addressable, so
    // listing them is noise — the scan above still verifies them
    // (pane-absence pruning), only the output hides them.
    const lines: string[] = [];
    let hidden = 0;
    for (const pane of panes) {
      const id = String(pane.id);
      const descriptor = agents.get(id);
      if (!descriptor) {
        hidden++; // bare or exited — not mux-addressable
        continue;
      }
      const you = deps.ownPaneId === id ? " ← you" : "";
      lines.push(
        `  pane ${id}: "${pane.title}" — live mux agent (zellij session "${descriptor.sessionName}", pid ${descriptor.pid})${you}`,
      );
    }
    lines.unshift(
      `zellij session "${deps.sessionName}" — ${lines.length} live mux agent(s)` +
        (hidden ? ` (${hidden} non-agent pane(s) hidden)` : "") +
        ":",
    );
    if (pruned.length) {
      lines.push(`pruned stale descriptors: ${pruned.join("; ")}`);
    }
    return result(lines.join("\n"), { action: "list", pruned });
  }

  /** Core message delivery against a verified peer: connect–send–close.
   *  Shared by send (single pane) and broadcast (fan-out); callers render.
   *  `retry` marks retry-window failures (connect refused / token
   *  mismatch with a live pid) for the fuller retryWindow text.
   *  `human` messages (the /broadcast command) arrive verbatim, like
   *  a regular user message — see MessageRequest. */
  async function deliverMessage(
    paneId: string,
    descriptor: mux.MuxDescriptor,
    text: string,
    opts?: { human?: boolean },
  ): Promise<
    | { ok: true; delivery: "turn" | "steer" }
    | { ok: false; retry: boolean; error: string }
  > {
    let reply: mux.MuxReply;
    try {
      reply = await mux.muxRequest(descriptor.socketPath, {
        type: "message",
        token: descriptor.token,
        fromPane: deps.ownPaneId ?? "(unknown)",
        fromSessionName: deps.sessionName ?? "(unknown)",
        text,
        human: opts?.human,
      });
    } catch (err) {
      return isConnRefused(err)
        ? {
            ok: false,
            retry: true,
            error: `could not connect to pane ${paneId}'s mux listener (connection refused).`,
          }
        : {
            ok: false,
            retry: false,
            error: `delivery failed: ${errText(err)}`,
          };
    }
    if (reply.type === "error") {
      return reply.error.includes("token mismatch")
        ? {
            ok: false,
            retry: true,
            error: `token mismatch — pane ${paneId} reloaded with a fresh token mid-delivery.`,
          }
        : { ok: false, retry: false, error: `delivery failed: ${reply.error}` };
    }
    return {
      ok: true,
      delivery:
        reply.type === "ok" && reply.delivery === "steer" ? "steer" : "turn",
    };
  }

  /** send: socket delivery to one pane, connect–send–close. */
  async function doSend(pane: string, text: string): Promise<MuxResult> {
    const reached = reach(pane);
    if (!reached.ok) return reached.error;
    const { paneId, descriptor } = reached;
    const outcome = await deliverMessage(paneId, descriptor, text);
    if (!outcome.ok) {
      return outcome.retry
        ? retryWindow(paneId, descriptor.pid, outcome.error)
        : result(outcome.error, { action: "send", pane: paneId }, true);
    }
    const how =
      outcome.delivery === "steer"
        ? "the peer was busy — steered its current run (enters after the current assistant turn)"
        : "the peer was idle — started a turn";
    return result(
      `Delivered to pane ${paneId} (zellij session "${descriptor.sessionName}", pid ${descriptor.pid}): ${how}.`,
      { action: "send", pane: paneId, delivery: outcome.delivery },
    );
  }

  /** Broadcast core shared by the tool's `broadcast` action (own pane
   *  excluded — self-delivery would inject into the sender's own run) and
   *  the `/broadcast` slash command (own pane included — the human wants
   *  this pane's agent to receive it too, and verbatim — a `human`
   *  message arrives as a regular user message, no `[mux]` prefix). The
   *  list action's scan and pruning, a fresh reach per target, per-pane
   *  outcomes: a peer failing mid-fan-out (reload window, death) is
   *  reported, not fatal. */
  async function runBroadcast(
    text: string,
    opts: { includeSelf: boolean; human?: boolean },
  ): Promise<BroadcastOutcome> {
    const { panes, agents, pruned } = await scanAgents();
    const targets = panes
      .map((p) => String(p.id))
      .filter(
        (id) => (opts.includeSelf || id !== deps.ownPaneId) && agents.has(id),
      );

    if (targets.length === 0) {
      return {
        report:
          `No ${opts.includeSelf ? "" : "other "}live mux agents in zellij session "${deps.sessionName}" — nothing to broadcast.` +
          (pruned.length
            ? `\npruned stale descriptors: ${pruned.join("; ")}`
            : ""),
        deliveredTo: [],
        failed: [],
        pruned,
        targetCount: 0,
      };
    }

    const deliveredTo: string[] = [];
    const failed: string[] = [];
    const lines: string[] = [];
    for (const paneId of targets) {
      // Per-target reach: fresh descriptor per delivery, so a peer that
      // reloaded between scan and send is picked up, not failed.
      const reached = reach(paneId);
      if (!reached.ok) {
        failed.push(paneId);
        lines.push(
          `  pane ${paneId}: NOT delivered — ${truncate(
            textOf(reached.error.content) || "unreachable",
            160,
          )}`,
        );
        continue;
      }
      const outcome = await deliverMessage(paneId, reached.descriptor, text, {
        human: opts.human,
      });
      if (outcome.ok) {
        deliveredTo.push(paneId);
        lines.push(
          `  pane ${paneId}: delivered (${
            outcome.delivery === "steer"
              ? "busy — steered its current run"
              : "idle — started a turn"
          })${deps.ownPaneId === paneId ? " ← you" : ""}`,
        );
      } else {
        failed.push(paneId);
        lines.push(
          `  pane ${paneId}: NOT delivered — ${truncate(outcome.error, 160)}` +
            (outcome.retry
              ? " (retry window: the peer's pid is alive — it likely just reloaded; retry after a moment)"
              : ""),
        );
      }
    }
    const head =
      `Broadcast "${truncate(text, 80)}" to ${deliveredTo.length}/${targets.length} live mux agent(s) of zellij session "${deps.sessionName}"` +
      (pruned.length
        ? ` (${pruned.length} stale descriptor(s) pruned during the scan)`
        : "") +
      (failed.length ? ` — ${failed.length} failed:` : ":");
    return {
      report: [head, ...lines].join("\n"),
      deliveredTo,
      failed,
      pruned,
      targetCount: targets.length,
    };
  }

  /** broadcast action: every live mux agent except this pane. Only total
   *  failure is an error — an empty agent set is a plain report. */
  async function doBroadcast(text: string): Promise<MuxResult> {
    const outcome = await runBroadcast(text, { includeSelf: false });
    return result(
      outcome.report,
      {
        action: "broadcast",
        deliveredTo: outcome.deliveredTo,
        failed: outcome.failed.length ? outcome.failed : undefined,
        pruned: outcome.pruned,
      },
      outcome.targetCount > 0 && outcome.failed.length === outcome.targetCount,
    );
  }

  // ── read ────────────────────────────────────────────────────────────

  function renderState(reply: mux.StateReply, paneId: string): string {
    const lines = [
      `pane ${paneId} (zellij session "${reply.sessionName}"): ${mux.renderStateSummary(reply)}`,
    ];
    if (reply.currentToolCall) {
      lines.push(
        `  current tool call: ${reply.currentToolCall.name} — ${reply.currentToolCall.input} (${Math.round(reply.currentToolCall.runningMs / 1000)}s)`,
      );
    }
    if (reply.streamingTail) {
      lines.push(`  streaming tail: …${truncate(reply.streamingTail, 300)}`);
    }
    if (reply.lastUserMessage) {
      lines.push(
        `  last user message: ${truncate(reply.lastUserMessage, 200)}`,
      );
    }
    if (reply.lastAssistantText) {
      lines.push(
        `  last assistant text: ${truncate(reply.lastAssistantText, 400)}`,
      );
    }
    if (reply.sessionFile) {
      lines.push(`  session file: ${reply.sessionFile}`);
    }
    return lines.join("\n");
  }

  /** Raw state query against a reached peer; shared by `probeState` and
   *  `stop`. */
  async function queryState(reached: {
    paneId: string;
    descriptor: mux.MuxDescriptor;
  }): Promise<mux.StateReply | MuxResult> {
    let reply: mux.MuxReply;
    try {
      reply = await mux.muxRequest(reached.descriptor.socketPath, {
        type: "state",
        token: reached.descriptor.token,
      });
    } catch (err) {
      if (isConnRefused(err)) {
        return retryWindow(
          reached.paneId,
          reached.descriptor.pid,
          `could not connect to pane ${reached.paneId}'s mux listener (connection refused).`,
        );
      }
      return result(
        `state query failed: ${errText(err)}`,
        { action: "read", pane: reached.paneId },
        true,
      );
    }
    if (reply.type === "error") {
      if (reply.error.includes("token mismatch")) {
        return retryWindow(
          reached.paneId,
          reached.descriptor.pid,
          `token mismatch — pane ${reached.paneId} reloaded with a fresh token mid-query.`,
        );
      }
      return result(
        `state query failed: ${reply.error}`,
        { action: "read", pane: reached.paneId },
        true,
      );
    }
    if (reply.type !== "state") {
      return result(
        `unexpected reply type from pane ${reached.paneId}: ${reply.type}`,
        { action: "read", pane: reached.paneId },
        true,
      );
    }
    return reply;
  }

  async function probeState(reached: {
    paneId: string;
    descriptor: mux.MuxDescriptor;
  }): Promise<Probe | MuxResult> {
    const reply = await queryState(reached);
    if (!("type" in reply)) return reply as MuxResult;
    return {
      subject: mux.renderStateSummary(reply),
      final: renderState(reply, reached.paneId),
    };
  }

  async function doRead(
    pane: string,
    params: {
      view?: "state" | "screen";
      wait_for?: string;
      timeout_s?: number;
    },
    signal: AbortSignal | undefined,
    onUpdate: ((update: MuxResult) => void) | undefined,
  ): Promise<MuxResult> {
    const view = params.view ?? "state";
    const paneId = zellij.normalizePaneId(pane);

    // Wait state shared across the loop variants.
    const waitFor = params.wait_for;
    let re: RegExp | null = null;
    if (waitFor !== undefined) {
      re = compileWaitFor(waitFor);
    }
    const timeoutMs = (params.timeout_s ?? DEFAULT_WAIT_TIMEOUT_S) * 1_000;
    const deadline = Date.now() + timeoutMs;
    const startedAt = Date.now();

    const probe: () => Promise<Probe | MuxResult> =
      view === "screen"
        ? async () => {
            const dump = await zellij.dumpScreen(paneId);
            const text = truncateTail(dump).content;
            return { subject: text, final: text };
          }
        : async () => {
            const reached = reach(pane);
            if (!reached.ok) return reached.error;
            return probeState(reached);
          };

    // First probe doubles as the no-wait answer.
    const current = await probe();
    if (!isProbe(current)) return current;
    if (!re) {
      return result(current.final, {
        action: "read",
        pane: paneId,
        summary: current.subject.split("\n")[0],
      });
    }

    // Blocking read: poll until the pattern matches the subject.
    let last = current;
    while (true) {
      if (signal?.aborted) {
        return result(
          `Wait aborted by the user after ${Math.round((Date.now() - startedAt) / 1000)}s. Last observation of pane ${paneId}:\n${tailLines(last.subject)}`,
          { action: "read", pane: paneId, aborted: true },
        );
      }
      if (re.test(last.subject)) {
        return result(last.final, {
          action: "read",
          pane: paneId,
          matched: true,
          summary: last.subject.split("\n").slice(-1)[0],
        });
      }
      if (Date.now() >= deadline) {
        return result(
          `Timed out after ${params.timeout_s ?? DEFAULT_WAIT_TIMEOUT_S}s waiting for /${waitFor}/ on pane ${paneId} (view=${view}). Last observation:\n${tailLines(last.subject)}`,
          { action: "read", pane: paneId, timedOut: true },
          true,
        );
      }
      onUpdate?.(
        result(
          `waiting for /${waitFor}/ on pane ${paneId} (view=${view}) — ${Math.round((Date.now() - startedAt) / 1000)}s elapsed`,
          { action: "read", pane: paneId },
        ),
      );
      try {
        await mux.sleep(WAIT_POLL_INTERVAL_MS, signal);
      } catch {
        // Aborted — the loop top reports it.
      }
      const next = await probe();
      if (isProbe(next)) {
        last = next;
      } else {
        return next;
      }
    }
  }

  // ── spawn ───────────────────────────────────────────────────────────

  async function doSpawn(
    params: {
      handle?: string;
      task?: string;
      task_file?: string;
      cwd?: string;
      model?: string;
      pi_args?: string[];
      placement?: "right" | "down" | "tab";
      focus?: boolean;
    },
    cwd: string,
    parentSessionFile: string | undefined,
  ): Promise<MuxResult> {
    const sessionName = deps.sessionName!;
    const handle =
      params.handle?.trim() || `agent-${randomBytes(3).toString("hex")}`;
    let taskFile: string;
    if (params.task !== undefined) {
      taskFile = join(tmpdir(), `pi-mux-task-${handle}.md`);
      writeFileSync(taskFile, params.task);
    } else {
      taskFile = isAbsolute(params.task_file!)
        ? params.task_file!
        : resolve(cwd, params.task_file!);
      if (!existsSync(taskFile)) {
        return result(
          `task_file not found: ${taskFile}`,
          { action: "spawn", handle },
          true,
        );
      }
    }

    const sessionId = `${handle}-${randomBytes(4).toString("hex")}`;
    const childCwd = params.cwd
      ? isAbsolute(params.cwd)
        ? params.cwd
        : resolve(cwd, params.cwd)
      : cwd;
    const focus = params.focus ?? false;

    // Env forwarding: panes spawn with the zellij server's environment, which
    // lacks the interactive shell's vars. Snapshot at load + creator vars.
    const envPairs: Record<string, string> = {
      ...deps.envForward,
      PI_MUX_PARENT_PANE: deps.ownPaneId ?? "",
      PI_MUX_PARENT_ZELLIJ_SESSION: sessionName,
      PI_MUX_PARENT_CWD: cwd,
      PI_MUX_PARENT_PID: String(process.pid),
      // The child links this session file as its parent (see index.ts), so
      // the session picker nests it here instead of listing it at the root.
      // Always set (empty overrides a forwarded grandparent value when this
      // spawner itself runs sessionless); the child skips empty values.
      PI_MUX_PARENT_SESSION_FILE: parentSessionFile ?? "",
    };
    const argv = [
      "env",
      ...Object.entries(envPairs).map(([key, value]) => `${key}=${value}`),
      "pi",
      "-a",
      "-n",
      handle,
      "--session-id",
      sessionId,
    ];
    if (params.model) argv.push("--model", params.model);
    if (params.pi_args?.length) argv.push(...params.pi_args);
    argv.push(`@${taskFile}`);

    const spawnArgs = { name: handle, cwd: childCwd, focus, argv };
    let paneId: string;
    let where: string;
    if (params.placement === "tab") {
      const tabId = await zellij.newTab(spawnArgs);
      const pane = zellij.paneInTab(await zellij.listPanes(), tabId);
      if (!pane) {
        return result(
          `the new tab was destroyed immediately — zellij destroys new tabs in sessions with zero attached clients.\n` +
            `Attach to zellij session "${sessionName}" once and retry, or use placement="right"/"down" (a pane) instead. Nothing was registered; the task file stays at ${taskFile}.`,
          { action: "spawn", handle },
          true,
        );
      }
      paneId = String(pane.id);
      where = `a new tab (tab id ${tabId})`;
    } else {
      paneId = await zellij.newPane({
        ...spawnArgs,
        direction: params.placement ?? "right",
      });
      where = `a new pane (${params.placement ?? "right"} of yours)`;
    }

    return result(
      `Spawned agent pane ${paneId} in ${where} of zellij session "${sessionName}":\n` +
        `  handle: ${handle} (pane/tab name)\n` +
        `  pi session-id: ${sessionId}\n` +
        `  cwd: ${childCwd}\n` +
        `  model: ${params.model ?? "(the child's own default settings)"}\n` +
        (params.pi_args?.length
          ? `  pi flags: ${params.pi_args.join(" ")}\n`
          : "") +
        `  task: @${taskFile}\n` +
        `Fire-and-forget — the new agent is an ordinary peer: address it with mux send pane=${paneId}, inspect it with mux read pane=${paneId}.`,
      { action: "spawn", handle, paneId, sessionId },
    );
  }

  // ── stop ───────────────────────────────────────────────────────────

  async function doStop(pane: string): Promise<MuxResult> {
    const sessionName = deps.sessionName!;
    const paneId = zellij.normalizePaneId(pane);
    const paths = mux.muxPaths(sessionName, paneId);

    // Best effort: if the target is a live agent and is mid-run, send Ctrl-c
    // first so it aborts cleanly instead of being cut down by the close.
    // (A MuxResult from queryState has no `state` field and simply skips.)
    let note = "";
    const descriptor = mux.readDescriptor(paths.descriptorPath);
    if (descriptor && mux.pidAlive(descriptor.pid)) {
      try {
        const reply = await queryState({ paneId, descriptor });
        if ((reply as mux.StateReply).state === "working") {
          await zellij.sendKeys(paneId, "ctrl c");
          await mux.sleep(300);
          note = " — it was working, so Ctrl-c was sent first";
        }
      } catch {
        // Best effort only; the close below is the real stop.
      }
    }
    try {
      await zellij.closePane(paneId);
    } catch (err) {
      return result(
        `closing pane ${paneId} failed: ${errText(err)}`,
        { action: "stop", pane: paneId },
        true,
      );
    }
    return result(
      `Stopped pane ${paneId}${note}: the pane is closed.` +
        (descriptor
          ? " Its mux descriptor, if not cleaned up by the shutdown itself, is pruned on the next mux list or failed send."
          : ""),
      { action: "stop", pane: paneId },
    );
  }

  // ── registration ───────────────────────────────────────────────────

  pi.registerTool({
    name: TOOL_NAME,
    label: "Agent mux",
    description:
      "Agent-to-agent messaging inside the current mux session. " +
      "list: the session's live mux agents (stale descriptors are verified and pruned; bare panes are hidden). " +
      "send pane text: deliver a message that arrives as a user message in the target pane — turn if idle, steered mid-run if busy. " +
      "broadcast text: deliver one message to every live mux agent at once (the list action's agent set; your own pane excluded) — per-pane outcomes reported. " +
      "read pane: inspect a peer on demand — view=state (live tool call, streaming tail, last messages), view=screen (raw dump; also works on non-agent panes); with wait_for, block until a regex matches. " +
      "spawn: create a new agent pane/tab with env forwarding, a task file, and optional extra pi CLI flags (pi_args; fire-and-forget). " +
      "stop: abort (Ctrl-c if mid-run) and close a pane. " +
      'Panes are addressed by bare pane number ("17" ≡ "terminal_17"); titles never address anything.',
    promptSnippet:
      "message, broadcast, inspect, list, and spawn pi agents in other mux panes",
    promptGuidelines: [
      "Use mux to message and inspect other agent panes in this mux session, to broadcast a message to all of them at once, and to spawn new ones (mux list / send / broadcast / read / spawn / stop).",
      "For context-demanding tasks — exploring an unfamiliar codebase, reading or scanning many files, broad searches — prefer spawning a subagent (mux spawn, task as prompt file) and reviewing its output with mux read, keeping your own context lean. Do not delegate small tasks (a few files, a quick lookup) or work that needs your conversation context: the spawned agent sees none of it, so give it a self-contained task with objective, constraints, and expected output.",
      "Reports and coordination expectations come from the tasking prompt, not from mux: deliver them with mux send when your task says to report back.",
      "Keep mux send payloads brief — there is no size limit and no truncation in the protocol, so a message is injected verbatim into the peer's context; bulk data travels by file path, never inside a message.",
      "For raw zellij control (layouts, floating panes, arbitrary commands, --block-until-*), use bash plus the zellij skill instead of mux.",
    ],
    parameters,
    // The describe-image pattern: registered and active, but hidden from the
    // model (declaration + guidelines dropped) outside zellij, where there
    // is no pane to address.
    prepareLoadout: () =>
      deps.ownPaneId ? undefined : { hiddenDeclarations: [TOOL_NAME] },

    renderCall(args, theme, context) {
      const text =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      let content =
        theme.fg("toolTitle", theme.bold("mux ")) +
        theme.fg("toolTitle", args.action ?? "…");
      if (args.pane) content += theme.fg("muted", ` pane=${args.pane}`);
      if (args.action === "spawn" && (args.handle || args.task)) {
        content += theme.fg("muted", ` ${args.handle ?? "…"}`);
      }
      text.setText(content);
      return text;
    },

    async execute(
      _toolCallId,
      params,
      signal,
      onUpdate,
      ctx,
    ): Promise<MuxResult> {
      if (!deps.ownPaneId || !deps.sessionName) {
        return result(
          "mux requires a zellij session ($ZELLIJ_PANE_ID / $ZELLIJ_SESSION_NAME are unset).",
          { action: params.action },
          true,
        );
      }
      // Cross-validation with instructive errors: the model self-corrects
      // in one turn.
      const invalid =
        params.action === "send"
          ? !params.pane
            ? 'action "send" requires "pane"'
            : params.text === undefined || params.text === ""
              ? 'action "send" requires "text"'
              : null
          : params.action === "broadcast"
            ? params.text === undefined || params.text === ""
              ? 'action "broadcast" requires "text"'
              : null
            : params.action === "read"
              ? !params.pane
                ? 'action "read" requires "pane"'
                : null
              : params.action === "stop"
                ? !params.pane
                  ? 'action "stop" requires "pane"'
                  : null
                : params.action === "spawn"
                  ? params.task === undefined && !params.task_file
                    ? 'action "spawn" requires "task" or "task_file"'
                    : params.task !== undefined && params.task_file
                      ? '"task" and "task_file" are mutually exclusive'
                      : null
                  : null;
      if (invalid) {
        return result(invalid, { action: params.action }, true);
      }

      try {
        switch (params.action) {
          case "list":
            return await doList();
          case "send":
            return await doSend(params.pane!, params.text!);
          case "broadcast":
            return await doBroadcast(params.text!);
          case "read":
            return await doRead(params.pane!, params, signal, onUpdate);
          case "spawn":
            return await doSpawn(
              params,
              ctx.cwd,
              ctx.sessionManager.getSessionFile(),
            );
          case "stop":
            return await doStop(params.pane!);
        }
      } catch (err) {
        return result(
          `${params.action} failed: ${errText(err)}`,
          { action: params.action },
          true,
        );
      }
    },
  });

  // ── /broadcast slash command ──────────────────────────────────────

  // The human-invoked twin of the broadcast action: the same runBroadcast
  // core with the flags the action never sets — includeSelf, so this
  // pane's agent receives the message too, and human, so every recipient
  // (this pane included) gets it verbatim, as a regular user message — no
  // `[mux] from pane …` agent-to-agent prefix. The report goes to the user
  // as a UI notification, not into the conversation. Registered only
  // inside zellij, where there is a pane to deliver from — outside it the
  // tool hides itself (prepareLoadout) and the command is simply absent.
  if (deps.ownPaneId && deps.sessionName) {
    pi.registerCommand("broadcast", {
      description:
        "Broadcast a message to every live mux agent in this zellij session — this pane included (the mux broadcast tool action excludes it)",
      handler: async (args: string, ctx) => {
        const text = args.trim();
        if (!text) {
          ctx.ui.notify("Usage: /broadcast <message>", "error");
          return;
        }
        const outcome = await runBroadcast(text, {
          includeSelf: true,
          human: true,
        });
        ctx.ui.notify(
          outcome.report,
          outcome.targetCount > 0 &&
            outcome.failed.length === outcome.targetCount
            ? "error"
            : "info",
        );
      },
    });
  }
}
