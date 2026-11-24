/**
 * tool — the mux tool family and its human-invoked twin, the `/broadcast`
 * slash command. Four tools, one per action family, so each family's
 * required parameters live in the JSON schema itself — a single
 * action-discriminated tool cannot mark per-action requirements, and
 * schema-required members survive emission where models that stochastically
 * drop trailing *optional* arguments mid-emission (GLM) would lose them:
 *
 * - `mux_send`  — deliver a message to one pane, or broadcast to every
 *                 live agent (both require `text`)
 * - `mux_pane`  — inspect a pane (read) or abort and close it (stop)
 *                 (both require `pane`)
 * - `mux_list`  — the session's live mux agents
 * - `mux_spawn` — spawn a new agent pane/tab (requires `task` or
 *                 `task_file`, oneOf at the schema level)
 *
 * Cross-validation remains in `execute()` returning instructive errors —
 * echoing the received arguments — so a model that believes it emitted a
 * parameter can see the mismatch and self-correct in one turn.
 *
 * Failure taxonomy (no silent or fallback paths):
 * - no descriptor     → the pane is not a mux agent (extension not loaded
 *                       there) — hard error, there is no paste fallback;
 * - dead pid (hot) / failed signal (cold) → peer died — prune + error
 *                       pointing at `mux_list`;
 * - connect refused with a live pid → mid-/reload or a crashed listener —
 *                       retry-window error; `mux_pane` `view=screen` still
 *                       reaches the pane.
 */

import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  truncateTail,
  type AgentToolResult,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import * as mux from "./socket.ts";
import * as zellij from "./zellij.ts";

/**
 * `{ type: "string", enum: [...] }` — the Google-compatible enum schema
 * (anyOf/const are not supported there), same runtime schema as pi-ai's
 * StringEnum. Built with Type.Unsafe because pi-ai's returns a pi-schema
 * `Schema<T>`, which TypeBox's `Static` cannot infer — fields built with it
 * degrade to `unknown` in `parameters`, breaking exhaustive `switch` and
 * every string-typed use of `action`/`view`/`placement`.
 */
const StringEnum = <T extends readonly string[]>(
  values: T,
  options?: { description?: string; default?: T[number] },
) =>
  Type.Unsafe<T[number]>({
    type: "string",
    enum: [...values],
    ...options,
  });

const SEND_TOOL = "mux_send";
const PANE_TOOL = "mux_pane";
const LIST_TOOL = "mux_list";
const SPAWN_TOOL = "mux_spawn";
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

// ── schemas ─────────────────────────────────────────────────────────────

// One tool per action family. Schema-level `required` is load-bearing:
// GLM-family models stochastically drop trailing *optional* arguments
// mid-emission (then replay the malformed pattern from their own history),
// while required members survive — so actions that share a required field
// are grouped (send/broadcast → text; read/stop → pane), and spawn's
// task/task_file live in a schema of their own under a oneOf.

const sendParameters = Type.Object({
  action: StringEnum(["send", "broadcast"] as const, {
    description:
      "send: deliver to the pane named by `pane`. broadcast: deliver to every live mux agent at once (own pane excluded), per-pane outcomes reported.",
  }),
  text: Type.String({
    description:
      "Message body. Delivered verbatim — keep it brief; bulk data travels by file path.",
  }),
  pane: Type.Optional(
    Type.String({
      description:
        'send: target pane id — bare number or "terminal_<n>" ("17" ≡ "terminal_17"). Titles never address anything.',
    }),
  ),
});

const paneParameters = Type.Object({
  action: StringEnum(["read", "stop"] as const, {
    description:
      "read: inspect the pane on demand. stop: abort it (Ctrl-c if mid-run) and close it.",
  }),
  pane: Type.String({
    description:
      'Target pane id — bare number or "terminal_<n>" ("17" ≡ "terminal_17"). Titles never address anything.',
  }),
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
});

const listParameters = Type.Object({});

interface SpawnParams {
  handle?: string;
  task?: string;
  task_file?: string;
  cwd?: string;
  model?: string;
  placement?: "right" | "down" | "tab";
  focus?: boolean;
  profile?: string;
}

const spawnParameters = Type.Unsafe<SpawnParams>({
  type: "object",
  properties: {
    handle: Type.Optional(
      Type.String({
        description:
          "Name for the new pane/tab and the pi --session-id prefix (stable identity a human can /resume later). Default: generated.",
      }),
    ),
    task: Type.Optional(
      Type.String({
        description:
          "Inline task text. Written to a prompt file and passed as an @file message so the agent starts working immediately.",
      }),
    ),
    task_file: Type.Optional(
      Type.String({
        description:
          "Existing prompt file to pass as the @file task (mutually exclusive with task).",
      }),
    ),
    cwd: Type.Optional(
      Type.String({
        description:
          "Working directory for the new agent. Default: this session's cwd.",
      }),
    ),
    model: Type.Optional(
      Type.String({
        description:
          'Model for the new agent, "provider/modelId". Default: the child\'s own settings.',
      }),
    ),
    placement: Type.Optional(
      StringEnum(["right", "down", "tab"] as const, {
        description:
          "Where to open. right (default) / down: a pane. tab: a new tab (needs an attached client — zellij destroys tabs in headless sessions).",
      }),
    ),
    focus: Type.Optional(
      Type.Boolean({
        description: "Steal focus to the new pane. Default false.",
      }),
    ),
    profile: Type.Optional(
      Type.String({
        description:
          "Named system-prompt profile for the child (~/.pi/agent/profiles or the project's .pi/profiles — see /profile). Passed as --profile <name>; the child starts without a profile if the name is unknown.",
      }),
    ),
  },
  // Exactly one of task / task_file, at the schema level — see the
  // schemas comment above.
  oneOf: [{ required: ["task"] }, { required: ["task_file"] }],
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
            `The mux extension is not loaded in that pane; there is no paste fallback. Use mux_list to see which panes are live agents.`,
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
            `pane ${paneId}'s descriptor vanished mid-check (pruned concurrently?) — retry, or run mux_list.`,
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
            `Use mux_list to see the live agents.`,
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
        `Retry after a moment. If it persists, the peer is wedged — mux_pane action=read pane=${paneId} view=screen still reaches the pane; mux_list re-verifies.`,
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
      profile?: string;
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
    if (params.profile) argv.push("--profile", params.profile);
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
        (params.profile ? `  profile: ${params.profile}\n` : "") +
        `  task: @${taskFile}\n` +
        `Fire-and-forget — the new agent is an ordinary peer: address it with mux_send pane=${paneId}, inspect it with mux_pane action=read pane=${paneId}.`,
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
          ? " Its mux descriptor, if not cleaned up by the shutdown itself, is pruned on the next mux_list or failed send."
          : ""),
      { action: "stop", pane: paneId },
    );
  }

  // ── registration ───────────────────────────────────────────────────

  // Every tool's first gate: mux registers only inside zellij.
  function zellijGuard(): MuxResult | null {
    if (deps.ownPaneId && deps.sessionName) return null;
    return result(
      "mux requires a zellij session ($ZELLIJ_PANE_ID / $ZELLIJ_SESSION_NAME are unset).",
      { action: "guard" },
      true,
    );
  }

  /** Validation error echoing the received arguments: a model that
   *  believes it emitted a parameter can see the mismatch — models that
   *  drop trailing arguments mid-emission (GLM) otherwise loop on the
   *  bare requirement, replaying their own malformed call from history. */
  function invalidArgs(
    action: string,
    received: unknown,
    message: string,
  ): MuxResult {
    return result(
      `${message}\n\nReceived arguments:\n${JSON.stringify(received, null, 2)}`,
      { action },
      true,
    );
  }

  /** Error wrapper shared by every tool execute. */
  async function run(
    action: string,
    fn: () => Promise<MuxResult>,
  ): Promise<MuxResult> {
    try {
      return await fn();
    } catch (err) {
      return result(`${action} failed: ${errText(err)}`, { action }, true);
    }
  }

  // The describe-image pattern: registered and active, but hidden from the
  // model (declaration + guidelines dropped) outside zellij, where there is
  // no pane to address. Each tool hides itself.

  pi.registerTool({
    name: SEND_TOOL,
    label: "Mux send",
    description:
      "Message mux agent panes. " +
      "send: deliver text to one pane — it arrives as a user message (turn if idle, steered mid-run if busy). " +
      "broadcast: deliver one message to every live mux agent at once (the mux_list agent set; your own pane excluded) — per-pane outcomes reported. " +
      'Panes are addressed by bare pane number ("17" ≡ "terminal_17"); titles never address anything.',
    promptSnippet:
      "send a message to one mux pane, or broadcast to every live mux agent at once",
    promptGuidelines: [
      "Deliver agent-to-agent messages with mux_send: action send targets one pane, action broadcast fans one message out to every live mux agent at once (your own pane excluded).",
      "Reports and coordination expectations come from the tasking prompt, not from mux: deliver them with mux_send when your task says to report back.",
      "Keep mux_send payloads brief — there is no size limit and no truncation in the protocol, so a message is injected verbatim into the peer's context; bulk data travels by file path, never inside a message.",
    ],
    parameters: sendParameters,
    prepareLoadout: () =>
      deps.ownPaneId ? undefined : { hiddenDeclarations: [SEND_TOOL] },

    renderCall(args, theme, context) {
      const text =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      let content =
        theme.fg("toolTitle", theme.bold("mux_send ")) +
        theme.fg("toolTitle", args.action ?? "…");
      if (args.pane) content += theme.fg("muted", ` pane=${args.pane}`);
      text.setText(content);
      return text;
    },

    async execute(_toolCallId, params): Promise<MuxResult> {
      const guard = zellijGuard();
      if (guard) return guard;
      if (!params.text) {
        return invalidArgs(
          params.action,
          params,
          `action "${params.action}" requires a non-empty "text"`,
        );
      }
      const { action, pane, text } = params;
      if (action === "send") {
        if (!pane) {
          return invalidArgs(action, params, 'action "send" requires "pane"');
        }
        return run(action, () => doSend(pane, text));
      }
      return run(action, () => doBroadcast(text));
    },
  });

  pi.registerTool({
    name: PANE_TOOL,
    label: "Mux pane",
    description:
      "Inspect or stop mux agent panes. " +
      "read: inspect a peer on demand — view=state (default; live tool call, streaming tail, last messages) or view=screen (raw zellij dump; also works on non-agent panes); with wait_for, block until a regex matches. " +
      "stop: abort the pane (Ctrl-c if mid-run) and close it. " +
      'Panes are addressed by bare pane number ("17" ≡ "terminal_17"); titles never address anything.',
    promptSnippet:
      "inspect a mux pane (live state or screen, with wait_for) or stop it",
    promptGuidelines: [
      'Inspect mux peers on demand with mux_pane action=read: view=state is the live snapshot; view=screen the raw terminal; wait_for blocks until a pattern matches (e.g. "^idle$"). Pull (inspect) when a report is overdue or a claim needs checking; push (report-in prompts) for completion.',
      "mux_pane action=stop aborts a pane (Ctrl-c if mid-run) and closes it — how you tear down finished subagents.",
      "For raw zellij control (layouts, floating panes, arbitrary commands, --block-until-*), use bash plus the zellij skill instead of mux.",
    ],
    parameters: paneParameters,
    prepareLoadout: () =>
      deps.ownPaneId ? undefined : { hiddenDeclarations: [PANE_TOOL] },

    renderCall(args, theme, context) {
      const text =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      let content =
        theme.fg("toolTitle", theme.bold("mux_pane ")) +
        theme.fg("toolTitle", args.action ?? "…");
      if (args.pane) content += theme.fg("muted", ` pane=${args.pane}`);
      text.setText(content);
      return text;
    },

    async execute(_toolCallId, params, signal, onUpdate): Promise<MuxResult> {
      const guard = zellijGuard();
      if (guard) return guard;
      const { action, pane } = params;
      if (action === "read") {
        return run(action, () => doRead(pane, params, signal, onUpdate));
      }
      return run(action, () => doStop(pane));
    },
  });

  pi.registerTool({
    name: LIST_TOOL,
    label: "Mux list",
    description:
      "List the live mux agents of the current zellij session (session names, pids), own pane marked. Stale descriptors are verified and pruned during the scan; bare panes are not mux-addressable and are hidden (a hidden-count note is the only trace).",
    promptSnippet: "list the live mux agents of this zellij session",
    promptGuidelines: [
      "Run mux_list before spawning — it confirms the session state and gives you your own pane number, which report-back prompts must embed.",
    ],
    parameters: listParameters,
    prepareLoadout: () =>
      deps.ownPaneId ? undefined : { hiddenDeclarations: [LIST_TOOL] },

    async execute(): Promise<MuxResult> {
      const guard = zellijGuard();
      if (guard) return guard;
      return run("list", () => doList());
    },
  });

  pi.registerTool({
    name: SPAWN_TOOL,
    label: "Mux spawn",
    description:
      "Spawn a new pi agent pane/tab in this zellij session with env forwarding, a task delivered as an @file message, and an optional named profile. Fire-and-forget — the new agent is an ordinary peer: message it with mux_send, inspect it with mux_pane. Give exactly one of task (inline text) or task_file (an existing prompt file).",
    promptSnippet:
      "spawn a pi agent into a new mux pane/tab, with env forwarding and a task",
    promptGuidelines: [
      "Spawn subagents with mux_spawn — fire-and-forget: give a handle, a self-contained task (inline task text, or task_file for bulk — spawned agents see none of your conversation), and optionally cwd, model, placement (right/down = pane beside you for short-lived agents; tab = own tab for long-lived or many), profile, focus.",
      "For context-demanding tasks — exploring an unfamiliar codebase, reading or scanning many files, broad searches — prefer spawning a subagent (task as prompt file) and reviewing its output with mux_pane action=read, keeping your own context lean. Do not delegate small tasks (a few files, a quick lookup) or work that needs your conversation context: the spawned agent sees none of it, so give it a self-contained task with objective, constraints, and expected output.",
      "For raw zellij control (layouts, floating panes, arbitrary commands, --block-until-*), use bash plus the zellij skill instead of mux.",
    ],
    parameters: spawnParameters,
    prepareLoadout: () =>
      deps.ownPaneId ? undefined : { hiddenDeclarations: [SPAWN_TOOL] },

    renderCall(args, theme, context) {
      const text =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const content =
        theme.fg("toolTitle", theme.bold("mux_spawn ")) +
        theme.fg("muted", args.handle ?? "…");
      text.setText(content);
      return text;
    },

    async execute(
      _toolCallId,
      params,
      _signal,
      _onUpdate,
      ctx,
    ): Promise<MuxResult> {
      const guard = zellijGuard();
      if (guard) return guard;
      // Cross-validation (the oneOf mostly covers this at the schema
      // level) with instructive, echoed errors: a model that believes it
      // emitted a task sees the mismatch and self-corrects in one turn.
      const invalid =
        params.task === undefined && params.task_file === undefined
          ? 'spawning requires "task" or "task_file"'
          : params.task !== undefined && params.task_file !== undefined
            ? '"task" and "task_file" are mutually exclusive'
            : null;
      if (invalid) return invalidArgs("spawn", params, invalid);
      return run("spawn", () =>
        doSpawn(params, ctx.cwd, ctx.sessionManager.getSessionFile()),
      );
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
        "Broadcast a message to every live mux agent in this zellij session — this pane included (the mux_send broadcast action excludes it)",
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
