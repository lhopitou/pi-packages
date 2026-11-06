/**
 * Gondolin Tool Routing Example
 *
 * Runs pi's built-in tools inside a local Gondolin micro-VM. The host working
 * directory is mounted at /workspace in the guest. File changes under
 * /workspace write through to the host; other guest filesystem changes are
 * isolated to the VM.
 *
 * Setup:
 *   cd packages/coding-agent/examples/extensions/gondolin
 *   npm install --ignore-scripts
 *
 * Usage:
 *   cd /path/to/project
 *   pi -e /path/to/pi/packages/coding-agent/examples/extensions/gondolin
 *
 * Requirements:
 *   - Node.js >= 23.6.0 for @earendil-works/gondolin
 *   - QEMU installed (for example, `brew install qemu` on macOS)
 */

import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { RealFSProvider, VM, VmCheckpoint } from "@earendil-works/gondolin";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  type BashOperations,
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  DEFAULT_MAX_BYTES,
  type EditOperations,
  type FindOperations,
  formatSize,
  type GrepToolDetails,
  type GrepToolInput,
  type LsOperations,
  type ReadOperations,
  truncateHead,
  truncateLine,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";

const GUEST_WORKSPACE = "/workspace";
const DEFAULT_GREP_LIMIT = 100;

type TextToolResult<TDetails> = {
  content: Array<{ type: "text"; text: string }>;
  details: TDetails | undefined;
};

function stripAtPrefix(value: string): string {
  return value.startsWith("@") ? value.slice(1) : value;
}

function toPosix(value: string): string {
  return value.split(path.sep).join(path.posix.sep);
}

// ── Path safety ──────────────────────────────────────────────────────────────
// Gondolin's RealFSProvider already blocks symlink escapes at the VFS layer
// (open, stat, readdir on symlinks pointing outside the mount are denied).
// The checks below are lexical only — sufficient defence-in-depth.

function isInsideHostPath(root: string, value: string): boolean {
  const relativePath = path.relative(root, value);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}

// ── Path mapping (host ↔ guest) ─────────────────────────────────────────────

function hostPathToGuest(localCwd: string, hostPath: string): string {
  const relativePath = path.relative(localCwd, hostPath);
  if (!isInsideHostPath(localCwd, hostPath)) return toPosix(hostPath);
  return relativePath
    ? path.posix.join(GUEST_WORKSPACE, toPosix(relativePath))
    : GUEST_WORKSPACE;
}

function toGuestPath(localCwd: string, inputPath: string): string {
  const trimmed = stripAtPrefix(inputPath.trim());
  if (!trimmed) return GUEST_WORKSPACE;
  if (path.isAbsolute(trimmed)) {
    if (isInsideHostPath(localCwd, trimmed))
      return hostPathToGuest(localCwd, trimmed);
    return path.posix.resolve("/", toPosix(trimmed));
  }
  return path.posix.resolve(GUEST_WORKSPACE, toPosix(trimmed));
}

// ── Gondolin-backed tool operations ─────────────────────────────────────────

function createGondolinReadOps(vm: VM, localCwd: string): ReadOperations {
  return {
    readFile: async (filePath) =>
      vm.fs.readFile(toGuestPath(localCwd, filePath)),
    access: async (filePath) => {
      await vm.fs.access(toGuestPath(localCwd, filePath));
    },
    detectImageMimeType: async (filePath) => {
      const ext = path.posix
        .extname(toGuestPath(localCwd, filePath))
        .toLowerCase();
      if (ext === ".png") return "image/png";
      if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
      if (ext === ".gif") return "image/gif";
      if (ext === ".webp") return "image/webp";
      return null;
    },
  };
}

function createGondolinWriteOps(vm: VM, localCwd: string): WriteOperations {
  return {
    writeFile: async (filePath, content) => {
      await vm.fs.writeFile(toGuestPath(localCwd, filePath), content, {
        encoding: "utf8",
      });
    },
    mkdir: async (dirPath) => {
      await vm.fs.mkdir(toGuestPath(localCwd, dirPath), {
        recursive: true,
      });
    },
  };
}

function createGondolinEditOps(vm: VM, localCwd: string): EditOperations {
  const readOps = createGondolinReadOps(vm, localCwd);
  const writeOps = createGondolinWriteOps(vm, localCwd);
  return {
    readFile: readOps.readFile,
    writeFile: writeOps.writeFile,
    access: readOps.access,
  };
}

function createGondolinLsOps(vm: VM, localCwd: string): LsOperations {
  return {
    exists: async (filePath) => {
      try {
        await vm.fs.access(toGuestPath(localCwd, filePath));
        return true;
      } catch {
        return false;
      }
    },
    stat: async (filePath) => vm.fs.stat(toGuestPath(localCwd, filePath)),
    readdir: async (dirPath) => vm.fs.listDir(toGuestPath(localCwd, dirPath)),
  };
}

function createGondolinFindOps(vm: VM, localCwd: string): FindOperations {
  return {
    exists: async (filePath) => {
      try {
        await vm.fs.access(toGuestPath(localCwd, filePath));
        return true;
      } catch {
        return false;
      }
    },
    glob: async (pattern, cwd, options) => {
      const root = toGuestPath(localCwd, cwd);

      // Mirror pi's native fd args exactly.
      let effectivePattern = pattern;
      const args = [
        "fd",
        "--glob",
        "--color=never",
        "--hidden",
        "--no-require-git",
        "--absolute-path",
        "--max-results",
        String(options.limit),
      ];
      if (pattern.includes("/")) {
        args.push("--full-path");
        if (
          !pattern.startsWith("/") &&
          !pattern.startsWith("**/") &&
          pattern !== "**"
        ) {
          effectivePattern = `**/${pattern}`;
        }
      }
      args.push("--", effectivePattern, root);

      const proc = vm.exec(["/bin/sh", "-lc", args.join(" ")]);
      let stdout = "";
      for await (const chunk of proc.output()) stdout += chunk.data;
      const result = await proc;

      if (result.exitCode !== 0 && !stdout.trim()) return [];
      // fd --absolute-path returns absolute POSIX paths — ready for find.js's relativization.
      return stdout.trim().split("\n").filter(Boolean);
    },
  };
}

async function executeGondolinGrep(
  vm: VM,
  localCwd: string,
  params: GrepToolInput,
  readOps: ReadOperations,
  signal?: AbortSignal,
): Promise<TextToolResult<GrepToolDetails>> {
  const guestSearchPath = toGuestPath(localCwd, params.path ?? ".");

  // Determine if search path is a directory (for path display formatting).
  let isDirectory: boolean;
  try {
    const stat = await vm.fs.stat(guestSearchPath, { signal });
    isDirectory = stat.isDirectory();
  } catch {
    return {
      content: [{ type: "text", text: "No matches found" }],
      details: undefined,
    };
  }

  const contextValue =
    params.context && params.context > 0 ? params.context : 0;
  const effectiveLimit = Math.max(1, params.limit ?? DEFAULT_GREP_LIMIT);

  // Build rg args, mirroring pi's native grep.js.
  const args = ["rg", "--json", "--line-number", "--color=never", "--hidden"];
  if (params.ignoreCase) args.push("--ignore-case");
  if (params.literal) args.push("--fixed-strings");
  if (params.glob) args.push("--glob", params.glob);
  args.push("--", params.pattern, guestSearchPath);

  // Run rg inside the VM.  Use abort controller for signal support.
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });

  let stdout = "";
  let aborted = false;
  try {
    const proc = vm.exec(["/bin/sh", "-lc", args.join(" ")], {
      signal: controller.signal,
    });
    for await (const chunk of proc.output()) stdout += chunk.data;
    await proc;
  } catch {
    if (signal?.aborted) aborted = true;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }

  if (aborted) throw new Error("Operation aborted");

  // Parse rg JSON output.  Format matches the same way pi's native grep.js does.
  interface Match {
    filePath: string;
    lineNumber: number;
    lineText?: string;
  }
  const matches: Match[] = [];
  let matchCount = 0;
  let matchLimitReached = false;

  for (const line of stdout.split("\n")) {
    if (!line.trim() || matchCount >= effectiveLimit) continue;
    let event: {
      type?: string;
      data?: {
        path?: { text?: string };
        line_number?: number;
        lines?: { text?: string };
      };
    };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "match") {
      matchCount++;
      const filePath = event.data?.path?.text;
      const lineNumber = event.data?.line_number;
      const lineText = event.data?.lines?.text;
      if (filePath && typeof lineNumber === "number") {
        matches.push({ filePath, lineNumber, lineText });
      }
      if (matchCount >= effectiveLimit) {
        matchLimitReached = true;
        break;
      }
    }
  }

  if (matchCount === 0) {
    return {
      content: [{ type: "text", text: "No matches found" }],
      details: undefined,
    };
  }

  // Format output paths: relativize against search path (same logic as pi's grep.js).
  const formatPath = (filePath: string) => {
    if (!isDirectory) return path.posix.basename(filePath);
    const rel = path.posix.relative(guestSearchPath, filePath);
    if (rel && !rel.startsWith("..")) return rel;
    return path.posix.basename(filePath);
  };

  // Read files for context when contextLines > 0 (mirrors pi's getFileLines).
  const fileCache = new Map<string, string[]>();
  const getFileLines = async (filePath: string) => {
    let lines = fileCache.get(filePath);
    if (!lines) {
      try {
        const content = await readOps.readFile(filePath);
        lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
      } catch {
        lines = [];
      }
      fileCache.set(filePath, lines);
    }
    return lines;
  };

  let linesTruncated = false;
  const outputLines: string[] = [];

  for (const match of matches) {
    if (contextValue === 0 && match.lineText !== undefined) {
      // No context — use the line text from rg's JSON output directly.
      const relativePath = formatPath(match.filePath);
      const sanitized = match.lineText
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "")
        .replace(/\n$/, "");
      const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
      if (wasTruncated) linesTruncated = true;
      outputLines.push(`${relativePath}:${match.lineNumber}: ${truncatedText}`);
    } else {
      // Context mode — read file content and build context block.
      const relativePath = formatPath(match.filePath);
      const lines = await getFileLines(match.filePath);
      if (!lines.length) {
        outputLines.push(
          `${relativePath}:${match.lineNumber}: (unable to read file)`,
        );
        continue;
      }
      const start =
        contextValue > 0
          ? Math.max(1, match.lineNumber - contextValue)
          : match.lineNumber;
      const end =
        contextValue > 0
          ? Math.min(lines.length, match.lineNumber + contextValue)
          : match.lineNumber;
      for (let current = start; current <= end; current++) {
        const lineText = lines[current - 1] ?? "";
        const sanitized = lineText.replace(/\r/g, "");
        const isMatchLine = current === match.lineNumber;
        const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
        if (wasTruncated) linesTruncated = true;
        if (isMatchLine) {
          outputLines.push(`${relativePath}:${current}: ${truncatedText}`);
        } else {
          outputLines.push(`${relativePath}-${current}- ${truncatedText}`);
        }
      }
    }
  }

  const rawOutput = outputLines.join("\n");
  const truncation = truncateHead(rawOutput, {
    maxLines: Number.MAX_SAFE_INTEGER,
  });
  let output = truncation.content;

  const details: GrepToolDetails = {};
  const notices: string[] = [];
  if (matchLimitReached) {
    details.matchLimitReached = effectiveLimit;
    notices.push(
      `${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
    );
  }
  if (truncation.truncated) {
    details.truncation = truncation;
    notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
  }
  if (linesTruncated) {
    details.linesTruncated = true;
    notices.push("Some lines truncated. Use read tool to see full lines");
  }
  if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

  return {
    content: [{ type: "text", text: output }],
    details: Object.keys(details).length > 0 ? details : undefined,
  };
}

function sanitizeEnv(
  env: NodeJS.ProcessEnv | undefined,
): Record<string, string> | undefined {
  if (!env) return undefined;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") result[key] = value;
  }
  return result;
}

function createGondolinBashOps(
  vm: VM,
  localCwd: string,
  shellPath: string,
): BashOperations {
  return {
    exec: async (command, cwd, { onData, signal, timeout, env }) => {
      if (signal?.aborted) throw new Error("aborted");
      const guestCwd = toGuestPath(localCwd, cwd);
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      signal?.addEventListener("abort", onAbort, { once: true });

      let timedOut = false;
      const timer =
        timeout && timeout > 0
          ? setTimeout(() => {
              timedOut = true;
              controller.abort();
            }, timeout * 1000)
          : undefined;

      try {
        const proc = vm.exec([shellPath, "-lc", command], {
          cwd: guestCwd,
          env: sanitizeEnv(env),
          signal: controller.signal,
          stdout: "pipe",
          stderr: "pipe",
        });
        for await (const chunk of proc.output()) onData(chunk.data);
        const result = await proc;
        return { exitCode: result.exitCode };
      } catch (error) {
        if (signal?.aborted) throw new Error("aborted");
        if (timedOut) throw new Error(`timeout:${timeout}`);
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

// ── Config ───────────────────────────────────────────────────────────────────

/** Alpine package → guest binary name for `command -v` probes. */
const PKG_BINARY: Record<string, string> = {
  ripgrep: "rg",
  nodejs: "node",
  // Most packages share the same name as their binary.
};

function guestBinary(pkg: string): string {
  return PKG_BINARY[pkg] ?? pkg;
}

function homeConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return xdg;
  return path.join(os.homedir(), ".pi", "agent");
}

function readConfig(filePath: string): {
  packages?: string[];
  binaries?: Record<string, string>;
  setup?: string[];
} {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Resolve the merged config for a project (packages + binary downloads).
 *
 * Priority (each layer adds to the set, no override):
 *  1. Hardcoded default
 *  2. Global  ~/.config/pi/gondolin.json
 *  3. Project <cwd>/.pi/gondolin.json
 */
function loadPackages(localCwd: string): string[] {
  const merged = new Set<string>();

  // 1. Hardcoded default
  for (const pkg of ["git"]) merged.add(pkg);

  // 2. Global config
  const global = readConfig(path.join(homeConfigDir(), "gondolin.json"));
  for (const pkg of global.packages ?? []) merged.add(pkg);

  // 3. Per-project config
  const project = readConfig(path.join(localCwd, ".pi", "gondolin.json"));
  for (const pkg of project.packages ?? []) merged.add(pkg);

  return [...merged].sort();
}

/** Resolve setup commands — project replaces global. */
function loadSetup(localCwd: string): string[] {
  const global = readConfig(path.join(homeConfigDir(), "gondolin.json"));
  const project = readConfig(path.join(localCwd, ".pi", "gondolin.json"));
  const setup = project.setup ?? global.setup ?? [];
  return Array.isArray(setup) ? setup : [];
}

// ── Extension entry point ───────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const localCwd = process.cwd();
  const packages = loadPackages(localCwd);
  const setup = loadSetup(localCwd);

  // Local (host) tool instances – used as fallback when the VM is unavailable.
  const localRead = createReadTool(localCwd);
  const localWrite = createWriteTool(localCwd);
  const localEdit = createEditTool(localCwd);
  const localBash = createBashTool(localCwd);
  const localGrep = createGrepTool(localCwd);
  const localFind = createFindTool(localCwd);
  const localLs = createLsTool(localCwd);

  let vm: VM | undefined;
  let vmStarting: Promise<VM> | undefined;
  let vmFailed = false;
  let shuttingDown = false;
  let shellPath = "/bin/sh";
  // Alpine package name → guest binary name for tools that were installed.
  const availableTools = new Map<string, string>();

  async function startVm(ctx?: ExtensionContext): Promise<VM> {
    ctx?.ui.setStatus(
      "gondolin",
      ctx.ui.theme.fg("accent", `Gondolin: starting ${GUEST_WORKSPACE}`),
    );

    const checkpointPath = path.join(localCwd, ".pi", "gondolin.qcow2");
    const statePath = path.join(localCwd, ".pi", "gondolin-state.json");
    const currentConfig = JSON.stringify({ packages, setup });

    // ── Try resume from checkpoint ────────────────────────────────────
    if (fs.existsSync(checkpointPath) && fs.existsSync(statePath)) {
      try {
        const savedConfig = fs.readFileSync(statePath, "utf8").trim();
        if (savedConfig === currentConfig) {
          ctx?.ui.setStatus(
            "gondolin",
            ctx.ui.theme.fg("accent", "Gondolin: resuming..."),
          );
          const checkpoint = VmCheckpoint.load(checkpointPath);
          const resumed = await checkpoint.resume({
            sessionLabel: `pi ${path.basename(localCwd)}`,
            vfs: {
              mounts: {
                [GUEST_WORKSPACE]: new RealFSProvider(localCwd),
              },
            },
          });

          vm = resumed;

          // Quick probe for bash + configured tools.
          const bashProbe = await resumed.exec([
            "/bin/sh",
            "-lc",
            "command -v bash || true",
          ]);
          shellPath = bashProbe.stdout.trim() || "/bin/sh";

          for (const pkg of packages) {
            const bin = guestBinary(pkg);
            try {
              const probe = await resumed.exec([
                "/bin/sh",
                "-lc",
                `command -v ${bin} || true`,
              ]);
              if (probe.stdout.trim()) availableTools.set(pkg, bin);
            } catch {
              /* probe failure skips this tool */
            }
          }

          ctx?.ui.setStatus(
            "gondolin",
            ctx.ui.theme.fg(
              "accent",
              `Gondolin: ${resumed.id.slice(0, 8)} (${GUEST_WORKSPACE})`,
            ),
          );
          const bins = [...availableTools.values()];
          const toolNote = bins.length > 0 ? ` Tools: ${bins.join(", ")}.` : "";
          ctx?.ui.notify(
            `Gondolin VM resumed from checkpoint. ${localCwd} is mounted at ${GUEST_WORKSPACE}.${toolNote}`,
            "info",
          );
          return resumed;
        }
        // Config changed — discard stale checkpoint.
        try {
          fs.rmSync(checkpointPath);
        } catch {
          /* ok */
        }
        try {
          fs.rmSync(statePath);
        } catch {
          /* ok */
        }
      } catch {
        // Resume failed (assets missing, corrupt checkpoint, etc.).
        // Discard and fall through to cold boot.
        try {
          fs.rmSync(checkpointPath);
        } catch {
          /* ok */
        }
        try {
          fs.rmSync(statePath);
        } catch {
          /* ok */
        }
      }
    }

    // ── Cold boot ─────────────────────────────────────────────────────
    let created: VM;
    try {
      created = await VM.create({
        sessionLabel: `pi ${path.basename(localCwd)}`,
        vfs: {
          mounts: {
            [GUEST_WORKSPACE]: new RealFSProvider(localCwd),
          },
        },
      });
    } catch (error) {
      vmFailed = true;
      ctx?.ui.setStatus("gondolin", undefined);
      const msg = error instanceof Error ? error.message : String(error);
      ctx?.ui.notify(
        `Gondolin VM failed to start: ${msg}\nAll tools will run directly on the host (no isolation).`,
        "error",
      );
      throw error;
    }

    try {
      const bashProbe = await created.exec([
        "/bin/sh",
        "-lc",
        "command -v bash || true",
      ]);
      shellPath = bashProbe.stdout.trim() || "/bin/sh";
    } catch (error) {
      // VM cannot execute commands (QEMU missing, image corrupt, etc.).
      vmFailed = true;
      vm = undefined;
      ctx?.ui.setStatus("gondolin", undefined);
      try {
        await created.close();
      } catch {
        /* best-effort cleanup */
      }
      const msg = error instanceof Error ? error.message : String(error);
      ctx?.ui.notify(
        `Gondolin VM execution failed: ${msg}\nAll tools will run directly on the host (no isolation).`,
        "error",
      );
      throw error;
    }

    // Probe for configured tools; install via apk only if missing.
    for (const pkg of packages) {
      const bin = guestBinary(pkg);
      try {
        const probe = await created.exec([
          "/bin/sh",
          "-lc",
          `command -v ${bin} || true`,
        ]);
        if (probe.stdout.trim()) {
          availableTools.set(pkg, bin);
          continue;
        }
        ctx?.ui.setStatus(
          "gondolin",
          ctx.ui.theme.fg("accent", `Gondolin: installing ${pkg}...`),
        );
        const install = await created.exec([
          "/bin/sh",
          "-lc",
          `apk add -q ${pkg} 2>&1 || true`,
        ]);
        if (install.exitCode === 0) availableTools.set(pkg, bin);
      } catch {
        // Probe/install failure is non-fatal.
      }
    }

    // Run configured setup commands inside the VM.
    for (const cmd of setup) {
      try {
        ctx?.ui.setStatus(
          "gondolin",
          ctx.ui.theme.fg("accent", `Gondolin: setup...`),
        );
        await created.exec(["/bin/sh", "-lc", cmd]);
      } catch {
        // Setup command failure is non-fatal.
      }
    }

    // Publish the VM only after all probes, installs, and setup commands
    // succeed so ensureVm() never returns a partially-initialized VM.
    vm = created;

    ctx?.ui.setStatus(
      "gondolin",
      ctx.ui.theme.fg(
        "accent",
        `Gondolin: ${created.id.slice(0, 8)} (${GUEST_WORKSPACE})`,
      ),
    );
    const bins = [...availableTools.values()];
    const toolNote = bins.length > 0 ? ` Tools: ${bins.join(", ")}.` : "";
    ctx?.ui.notify(
      `Gondolin VM ready. ${localCwd} is mounted at ${GUEST_WORKSPACE}.${toolNote}`,
      "info",
    );
    return created;
  }

  async function ensureVm(ctx?: ExtensionContext): Promise<VM | null> {
    if (vm) return vm;
    if (vmFailed || shuttingDown) return null;
    if (!vmStarting) {
      vmStarting = startVm(ctx).finally(() => {
        vmStarting = undefined;
      });
    }
    try {
      return await vmStarting;
    } catch {
      // vmFailed was already set inside startVm.
      return null;
    }
  }

  // ── Lifecycle hooks ──────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    await ensureVm(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    shuttingDown = true;
    const activeVm = vm;
    vm = undefined;
    vmStarting = undefined;
    if (!activeVm) return;
    ctx.ui.setStatus(
      "gondolin",
      ctx.ui.theme.fg("muted", "Gondolin: saving checkpoint..."),
    );
    try {
      const checkpointPath = path.join(localCwd, ".pi", "gondolin.qcow2");
      fs.mkdirSync(path.dirname(checkpointPath), { recursive: true });
      await activeVm.checkpoint(checkpointPath);
      // Save config snapshot for resume-time validation.
      const statePath = path.join(localCwd, ".pi", "gondolin-state.json");
      fs.writeFileSync(statePath, JSON.stringify({ packages, setup }));
    } catch {
      // Checkpoint failed — try graceful close as fallback.
      try {
        await activeVm.close();
      } catch {
        /* ok */
      }
    } finally {
      ctx.ui.setStatus("gondolin", undefined);
    }
  });

  // ── /gondolin command ────────────────────────────────────────────────

  pi.registerCommand("gondolin", {
    description: "Show Gondolin VM status or manage checkpoints",
    handler: async (_args, ctx) => {
      // Subcommand: reset
      if (_args[0] === "reset") {
        const checkpointPath = path.join(localCwd, ".pi", "gondolin.qcow2");
        const statePath = path.join(localCwd, ".pi", "gondolin-state.json");
        let removed = false;
        try {
          fs.rmSync(checkpointPath);
          removed = true;
        } catch {
          /* didn't exist */
        }
        try {
          fs.rmSync(statePath);
        } catch {
          /* ok */
        }
        ctx.ui.notify(
          removed
            ? "Gondolin checkpoint cleared. Next session will cold-boot."
            : "No checkpoint found.",
          "info",
        );
        return;
      }

      const activeVm = await ensureVm(ctx);
      if (!activeVm) {
        ctx.ui.notify(
          "Gondolin VM is not available. Tools are running directly on the host.",
          "warning",
        );
        return;
      }
      const tools = [...availableTools.keys()];
      ctx.ui.notify(
        [
          `Gondolin VM: ${activeVm.id}`,
          `Host workspace: ${localCwd}`,
          `Guest workspace: ${GUEST_WORKSPACE}`,
          `Shell: ${shellPath}`,
          `Packages: ${tools.length > 0 ? tools.join(", ") : "none"}`,
        ].join("\n"),
        "info",
      );
    },
  });

  // ── Tool registrations (VM with host fallback) ───────────────────────

  pi.registerTool({
    ...localRead,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      if (!activeVm) return localRead.execute(id, params, signal, onUpdate);
      const tool = createReadTool(GUEST_WORKSPACE, {
        operations: createGondolinReadOps(activeVm, localCwd),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localWrite,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      if (!activeVm) return localWrite.execute(id, params, signal, onUpdate);
      const tool = createWriteTool(GUEST_WORKSPACE, {
        operations: createGondolinWriteOps(activeVm, localCwd),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localEdit,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      if (!activeVm) return localEdit.execute(id, params, signal, onUpdate);
      const tool = createEditTool(GUEST_WORKSPACE, {
        operations: createGondolinEditOps(activeVm, localCwd),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localBash,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      if (!activeVm) return localBash.execute(id, params, signal, onUpdate);
      const tool = createBashTool(GUEST_WORKSPACE, {
        operations: createGondolinBashOps(activeVm, localCwd, shellPath),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localLs,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      if (!activeVm) return localLs.execute(id, params, signal, onUpdate);
      const tool = createLsTool(GUEST_WORKSPACE, {
        operations: createGondolinLsOps(activeVm, localCwd),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localFind,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      if (!activeVm) return localFind.execute(id, params, signal, onUpdate);
      const tool = createFindTool(GUEST_WORKSPACE, {
        operations: createGondolinFindOps(activeVm, localCwd),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localGrep,
    async execute(_id, params, signal, _onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      if (!activeVm) return localGrep.execute(_id, params, signal, _onUpdate);
      const readOps = createGondolinReadOps(activeVm, localCwd);
      return executeGondolinGrep(activeVm, localCwd, params, readOps, signal);
    },
  });

  // ── user_bash override ───────────────────────────────────────────────

  pi.on("user_bash", async (_event, ctx) => {
    const activeVm = await ensureVm(ctx);
    if (!activeVm) return undefined; // let pi use default host bash
    return {
      operations: createGondolinBashOps(activeVm, localCwd, shellPath),
    };
  });

  // ── System prompt adjustment ─────────────────────────────────────────

  pi.on("before_agent_start", async (event, ctx) => {
    const activeVm = await ensureVm(ctx);
    const cwdLine = activeVm ? GUEST_WORKSPACE : localCwd;
    const localLine = `Current working directory: ${localCwd}`;
    const guestLine = activeVm
      ? `Current working directory: ${GUEST_WORKSPACE} (Gondolin VM; host workspace mounted from ${localCwd})`
      : `Current working directory: ${localCwd} (host mode; Gondolin VM unavailable)`;

    const systemPrompt = event.systemPrompt.includes(localLine)
      ? event.systemPrompt.replace(localLine, guestLine)
      : `${event.systemPrompt}\n\n${guestLine}`;
    return { systemPrompt };
  });
}
