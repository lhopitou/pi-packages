/**
 * Working Tree Drift Extension
 *
 * Detects working-tree changes made *outside* the agent's own tool calls —
 * user edits, reverts, commits, branch switches — and injects a compact
 * notice into the conversation so the agent knows its cached view of those
 * files may be stale (e.g. "the user reverted src/a.ts after your last edit").
 *
 * How it works (no polling, no watchers):
 *
 *   1. Snapshots the working tree:
 *        - git repos: HEAD + branch + `git status --porcelain -z` entries,
 *          each entry enriched with the file's mtime+size
 *        - non-git dirs: bounded recursive walk of mtime+size per file
 *   2. Re-snapshots after every mutating tool call (bash/edit/write/custom/
 *      MCP tools), so the agent's own changes are absorbed and never
 *      reported as drift. Read-only tools skip the re-snapshot.
 *   3. At each new user prompt (`before_agent_start`), diffs the current
 *      state against the last snapshot. Any difference — changed file set,
 *      status, content stat, or a moved HEAD — is reported to the agent as
 *      a custom message (plus a TUI notification).
 *
 * The "content unchanged" heuristic: when a file drops out of the git status
 * (or only its status code changed) but its mtime+size still match the last
 * snapshot, the file content is identical to what the agent last saw — e.g.
 * the user merely committed the agent's work — so it is not listed as a
 * changed file (the HEAD move is still reported).
 *
 * Manual check: /drift re-diffs and notifies without starting a turn.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";

const CUSTOM_TYPE = "working-tree-drift";

/** Max files listed in a drift notice before "+N more". */
const MAX_LISTED_FILES = 15;

/** fs-fallback walk caps (git repos never walk). */
const MAX_FS_ENTRIES = 10_000;
const MAX_FS_DEPTH = 16;

/** Directories the fs fallback never descends into. */
const SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".idea",
  ".cache",
  ".gradle",
  ".turbo",
  ".pytest_cache",
  ".mypy_cache",
  "node_modules",
  "__pycache__",
  "venv",
  ".venv",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  ".next",
  ".nuxt",
  ".output",
]);

/**
 * Tools that cannot mutate the working tree — no re-snapshot after these.
 * Unknown/custom/MCP tools are conservatively treated as mutating.
 */
const READ_ONLY_TOOLS = new Set([
  "read",
  "ls",
  "find",
  "grep",
  "glob",
  "ffgrep",
  "fffind",
  "describe_image",
  "web_search",
  "fetch_content",
  "get_search_content",
  "source_check",
  "ask_user",
]);

/** Git command budget per snapshot; on timeout the check is skipped. */
const GIT_TIMEOUT_MS = 5_000;

interface Snapshot {
  kind: "git" | "fs";
  /** Absolute base for entry paths (git repo root, or cwd for fs walks). */
  root: string;
  head: string;
  branch: string;
  /** path → "XY|mtimeMs|size" (git) or "mtimeMs|size" (fs). */
  entries: Map<string, string>;
  /** True when the fs walk hit its caps; membership changes are then unreliable. */
  truncated: boolean;
}

interface DriftDetails {
  files: string[];
  headFrom?: string;
  headTo?: string;
  branchFrom?: string;
  branchTo?: string;
  /** Compact one-line summary (also used for the TUI notification). */
  summary: string;
  /** Full notice text sent to the LLM. */
  content: string;
  timestamp: number;
}

const shortSha = (sha: string): string => (sha ? sha.slice(0, 8) : "(none)");

/** "XY|mtimeMs|size" (git) or "mtimeMs|size" (fs) → recorded stat, if any. */
function parseStat(
  kind: "git" | "fs",
  value: string,
): { mtimeMs?: number; size?: number } {
  const parts = value.split("|");
  const mtimeIdx = kind === "git" ? 1 : 0;
  const mtimeMs = Number(parts[mtimeIdx]);
  const size = Number(parts[mtimeIdx + 1]);
  return {
    mtimeMs: Number.isFinite(mtimeMs) ? mtimeMs : undefined,
    size: Number.isFinite(size) ? size : undefined,
  };
}

async function statSuffix(path: string): Promise<string> {
  try {
    const s = await stat(path);
    return `${s.mtimeMs}|${s.size}`;
  } catch {
    return "-|-";
  }
}

async function execGit(
  pi: ExtensionAPI,
  args: string[],
  cwd: string,
): Promise<string | undefined> {
  try {
    const { stdout, code } = await pi.exec("git", args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
    });
    return code === 0 ? stdout : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Git snapshot: HEAD, branch, and porcelain -z status entries, each enriched
 * with the file's mtime+size. Returns undefined when cwd is not a git repo
 * (or git is unavailable).
 */
async function takeGitSnapshot(
  pi: ExtensionAPI,
  cwd: string,
): Promise<Snapshot | undefined> {
  const statusOut = await execGit(pi, ["status", "--porcelain=v1", "-z"], cwd);
  if (statusOut === undefined) return undefined; // not a repo / git broken

  const root =
    (await execGit(pi, ["rev-parse", "--show-toplevel"], cwd))?.trim() || cwd;
  const head = ((await execGit(pi, ["rev-parse", "HEAD"], cwd)) ?? "").trim();
  const branch = (
    (await execGit(pi, ["rev-parse", "--abbrev-ref", "HEAD"], cwd)) ?? ""
  ).trim();

  const entries = new Map<string, string>();
  // porcelain -z: NUL-separated records "XY PATH", renames/copies followed by
  // an extra record holding the original path.
  const records = statusOut.split("\0");
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record.length < 4) continue;
    const xy = record.slice(0, 2);
    const path = record.slice(3);
    if (xy[0] === "R" || xy[0] === "C") {
      const orig = records[++i];
      if (orig) entries.set(orig, `${xy}>|`);
    }
    entries.set(path, `${xy}|${await statSuffix(join(root, path))}`);
  }
  return { kind: "git", root, head, branch, entries, truncated: false };
}

/** fs fallback for non-git dirs: bounded mtime+size walk. */
async function takeFsSnapshot(cwd: string): Promise<Snapshot> {
  const entries = new Map<string, string>();
  let truncated = false;

  const walk = async (dir: string, depth: number): Promise<void> => {
    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      if (entries.size >= MAX_FS_ENTRIES) {
        truncated = true;
        return;
      }
      const full = join(dir, d.name);
      if (d.isDirectory()) {
        if (depth >= MAX_FS_DEPTH || SKIP_DIRS.has(d.name)) continue;
        await walk(full, depth + 1);
      } else if (d.isFile()) {
        entries.set(relative(cwd, full), await statSuffix(full));
      }
      // symlinks are skipped — avoid cycles and outside-tree noise
    }
  };

  await walk(cwd, 0);
  return { kind: "fs", root: cwd, head: "", branch: "", entries, truncated };
}

/** True when both values carry identical mtime+size (content unchanged). */
function statUnchanged(
  kind: "git" | "fs",
  oldVal: string,
  newVal: string,
): boolean {
  const a = parseStat(kind, oldVal);
  const b = parseStat(kind, newVal);
  return (
    a.mtimeMs !== undefined && a.mtimeMs === b.mtimeMs && a.size === b.size
  );
}

/**
 * True when a path that vanished from git status still exists with the exact
 * mtime+size recorded in the old snapshot — the content is unchanged, only
 * the index/HEAD state moved (e.g. the user committed the agent's work).
 */
async function fileContentUnchanged(
  snap: Snapshot,
  path: string,
  oldVal: string,
): Promise<boolean> {
  const old = parseStat(snap.kind, oldVal);
  if (old.mtimeMs === undefined) return false;
  try {
    const s = await stat(join(snap.root, path));
    return s.mtimeMs === old.mtimeMs && s.size === old.size;
  } catch {
    return false;
  }
}

async function diffSnapshots(
  oldS: Snapshot,
  newS: Snapshot,
): Promise<DriftDetails | undefined> {
  if (oldS.kind !== newS.kind) return undefined; // snapshot mode changed: rebaseline silently

  // With truncated fs snapshots, add/remove detection is unreliable.
  const membership = !oldS.truncated && !newS.truncated;
  const files: string[] = [];

  for (const [path, newVal] of newS.entries) {
    const oldVal = oldS.entries.get(path);
    if (oldVal === newVal) continue;
    if (oldVal !== undefined) {
      // Present in both: only an index-state change (stage/unstage) if content stat matches.
      if (statUnchanged(oldS.kind, oldVal, newVal)) continue;
      files.push(path);
    } else if (membership) {
      files.push(path); // newly dirty/untracked
    }
  }

  if (membership) {
    for (const [path, oldVal] of oldS.entries) {
      if (newS.entries.has(path)) continue;
      // Vanished from status: deleted, reverted, or committed. Skip when the
      // on-disk content is identical to what the agent last saw.
      if (
        oldS.kind === "git" &&
        (await fileContentUnchanged(oldS, path, oldVal))
      )
        continue;
      files.push(path);
    }
  }

  const headMoved = oldS.head !== newS.head;
  const branchMoved =
    oldS.branch !== newS.branch && (oldS.branch !== "" || newS.branch !== "");
  if (files.length === 0 && !headMoved && !branchMoved) return undefined;

  const unique = [...new Set(files)].sort();
  const parts: string[] = [];
  if (unique.length > 0) {
    const shown = unique.slice(0, MAX_LISTED_FILES);
    const rest = unique.length - shown.length;
    parts.push(
      `${unique.length} file${unique.length === 1 ? "" : "s"} changed since your last action: ` +
        `${shown.join(", ")}${rest > 0 ? ` (+${rest} more)` : ""}`,
    );
  }
  if (headMoved)
    parts.push(`HEAD moved ${shortSha(oldS.head)} → ${shortSha(newS.head)}`);
  if (branchMoved) {
    parts.push(
      `branch ${oldS.branch || "(none)"} → ${newS.branch || "(none)"}`,
    );
  }

  const summary = parts.join("; ");
  const content =
    `Working tree drift: ${summary}. These changes were made outside your own tool calls, so ` +
    `re-read the affected files (and check git log/status if HEAD moved) before relying on what ` +
    `you remember of them.`;

  return {
    files: unique,
    headFrom: headMoved ? oldS.head : undefined,
    headTo: headMoved ? newS.head : undefined,
    branchFrom: branchMoved ? oldS.branch : undefined,
    branchTo: branchMoved ? newS.branch : undefined,
    summary,
    content,
    timestamp: Date.now(),
  };
}

export default function (pi: ExtensionAPI) {
  let last: Snapshot | undefined;

  const takeSnapshot = async (cwd: string): Promise<Snapshot | undefined> => {
    try {
      return (await takeGitSnapshot(pi, cwd)) ?? (await takeFsSnapshot(cwd));
    } catch {
      return undefined;
    }
  };

  /** Diff against the last snapshot, then re-baseline. */
  const checkDrift = async (
    ctx: ExtensionContext,
  ): Promise<DriftDetails | undefined> => {
    const now = await takeSnapshot(ctx.cwd);
    if (!now) return undefined;
    const drift =
      last && last.kind === now.kind
        ? await diffSnapshots(last, now)
        : undefined;
    last = now;
    return drift;
  };

  // Baseline at session start (also covers /reload and /resume).
  pi.on("session_start", async (_event, ctx) => {
    last = await takeSnapshot(ctx.cwd);
  });

  // Turn boundary: detect drift since the last snapshot/agent action and
  // inject the notice into the run's context. Only real prompts count —
  // runs started by custom messages skip the check (and keep the drift
  // detectable at the next real prompt).
  pi.on("before_agent_start", async (event, ctx) => {
    if (event.messageType !== "user") return;
    const drift = await checkDrift(ctx);
    if (!drift) return;
    if (ctx.hasUI) ctx.ui.notify(`⚠ ${drift.summary}`, "warning");
    return {
      message: {
        customType: CUSTOM_TYPE,
        content: drift.content,
        display: true,
        details: drift,
      },
    };
  });

  // After every potentially-mutating tool call, absorb the agent's own
  // changes into the baseline so they are never reported as drift.
  pi.on("tool_execution_end", async (event, ctx) => {
    if (READ_ONLY_TOOLS.has(event.toolName)) return;
    last = await takeSnapshot(ctx.cwd);
  });

  // Manual check: re-diff and notify without injecting or starting a turn.
  pi.registerCommand("drift", {
    description:
      "Check for working tree drift (changes made outside the agent's tool calls)",
    handler: async (_args, ctx) => {
      const drift = await checkDrift(ctx);
      if (!ctx.hasUI) return;
      if (!drift) {
        ctx.ui.notify("No working tree drift since the last snapshot", "info");
      } else {
        ctx.ui.notify(`⚠ ${drift.summary}`, "warning");
      }
    },
  });

  // Compact TUI rendering for the injected notice; full file list on expand.
  pi.registerMessageRenderer(
    CUSTOM_TYPE,
    (message, { expanded, outputPad }, theme) => {
      const details = message.details as DriftDetails | undefined;
      const summary = details?.summary ?? String(message.content);
      let text = `${theme.fg("warning", theme.bold("working-tree-drift"))} ${theme.fg("warning", summary)}`;
      if (expanded) {
        const files = details?.files ?? [];
        if (files.length > 0) {
          text += `\n${files.map((f) => theme.fg("muted", `  ${f}`)).join("\n")}`;
        }
        if (details?.headFrom !== undefined) {
          text += `\n${theme.fg("muted", `  HEAD ${shortSha(details.headFrom)} → ${shortSha(details.headTo ?? "")}`)}`;
        }
        if (details?.timestamp) {
          text += `\n${theme.fg("dim", `  detected ${new Date(details.timestamp).toLocaleString()}`)}`;
        }
      }
      const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
      box.addChild(new Text(text, 0, 0));
      return box;
    },
  );
}
