/**
 * rm-tmp Extension
 *
 * Adds /rm-tmp: list every path the agent created this session, then delete
 * them only after an explicit confirmation (Esc or Cancel deletes nothing).
 *
 * The list is recomputed from the current session branch at invocation time,
 * so it survives /reload, /resume, and extension restarts, and it never counts
 * work from abandoned branches. Sources scanned:
 *   - write tool calls (files created or overwritten)
 *   - bash/powershell tool calls, parsed for file-creating operations:
 *     touch, mkdir, tee, cp/mv/install destinations, and > / >> redirections
 *     (including quoted `bash -c "..."` command bodies)
 *
 * Known limitations (heuristic by design): `mktemp` output paths are not
 * knowable at call time, `cd` inside a command is not tracked (relative paths
 * resolve against the session cwd), and only paths that still exist are
 * offered. Deletion always goes through a confirmation dialog.
 *
 * - /rm-tmp        list agent-created paths, then confirm or cancel deletion
 *
 * Tmp paths display and delete collapsed to one level under their tmp root
 * (/tmp/test/file.txt → /tmp/test), deduped. A collapsed root is never the cwd
 * or an ancestor of it — such paths fall back to their full form (or are
 * dropped entirely when even the full path covers the cwd).
 */

import { existsSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

/** Path prefixes sorted first in the list (treated as "tmp"). */
const TMP_PREFIXES = [path.resolve(tmpdir()) + path.sep, "/tmp/", "/var/tmp/"];

/** Commands whose plain arguments are all created paths. */
const ARGS_ARE_PATHS = new Set(["touch", "mkdir", "tee"]);

/** Commands whose last plain argument is the created destination. */
const LAST_ARG_IS_DEST = new Set(["cp", "mv", "install"]);

/** Prefix commands skipped when locating the command word. */
const PREFIX_COMMANDS = new Set([
  "env",
  "sudo",
  "nohup",
  "time",
  "nice",
  "command",
]);

/** Shell interpreters and eval: their payloads are handled by recursion. */
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "eval"]);

/** How deep to recurse into quoted command bodies (bash -c "bash -c ..."). */
const MAX_RECURSION = 3;

interface Token {
  text: string;
  quoted: boolean;
}

/**
 * Add a candidate created path to `out`, filtering out values that cannot be
 * real filesystem paths (fd duplicates, unexpanded variables, globs, devices).
 */
function addPath(out: Set<string>, raw: string, cwd: string): void {
  const t = raw.trim();
  if (!t) return;
  if (t.startsWith("$") || t.startsWith("&")) return; // fd dup or unexpanded var
  if (/[*?[]/.test(t)) return; // glob: actual path unknowable at call time
  if (t.startsWith("/dev/")) return; // /dev/null and friends
  const expanded =
    t === "~" || t.startsWith("~/") ? path.join(homedir(), t.slice(1)) : t;
  out.add(path.resolve(cwd, expanded));
}

/**
 * For a token that is a redirection operator (> >> 2> 2>> &> &>>), return the
 * attached target if any ("" means the target is the next token).
 */
function redirectPathPart(token: string): string | undefined {
  const m = /^(?:\d*>>?|&>>?)(.*)$/.exec(token);
  return m ? m[1] : undefined;
}

/** Split a command line into segments on unquoted `;` `&&` `||` `|` and newlines. */
function splitCommandSegments(line: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = undefined;
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "&" || ch === "\n") {
      segments.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments.map((s) => s.trim()).filter(Boolean);
}

/** Split one command segment into whitespace-separated tokens, stripping quotes. */
function tokenize(segment: string): Token[] {
  const tokens: Token[] = [];
  let current = "";
  let hasCurrent = false;
  let quoted = false;
  let quote: '"' | "'" | undefined;
  const push = () => {
    if (hasCurrent) tokens.push({ text: current, quoted });
    current = "";
    hasCurrent = false;
    quoted = false;
  };
  for (const ch of segment) {
    if (quote) {
      if (ch === quote) {
        quote = undefined;
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      quoted = true;
      hasCurrent = true;
      continue;
    }
    if (/\s/.test(ch)) {
      push();
      continue;
    }
    hasCurrent = true;
    current += ch;
  }
  push();
  return tokens;
}

/** Whether a quoted token looks like a command line worth recursing into. */
function looksLikeCommandLine(text: string): boolean {
  if (/[;|&>\n]/.test(text)) return true;
  for (const cmd of [...ARGS_ARE_PATHS, ...LAST_ARG_IS_DEST]) {
    if (text === cmd || text.startsWith(cmd + " ")) return true;
  }
  return false;
}

/** Collect created paths from one command segment. */
function collectFromSegment(
  segment: string,
  cwd: string,
  out: Set<string>,
  depth: number,
): void {
  const tokens = tokenize(segment);
  if (tokens.length === 0) return;

  // Redirection targets, regardless of the command word.
  for (let i = 0; i < tokens.length; i++) {
    const rest = redirectPathPart(tokens[i].text);
    if (rest === undefined) continue;
    const target = rest !== "" ? rest : tokens[i + 1]?.text;
    if (target) addPath(out, target, cwd);
  }

  // Recurse into quoted command bodies (`bash -c "..."`, `eval '...'`).
  if (depth < MAX_RECURSION) {
    for (const t of tokens) {
      if (t.quoted && looksLikeCommandLine(t.text)) {
        collectFromCommandLine(t.text, cwd, out, depth + 1);
      }
    }
  }

  // Locate the command word, skipping env assignments, flags, and prefixes.
  let word: string | undefined;
  let wordIndex = -1;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i].text;
    if (!t || t.startsWith("-")) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) continue;
    const base = t.includes("/") ? path.posix.basename(t) : t;
    if (PREFIX_COMMANDS.has(base)) continue;
    word = base;
    wordIndex = i;
    break;
  }
  if (!word || wordIndex === -1) return;
  if (SHELLS.has(word)) return; // payload handled by the recursion above

  const plainArgs: string[] = [];
  for (let j = wordIndex + 1; j < tokens.length; j++) {
    const t = tokens[j].text;
    if (t === "--") {
      for (let k = j + 1; k < tokens.length; k++)
        plainArgs.push(tokens[k].text);
      break;
    }
    if (!t.startsWith("-")) plainArgs.push(t);
  }

  if (ARGS_ARE_PATHS.has(word)) {
    for (const arg of plainArgs) addPath(out, arg, cwd);
  } else if (LAST_ARG_IS_DEST.has(word)) {
    // Destination is the -t/--target-directory value, else the last plain arg.
    let dest: string | undefined;
    let fromTargetFlag = false;
    for (let j = wordIndex + 1; j < tokens.length; j++) {
      const t = tokens[j].text;
      if (t === "-t" || t === "--target-directory") {
        dest = tokens[j + 1]?.text;
        fromTargetFlag = true;
        j++;
        continue;
      }
      if (t.startsWith("--target-directory=")) {
        dest = t.slice("--target-directory=".length);
        fromTargetFlag = true;
        continue;
      }
      if (t.startsWith("-")) continue;
      if (!fromTargetFlag) dest = t; // last plain arg wins
    }
    if (dest) addPath(out, dest, cwd);
  }
}

/** Collect created paths from a full command line (exported for tests). */
export function collectFromCommandLine(
  line: string,
  cwd: string,
  out: Set<string>,
  depth = 0,
): void {
  for (const segment of splitCommandSegments(line)) {
    collectFromSegment(segment, cwd, out, depth);
  }
}

/** Created paths from a shell command line, resolved against `cwd`. */
export function createdPathsInCommand(
  command: string,
  cwd: string,
): Set<string> {
  const out = new Set<string>();
  collectFromCommandLine(command, cwd, out);
  return out;
}

/**
 * Scan the current session branch for every path the agent created:
 * write tool calls plus file-creating bash/powershell commands.
 */
export function collectAgentCreatedPaths(
  ctx: ExtensionCommandContext,
): Set<string> {
  const cwd = ctx.cwd;
  const created = new Set<string>();
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role !== "assistant") continue;
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!part || typeof part !== "object" || part.type !== "toolCall")
        continue;
      const args = part.arguments;
      if (part.name === "write" && typeof args.path === "string") {
        addPath(created, args.path, cwd);
      } else if (
        (part.name === "bash" || part.name === "powershell") &&
        typeof args.command === "string"
      ) {
        collectFromCommandLine(args.command, cwd, created);
      }
    }
  }
  return created;
}

/** Short display label for a path: relative to cwd, or ~-abbreviated absolute. */
function displayPath(p: string, cwd: string): string {
  const home = homedir();
  let label = path.relative(cwd, p);
  if (label.startsWith("..")) {
    label = p.startsWith(home + path.sep) ? "~" + p.slice(home.length) : p;
  }
  let suffix = "";
  try {
    suffix = statSync(p).isDirectory() ? "/" : "";
  } catch {
    // raced with deletion; keep no suffix
  }
  return label + suffix;
}

const isTmp = (p: string): boolean =>
  TMP_PREFIXES.some((prefix) => p.startsWith(prefix));

/** Whether `a` is `b` or an ancestor of it. */
const covers = (a: string, b: string): boolean =>
  a === b || b.startsWith(a + path.sep);

/**
 * For a path under a tmp root, its first level: /tmp/test/file.txt → /tmp/test.
 * Returns null for paths not under a tmp root (or the tmp root itself).
 */
function tmpRoot(p: string): string | null {
  for (const prefix of TMP_PREFIXES) {
    if (p.startsWith(prefix)) {
      const rest = p.slice(prefix.length);
      if (rest === "") return null;
      const slash = rest.indexOf("/");
      return prefix + (slash === -1 ? rest : rest.slice(0, slash));
    }
  }
  return null;
}

/** Warning appended when a delete target is a directory. */
function dirNote(targets: readonly string[]): string {
  const hasDir = targets.some((t) => {
    try {
      return statSync(t).isDirectory();
    } catch {
      return false;
    }
  });
  return hasDir
    ? "\n\nDirectories are deleted recursively, including contents the agent did not create."
    : "";
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("rm-tmp", {
    description: "Delete files the agent created this session (list + confirm)",
    handler: async (_args, ctx) => {
      const created = [...collectAgentCreatedPaths(ctx)].filter(
        (p) => existsSync(p) && p !== ctx.cwd,
      );
      if (created.length === 0) {
        ctx.ui.notify(
          "No agent-created files found in this session (or they are already gone).",
          "info",
        );
        return;
      }

      // Tmp paths collapse to one level under their tmp root (/tmp/test/file.txt → /tmp/test).
      // A collapsed root must never be the cwd or an ancestor of it: fall back to the
      // full path, and drop the path entirely if even that would cover the cwd.
      const targets: string[] = [];
      const seen = new Set<string>();
      for (const p of created) {
        let t = tmpRoot(p) ?? p;
        if (covers(t, ctx.cwd)) t = p;
        if (covers(t, ctx.cwd)) continue;
        if (!seen.has(t)) {
          seen.add(t);
          targets.push(t);
        }
      }
      if (targets.length === 0) {
        ctx.ui.notify(
          "No deletable agent-created paths this session (paths covering the working directory are protected).",
          "info",
        );
        return;
      }
      // Tmp paths first, then alphabetical.
      targets.sort(
        (a, b) => Number(isTmp(b)) - Number(isTmp(a)) || a.localeCompare(b),
      );
      const labels = targets.map((p) => displayPath(p, ctx.cwd));

      if (!ctx.hasUI) {
        ctx.ui.notify(
          `Agent-created paths this session (${targets.length}; no interactive UI to confirm deletion):\n` +
            labels.map((l) => `  ${l}`).join("\n"),
          "info",
        );
        return;
      }

      const DELETE_ALL = `Delete all (${targets.length})`;
      const CANCEL = "Cancel";
      const title =
        `Agent-created paths this session (${targets.length})` +
        (targets.length < created.length
          ? " — tmp paths collapsed to their top level"
          : "");
      const choice = await ctx.ui.select(title + " — pick one, or an action", [
        ...labels,
        DELETE_ALL,
        CANCEL,
      ]);
      if (choice === undefined || choice === CANCEL) {
        ctx.ui.notify("Cancelled — nothing deleted.", "info");
        return;
      }

      let toDelete: string[];
      if (choice === DELETE_ALL) {
        const ok = await ctx.ui.confirm(
          `Delete all ${targets.length} paths?`,
          labels.map((l) => `  ${l}`).join("\n") +
            dirNote(targets) +
            "\n\nThis cannot be undone.",
        );
        if (!ok) {
          ctx.ui.notify("Cancelled — nothing deleted.", "info");
          return;
        }
        toDelete = targets;
      } else {
        const target = targets[labels.indexOf(choice)];
        const ok = await ctx.ui.confirm(
          "Delete this path?",
          `${displayPath(target, ctx.cwd)}${dirNote([target])}\n\nThis cannot be undone.`,
        );
        if (!ok) {
          ctx.ui.notify("Cancelled — nothing deleted.", "info");
          return;
        }
        toDelete = [target];
      }

      const failures: string[] = [];
      for (const t of toDelete) {
        try {
          rmSync(t, { recursive: true, force: true });
        } catch (e) {
          failures.push(`${displayPath(t, ctx.cwd)}: ${String(e)}`);
        }
      }
      if (failures.length === 0) {
        ctx.ui.notify(`Deleted ${toDelete.length} path(s).`, "info");
      } else {
        ctx.ui.notify(
          `Deleted ${toDelete.length - failures.length}/${toDelete.length}. Failures:\n` +
            failures.map((f) => `  ${f}`).join("\n"),
          "warning",
        );
      }
    },
  });
}
