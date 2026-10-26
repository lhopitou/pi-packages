/**
 * Tool output modes extension — collapsed / normal / extended
 *
 * Three display modes for every tool block in the transcript:
 *
 * - normal (default): the regular tool view, exactly as Pi renders it by
 *   default (call title plus Pi's built-in result preview on the tool block
 *   background).
 * - collapsed: the whole block — call and result — is one minimal line in the
 *   style of the tool entries shown by `/tree`, on the regular page
 *   background (no block background) with its text in the theme's status
 *   color (success green normally, error red for failures):
 *       bash: rg -n "foo" ~/src
 *       read: ~/fetch/internal/file/request.go:1-150
 *   so scrolling back through a session shows one quiet line per tool call
 *   and the user and assistant messages between them are easy to find.
 * - extended: the full output (Pi's expanded rendering).
 *
 * `ctrl+o` cycles every block through the modes
 * (collapsed → normal → extended → collapsed). New blocks inherit the
 * current mode. While a tool is still running its live preview keeps
 * streaming in the default rendering, then folds up to the collapsed line
 * when it finishes.
 *
 * The mode lives in this module, not per block: blocks render `globalMode`,
 * so a `/reload` resets every block to the default mode together, instead of
 * leaving older blocks on stale per-row state.
 *
 * The mode is advanced by the keypress itself, not by watching core state.
 * `ui.onTerminalInput` fires on raw input before Pi's keybindings, so the
 * extension matches the chunk against whatever key currently triggers the
 * `app.tools.expand` action (`ctrl+o` by default, honors the user's
 * `keybindings.json` remap) and advances the mode optimistically, BEFORE core
 * processes the same chunk. The key is never consumed: core still flips its
 * own 2-state toggle, and that flip is the plumbing that re-renders every
 * block (`setExpanded` on each) — advancing first means those re-renders
 * already draw the new mode. On the next tick the flip is confirmed via
 * `ui.getToolsExpanded()`; if it did not change — an overlay swallowed the
 * key, e.g. the session tree, which binds `ctrl+o` to its own filter cycle —
 * the advance is rolled back, and since no re-render happened, no block
 * ever drew it.
 *
 * Consequences of not reading core's `expanded` per block (an earlier design
 * did, inferring presses from its changes — don't go back): each
 * `ToolExecutionComponent` is born with `expanded: false` and renders from
 * its constructor before interactive-mode applies the real toggle, clicks on
 * a block flip that single block's value, and a press with no tool blocks on
 * screen is unobservable. All of those used to desync the mode.
 *
 * The real mode is shown in the footer via the extension-context's
 * `ui.setStatus` ("Tool view: ..."). Core's transient transcript hint
 * ("Tool output: expanded/collapsed"), written synchronously on the same
 * press, would be misleading — it reflects core's 2-state toggle, not this
 * 3-mode cycle — so the confirmation tick replaces that hint line in place:
 * `ui.notify(text, "info")` routes to the same transcript status line, which
 * holds one message at a time (a new one replaces the previous line while it
 * is still the last transcript element). The user sees "Tool view: ..." in
 * the transcript and footer; core's hint never survives a render.
 *
 * The block renders its own shell (`renderShell: "self"`): core then applies
 * neither background nor padding, so the collapsed line can sit on the page
 * background, and the other modes reproduce the regular block themselves.
 *
 * Applies to every tool — built-in, extension, and MCP — by wrapping whatever
 * renderer the tool would otherwise use.
 *
 * Place in ~/.pi/agent/extensions/ for global access, or .pi/extensions/ for project-local.
 */

import type {
  ExtensionAPI,
  ExtensionUIContext,
  Theme,
  ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
  Box,
  Text,
  getKeybindings,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { appendFileSync } from "node:fs";

/** Debug logging for this extension (PI_OLT_DEBUG=1 → /tmp/olt.log). */
const DEBUG = process.env.PI_OLT_DEBUG === "1";
/** Identifies the module instance, so pre-/post-reload runs are distinguishable. */
const RUNTIME_ID = Math.random().toString(36).slice(2, 6);
function debug(msg: string): void {
  if (!DEBUG) return;
  try {
    appendFileSync("/tmp/olt.log", `${Date.now()} [${RUNTIME_ID}] ${msg}\n`);
  } catch {
    /* logging must never break rendering */
  }
}

type Mode = "collapsed" | "normal" | "extended";
const CYCLE: Record<Mode, Mode> = {
  collapsed: "normal",
  normal: "extended",
  extended: "collapsed",
};
/** The cycle backwards, to undo an optimistic advance. */
const UNCYCLE: Record<Mode, Mode> = {
  collapsed: "extended",
  normal: "collapsed",
  extended: "normal",
};

/** Mode every new block starts in, and the mode `ctrl+o` advances. */
const DEFAULT_MODE: Mode = "collapsed";

/** The one mode every block renders. */
let globalMode: Mode = DEFAULT_MODE;

/** Footer status key under which the current mode is displayed. */
const STATUS_KEY = "olt.mode";

/** Advance the mode one step and show it in the footer status. */
function advanceMode(ui: ExtensionUIContext | undefined): void {
  globalMode = CYCLE[globalMode];
  debug(`keypress -> mode ${globalMode}`);
}

/** Stop the per-second re-render interval bash's renderer arms while streaming. */
function stopRowTimer(state: RowState): void {
  const interval = state.interval as ReturnType<typeof setInterval> | undefined;
  if (interval !== undefined) {
    clearInterval(interval);
    state.interval = undefined;
  }
}

/** Block background tokens, by row status. */
type StatusToken = "toolPendingBg" | "toolSuccessBg" | "toolErrorBg";

type CollapsedStatusToken = "muted" | "success" | "error";

/**
 * Per-row renderer state, shared by the call and result renders of one tool
 * block. Default renderers keep their own keys here too (bash's `startedAt`
 * and `interval`, edit's `callComponent`), so this object is passed to them
 * unmodified and unknown keys are left alone. The mode itself is module
 * state (`globalMode`), not here.
 */
interface RowState {
  /** Components previously returned by the default call/result renderers. */
  callComp?: Component;
  resultComp?: Component;
  /** The collapsed one-line title component, reused across renders. */
  titleLine?: TitleLine;
  /** True once a result (partial or final) has ever been rendered. The
   * title box keeps a bottom padding row only until then, so a pending
   * block is a closed box like core's, while a block with a result has
   * none — core draws call title and result adjacent in one box. */
  hasResult?: boolean;
  [key: number | string]: unknown;
}

function statusToken(isPartial: boolean, isError: boolean): StatusToken {
  if (isPartial) return "toolPendingBg";
  return isError ? "toolErrorBg" : "toolSuccessBg";
}

function collapsedStatusToken(
  isPartial: boolean,
  isError: boolean,
): CollapsedStatusToken {
  if (isPartial) return "muted";
  return isError ? "error" : "success";
}

function shortenPath(path: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (home && path.startsWith(home)) return `~${path.slice(home.length)}`;
  return path;
}

/** A read line range like the built-in titles': `:1-150`, `:10`, or "". */
function lineRange(offset: unknown, limit: unknown): string {
  const num = (value: unknown) => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (
      typeof value === "string" &&
      value.trim() !== "" &&
      Number.isFinite(Number(value))
    )
      return Number(value);
    return undefined;
  };
  if (offset == null && limit == null) return "";
  const start = offset == null ? 1 : num(offset);
  if (start === undefined) return "";
  if (limit == null) return `:${start}`;
  const count = num(limit);
  if (count === undefined) return "";
  const end = start + count - 1;
  return `:${start}${end ? `-${end}` : ""}`;
}

/**
 * The minimal collapsed title, in the style of the tool entries shown by
 * `/tree` (TreeSelectorComponent.formatToolCall).
 */
function treeTitle(toolName: string, args: Record<string, unknown>): string {
  const path = () => shortenPath(String(args.path ?? args.file_path ?? ""));
  const oneLine = (value: unknown) =>
    String(value ?? "")
      .replace(/[\n\t]/g, " ")
      .trim();
  const command = (value: unknown) => {
    const raw = oneLine(value);
    return `${raw.slice(0, 50)}${raw.length > 50 ? "..." : ""}`;
  };

  switch (toolName) {
    case "read":
      return `read: ${path()}${lineRange(args.offset, args.limit)}`;
    case "write":
      return `write: ${path()}`;
    case "edit":
      return `edit: ${path()}`;
    case "bash":
      return `bash: ${command(args.command)}`;
    case "powershell":
      return `powershell: ${command(args.command)}`;
    case "grep":
      return `grep: /${String(args.pattern ?? "")}/ in ${shortenPath(String(args.path ?? "."))}`;
    case "find":
      return `find: ${String(args.pattern ?? "")} in ${shortenPath(String(args.path ?? "."))}`;
    case "ls":
      return `ls: ${shortenPath(String(args.path ?? "."))}`;
    default: {
      const dump = JSON.stringify(args) ?? "";
      return `${toolName}: ${dump.slice(0, 40)}${dump.length > 40 ? "..." : ""}`;
    }
  }
}

/**
 * The collapsed line: the `/tree`-style title in the theme's status color
 * (success green normally, error red for failures), on the regular page
 * background (no background of its own). `theme.colors[token]` resolves a
 * token's concrete color for use in the other slot.
 */
function collapsedTitle(
  toolName: string,
  args: Record<string, unknown>,
  status: CollapsedStatusToken,
  theme: Theme,
): string {
  return theme.style(treeTitle(toolName, args), { fg: theme.colors[status] });
}

/** A component that always renders as exactly one visual line, hard-truncated to the render width. */
class TitleLine implements Component {
  private cachedKey: string | undefined;
  private cachedLines: string[] = [];

  constructor(private text: string) {}

  setText(text: string): void {
    this.text = text;
    this.cachedKey = undefined;
  }

  render(width: number): string[] {
    const key = `${width}\u0000${this.text}`;
    if (key === this.cachedKey) return this.cachedLines;
    const line = this.text
      ? truncateToWidth(this.text.replace(/\n/g, "; "), width, "…")
      : "";
    this.cachedLines = line ? [line] : [];
    this.cachedKey = key;
    return this.cachedLines;
  }

  invalidate(): void {
    this.cachedKey = undefined;
  }
}

/** One blank row; the surrounding Box colors it with the block background. */
class BlankLine implements Component {
  render(_width: number): string[] {
    return [""];
  }

  invalidate(): void {}
}

/**
 * The regular block shell: content on the tool status background, with the
 * original tool renderer's horizontal padding (`Box` padding is symmetric,
 * so the vertical rows are explicit children). Core's geometry has call
 * title and result adjacent inside one padded box, and this reproduces it:
 * the call box's bottom row and the result box's top row are exactly the
 * rows that must not exist between the two.
 */
function blockShell(
  content: Component,
  outputPad: number,
  status: StatusToken,
  theme: Theme,
  topPad: boolean,
  bottomPad: boolean,
): Component {
  const box = new Box(outputPad, 0, (text) => theme.bg(status, text));
  if (topPad) box.addChild(new BlankLine());
  box.addChild(content);
  if (bottomPad) box.addChild(new BlankLine());
  return box;
}

/** Call title for tools without a default renderer: name plus a short argument dump. */
function callFallbackTitle(
  toolName: string,
  args: unknown,
  theme: Theme,
): Component {
  const dump =
    args === undefined ? "" : (JSON.stringify(args) ?? "").slice(0, 80);
  return new Text(
    theme.fg("toolTitle", theme.bold(toolName)) + theme.fg("dim", ` ${dump}`),
    0,
    0,
  );
}

/** Plain result rendering for tools without a default renderer. */
function resultFallbackComponent(
  result: unknown,
  theme: Theme,
  expanded: boolean,
): Component {
  const text: string =
    typeof result === "object" && result !== null && "content" in result
      ? (
          (result as { content?: Array<{ type: string; text?: string }> })
            .content ?? []
        )
          .filter(
            (content) =>
              content.type === "text" && typeof content.text === "string",
          )
          .map((content) => content.text)
          .join("\n")
      : "";
  if (!text) return new Text("", 0, 0);
  const styled = (lines: string[]) =>
    lines.map((line) => theme.fg("toolOutput", line)).join("\n");
  if (expanded) return new Text(styled(text.split("\n")), 0, 0);
  const lines = text.split("\n");
  const shown = lines.slice(0, 10);
  let output = styled(shown);
  if (lines.length > shown.length) {
    output += `\n${theme.fg("muted", `... (${lines.length - shown.length} more lines)`)}`;
  }
  return new Text(output, 0, 0);
}

export default function toolOutputModesExtension(pi: ExtensionAPI) {
  // UI access comes from the ExtensionContext given to event handlers, not
  // from the factory's `pi`. `session_start` fires for startup, reload
  // (reason "reload"), resume, and fork, so the hook is re-armed after a
  // `/reload`; the previous listener is dropped first so only one is live.
  let offInput: (() => void) | undefined;

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    const ui = ctx.ui;

    // Advance the mode on the expand keypress itself. The chunk is matched
    // against the app's keybindings registry, so a user remap of
    // `app.tools.expand` in keybindings.json is honored. The advance is
    // optimistic — it must run before core processes the same chunk, so
    // that the block re-renders core's toggle triggers already draw the
    // new mode — and is rolled back on the next tick if core's toggle did
    // not flip (an overlay, e.g. the session tree, swallowed the key; no
    // re-render happened then, so no block drew the rolled-back mode).
    let coreExpanded = ui.getToolsExpanded();
    offInput?.();
    offInput = ui.onTerminalInput((data) => {
      if (!getKeybindings().matches(data, "app.tools.expand")) return undefined;
      advanceMode(ui);
      setTimeout(() => {
        const now = ui.getToolsExpanded();
        if (now === coreExpanded) {
          globalMode = UNCYCLE[globalMode];
          debug("expand key swallowed by a focused overlay; rolled back");
          return;
        }
        coreExpanded = now;
        // Replace core's just-written "Tool output: ..." hint with the real
        // mode. `notify` with "info" routes to the same transcript status
        // line, whose previous message is replaced in place while it is
        // still the last element — which core's hint is, written
        // synchronously on this very press, before this timeout ran.
        ui.notify(`Tool view: ${globalMode}`, "info");
      }, 0);
      return undefined; // never consume: core must see the key
    });
  });

  pi.registerToolRenderer((toolName, next) => {
    const defaults: ToolRenderers | undefined = next();

    const renderers: ToolRenderers = {
      ...defaults,
      renderShell: "self",

      renderCall(args, theme, context) {
        const state = context.state as RowState;
        const mode = globalMode;
        debug(
          `call ${toolName} id=${context.toolCallId.slice(-8)} mode=${mode}`,
        );
        const status = statusToken(context.isPartial, context.isError);
        const collapsedStatus = collapsedStatusToken(
          context.isPartial,
          context.isError,
        );

        // Collapsed and finished: the whole block is one quiet line, with
        // the original tool renderer's padding but no background of its
        // own (Box without bgFn only pads).
        if (mode === "collapsed" && !context.isPartial) {
          const text = collapsedTitle(
            toolName,
            (args ?? {}) as Record<string, unknown>,
            collapsedStatus,
            theme,
          );
          const titleLine = state.titleLine ?? new TitleLine(text);
          titleLine.setText(text);
          state.titleLine = titleLine;
          const box = new Box(context.outputPad, 0);
          box.addChild(titleLine);
          return box;
        }

        // Normal / extended / still running: the regular call title on
        // the tool status background. The bottom padding row is kept only
        // while no result has ever been rendered (a pending block is a
        // closed box, like core's); once a result exists, the result box
        // supplies the block's bottom row and the title gets none, leaving
        // title and result adjacent as in core's single box. The final
        // result's pass has isPartial false, so non-streaming tools close
        // up immediately; streaming ones may show the row for the single
        // pass before their next partial.
        const component = defaults?.renderCall?.(args, theme, {
          ...context,
          expanded: mode === "extended",
          lastComponent: state.callComp,
        });
        if (component) state.callComp = component;
        return blockShell(
          component ?? callFallbackTitle(toolName, args, theme),
          context.outputPad,
          status,
          theme,
          true,
          context.isPartial && !state.hasResult,
        );
      },

      renderResult(result, options, theme, context) {
        const state = context.state as RowState;
        state.hasResult = true;
        const mode = globalMode;
        debug(
          `result ${toolName} id=${context.toolCallId.slice(-8)} mode=${mode} partial=${options.isPartial}`,
        );
        const status = statusToken(options.isPartial, context.isError);
        const outputPad = context.outputPad;

        // Run the default renderer with the mode's view, feeding it
        // back its own previously returned component, and put the
        // result on the regular tool block background.
        const delegate = (expanded: boolean, isPartial: boolean) => {
          const component = defaults?.renderResult?.(
            result,
            { expanded, isPartial },
            theme,
            { ...context, lastComponent: state.resultComp },
          );
          if (component) state.resultComp = component;
          return component === undefined
            ? undefined
            : blockShell(component, outputPad, status, theme, false, true);
        };

        // While the tool runs, keep the default live preview; the
        // block folds up when the final result lands. Tools without a
        // renderer of their own stream the plain partial output, like
        // core's fallback, rather than a one-line placeholder.
        if (options.isPartial) {
          return (
            delegate(false, true) ??
            blockShell(
              resultFallbackComponent(result, theme, false),
              outputPad,
              status,
              theme,
              false,
              true,
            )
          );
        }

        // Normal / extended: the tool's regular result view.
        if (mode !== "collapsed") {
          const expanded = mode === "extended";
          return (
            delegate(expanded, false) ??
            blockShell(
              resultFallbackComponent(result, theme, expanded),
              outputPad,
              status,
              theme,
              false,
              true,
            )
          );
        }

        // Collapsed final result: nothing beyond the title line. The
        // delegated bash renderer armed a re-render interval that
        // only its result path clears, so clear it here.
        stopRowTimer(state);
        return new Text("", 0, 0);
      },
    };

    return renderers;
  });
}
