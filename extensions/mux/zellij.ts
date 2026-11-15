/**
 * zellij — raw CLI wrappers used by the mux tool.
 *
 * Multiplexer-agnostic by construction: mux's socket layer never touches
 * zellij; only this module would be ported for another multiplexer. All
 * commands run against the session this process lives in (zellij injects
 * `ZELLIJ_SESSION_NAME`, and actions without `--session` target it).
 *
 * Verified behaviors relied on (zellij 0.46):
 * - `new-pane` / `new-tab` print the created pane/tab id to stdout.
 * - `list-panes --json` includes `tab_id` per pane; ids are unique per pane
 *   kind only (terminal and plugin panes can share a number), so liveness
 *   correlation always filters `is_plugin`.
 * - `dump-screen` strips ANSI by default.
 * - `send-keys` / `close-pane` / `dump-screen` accept a bare pane number.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ZellijPane {
  id: number;
  is_plugin: boolean;
  title: string;
  exited: boolean;
  exit_status: number | null;
  tab_id: number;
  tab_name: string;
}

/**
 * Canonicalize a pane id to the bare pane number ("17" ≡ "terminal_17").
 * Both sides of the mesh (descriptor filenames and tool `pane` arguments)
 * must canonicalize or discovery misses.
 */
export function normalizePaneId(pane: string): string {
  return pane.trim().replace(/^(terminal|plugin)_/, "");
}

/** Run a zellij action and return trimmed stdout. Throws on failure. */
async function zellij(args: string[], timeoutMs = 10_000): Promise<string> {
  try {
    const { stdout } = await execFileAsync("zellij", args, {
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : ((err as { stderr?: string })?.stderr ?? String(err));
    throw new Error(`zellij ${args.join(" ")} failed: ${message}`);
  }
}

export async function listPanes(): Promise<ZellijPane[]> {
  return JSON.parse(
    await zellij(["action", "list-panes", "--json"]),
  ) as ZellijPane[];
}

/** Viewport dump of a pane; ANSI codes stripped by zellij by default. */
export async function dumpScreen(paneId: string): Promise<string> {
  return zellij(["action", "dump-screen", "--pane-id", paneId], 15_000);
}

/** Press keys in a pane, e.g. `sendKeys(pane, "ctrl c")`. */
export async function sendKeys(paneId: string, keys: string): Promise<void> {
  await zellij([
    "action",
    "send-keys",
    "--pane-id",
    paneId,
    ...keys.split(" "),
  ]);
}

export async function closePane(paneId: string): Promise<void> {
  await zellij(["action", "close-pane", "--pane-id", paneId]);
}

export interface SpawnArgs {
  name: string;
  cwd: string;
  focus: boolean;
  /** Full argv exec'd directly — no shell, so env forwarding goes through `env`. */
  argv: string[];
}

/**
 * Open a new pane and return the created bare pane id (zellij prints
 * `terminal_<id>`).
 */
export async function newPane(
  args: SpawnArgs & { direction: "right" | "down" },
): Promise<string> {
  const cli = [
    "action",
    "new-pane",
    "--name",
    args.name,
    "--cwd",
    args.cwd,
    "--direction",
    args.direction,
  ];
  if (!args.focus) cli.push("--no-focus");
  cli.push("--", ...args.argv);
  return normalizePaneId(await zellij(cli));
}

/**
 * Open a new tab and return its numeric tab id (zellij prints the tab id,
 * not a pane id — callers resolve the pane via `list-panes` by `tab_id`).
 */
export async function newTab(args: SpawnArgs): Promise<number> {
  const cli = ["action", "new-tab", "--name", args.name, "--cwd", args.cwd];
  if (!args.focus) cli.push("--no-focus");
  cli.push("--", ...args.argv);
  return Number(await zellij(cli));
}

/** Resolve the non-plugin pane living in a tab, by tab id. */
export function paneInTab(
  panes: ZellijPane[],
  tabId: number,
): ZellijPane | undefined {
  return panes.find((p) => !p.is_plugin && p.tab_id === tabId);
}
