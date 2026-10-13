/**
 * Observation Masking — Zero-LLM-cost context reduction for Pi
 *
 * Masks raw tool result bodies from older turns while keeping reasoning chains,
 * tool names/arguments, and user/assistant messages fully intact.
 * Deterministic placeholders preserve provider-side prefix caching.
 *
 * Commands:
 *   /mask on|off            Enable/disable (default: on)
 *   /mask keep <N>          Turns to keep fully intact (default: 5)
 *   /mask keep-errors on|off Keep error tool results unmasked (default: on)
 *   /mask status            Show config + session savings
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

// ── Types ───────────────────────────────────────────────────────

interface MaskConfig {
  enabled: boolean;
  keepTurns: number;
  keepErrors: boolean;
}

interface SessionStats {
  maskedCount: number;
  tokensBefore: number;
  tokensAfter: number;
}

// ── Defaults ────────────────────────────────────────────────────

const DEFAULT_CONFIG: MaskConfig = {
  enabled: true,
  keepTurns: 5,
  keepErrors: true,
};

/** Rough token estimate: chars ÷ 4 (no tokenizer available in extensions). */
function estTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

const MASK_PLACEHOLDER = (
  toolName: string,
  tokenCount: number,
): string => `[Tool output masked: ${toolName} — ~${tokenCount.toLocaleString()} tokens]`;

// ── Config persistence ──────────────────────────────────────────

const CONFIG_FILE = join(homedir(), ".pi", "agent", "observation-masking.json");

async function loadConfig(): Promise<MaskConfig> {
  try {
    const raw = await readFile(CONFIG_FILE, "utf8");
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

async function saveConfig(config: MaskConfig): Promise<void> {
  await mkdir(dirname(CONFIG_FILE), { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
}

// ── Message helpers ─────────────────────────────────────────────
//
// Pi's internal message format (as seen in the `context` event):
//   User:       { role: "user",      content: [{ type: "text", text: "..." }] }
//   Assistant:  { role: "assistant", content: [{ type: "text", text: "..." }, { type: "toolCall", id, name, input }] }
//   ToolResult: { role: "toolResult", toolCallId: "...", toolName: "read", content: [{ type: "text", text: "..." }], isError: false }

interface ContentBlock {
  type?: string;
  text?: string;
  [key: string]: unknown;
}

interface AgentMessage {
  role?: string;
  content?: ContentBlock[] | null;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  [key: string]: unknown;
}

function isRealUserMessage(msg: AgentMessage): boolean {
  return msg.role === "user";
}

function isToolResult(msg: AgentMessage): boolean {
  return msg.role === "toolResult";
}

function isErrorResult(msg: AgentMessage): boolean {
  return msg.isError === true;
}

function getToolName(msg: AgentMessage): string {
  return msg.toolName || (msg.toolCallId ? msg.toolCallId.slice(0, 12) : "unknown");
}

/**
 * Sum the text content from all text-type blocks in a message.
 */
function contentCharCount(msg: AgentMessage): number {
  if (!Array.isArray(msg.content)) return 0;
  let total = 0;
  for (const block of msg.content) {
    if (block.type === "text" && typeof block.text === "string") {
      total += block.text.length;
    }
  }
  return total;
}

/**
 * Replace the content blocks of a tool result message with a single
 * deterministic placeholder text block. Modifies the message in place.
 */
function maskMessage(msg: AgentMessage, placeholder: string): void {
  msg.content = [{ type: "text", text: placeholder }];
}

// ── Core masking logic ──────────────────────────────────────────

interface MaskResult {
  messages: AgentMessage[];
  maskedCount: number;
  tokensBefore: number;
  tokensAfter: number;
}

function applyMasking(
  messages: AgentMessage[],
  config: MaskConfig,
): MaskResult {
  const result: MaskResult = {
    messages,
    maskedCount: 0,
    tokensBefore: 0,
    tokensAfter: 0,
  };

  if (!config.enabled || messages.length === 0) return result;

  // 1. Find turn boundaries — indices of real user messages
  const boundaries: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (isRealUserMessage(messages[i])) {
      boundaries.push(i);
    }
  }
  if (boundaries.length === 0) return result;

  // 2. Determine the first message index to keep intact
  const keepFromIndex =
    boundaries.length > config.keepTurns && config.keepTurns > 0
      ? boundaries[boundaries.length - config.keepTurns]
      : config.keepTurns === 0
        ? messages.length // mask everything
        : 0; // keepTurns >= total turns → keep everything

  if (keepFromIndex === 0) return result;

  // 3. Mask tool results in older turns
  for (let i = 0; i < keepFromIndex; i++) {
    const msg = messages[i];
    if (!isToolResult(msg)) continue;

    // Optionally skip error results
    if (config.keepErrors && isErrorResult(msg)) continue;

    const charCount = contentCharCount(msg);
    if (charCount === 0) continue;

    const toolName = getToolName(msg);
    const tokEstimate = estTokens(charCount);
    const placeholder = MASK_PLACEHOLDER(toolName, tokEstimate);

    // Skip masking when placeholder would be LONGER than the original output
    // (e.g. 12-char "hello world" vs 40-char placeholder = net increase)
    if (placeholder.length >= charCount) continue;

    maskMessage(msg, placeholder);

    result.maskedCount++;
    result.tokensBefore += tokEstimate;
    result.tokensAfter += estTokens(placeholder.length);
  }

  return result;
}

// ── Extension entry point ───────────────────────────────────────

export default async function (pi: ExtensionAPI) {
  // Load persistent config
  let config = await loadConfig();
  let sessionStats: SessionStats = { maskedCount: 0, tokensBefore: 0, tokensAfter: 0 };
  let lastMaskResult: MaskResult | null = null;
  /** Actual input token count reported by the provider in the last assistant message (preferred). */
  let lastProviderInputTokens: number | null = null;

  // ── Status bar helper ────────────────────────────────────────

  function formatTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
    return String(n);
  }

  function updateStatus(ctx: any): void {
    if (!ctx?.ui?.setStatus) return;

    if (!config.enabled) {
      ctx.ui.setStatus("obs-mask", "ObsMask: off");
      return;
    }

    const contextWindow = ctx.model?.contextWindow;
    // Only show provider-reported input tokens — the chars÷4 estimate is misleading
    // because it only sees new-turn messages, not the full context (system prompt, tools, etc.)
    if (lastProviderInputTokens != null && contextWindow) {
      const pct = Math.round((lastProviderInputTokens / contextWindow) * 100);
      ctx.ui.setStatus(
        "obs-mask",
        `ObsMask: ${formatTokens(lastProviderInputTokens)}/${formatTokens(contextWindow)} (${pct}%)`,
      );
    } else {
      const errNote = config.keepErrors ? "" : " (no-err)";
      const turnLabel = config.keepTurns === 0 ? "all" : String(config.keepTurns);
      ctx.ui.setStatus("obs-mask", `ObsMask: keep ${turnLabel}${errNote}`);
    }
  }

  // ── Event: context — the core masking hook ───────────────────

  pi.on("context", async (event, ctx) => {
    try {
      const messages = (event.messages ?? []) as AgentMessage[];

      lastMaskResult = applyMasking(messages, config);


      if (lastMaskResult.maskedCount > 0) {
        sessionStats.maskedCount += lastMaskResult.maskedCount;
        sessionStats.tokensBefore += lastMaskResult.tokensBefore;
        sessionStats.tokensAfter += lastMaskResult.tokensAfter;
      }

      return { messages: lastMaskResult.messages };
    } catch (err) {
      return undefined;
    }
  });

  // ── Event: session_start — reset stats, show status ──────────

  pi.on("session_start", async (_event, ctx) => {
    sessionStats = { maskedCount: 0, tokensBefore: 0, tokensAfter: 0 };
    lastMaskResult = null;
    updateStatus(ctx);
  });

  // ── Event: agent_end — extract provider token count, update status ──

  pi.on("agent_end", async (_event, ctx) => {
    // Extract input token count from the last assistant message.
    // Providers split usage into input (new) + cacheRead (cached) — we want the total.
    const messages = _event.messages as AgentMessage[];
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i] as any;
      if (msg.role === "assistant" && msg.usage) {
        const u = msg.usage;
        // input = new non-cached tokens, cacheRead = cached tokens
        // totalTokens = input + cacheRead + output (safe fallback)
        lastProviderInputTokens =
          (u.input != null && u.cacheRead != null) ? u.input + u.cacheRead
          : u.totalTokens ?? u.input ?? null;
        break;
      }
    }

    if (lastMaskResult && lastMaskResult.maskedCount > 0) {
      const saved = lastMaskResult.tokensBefore - lastMaskResult.tokensAfter;
      if (saved > 250) {
        ctx.ui.notify(
          `ObsMask: ${lastMaskResult.maskedCount} outputs masked (~${saved.toLocaleString()} est. tokens saved this turn)`,
          "info",
        );
      }
    }
    updateStatus(ctx);
  });

  // ── Command: /mask ────────────────────────────────────────────

  pi.registerCommand("mask", {
    description: "Control observation masking (on|off|keep|keep-errors|status)",
    handler: async (args, ctx) => {
      const parts = (args ?? "").trim().split(/\s+/);
      const sub = parts[0] ?? "";
      const rest = parts.slice(1).join(" ");

      switch (sub) {
        // ── /mask on ──────────────────────────────────────────
        case "on":
          config.enabled = true;
          await saveConfig(config);
          ctx.ui.notify(
            `Observation masking ON — keeping last ${config.keepTurns} turns intact`,
            "info",
          );
          updateStatus(ctx);
          break;

        // ── /mask off ─────────────────────────────────────────
        case "off":
          config.enabled = false;
          await saveConfig(config);
          ctx.ui.notify("Observation masking OFF — full context exposed", "info");
          updateStatus(ctx);
          break;

        // ── /mask keep <N> ────────────────────────────────────
        case "keep": {
          const n = parseInt(parts[1], 10);
          if (isNaN(n) || n < 0) {
            ctx.ui.notify("Usage: /mask keep <number>  (0 = mask all, 5 = default)", "error");
            return;
          }
          config.keepTurns = n;
          await saveConfig(config);
          const label = n === 0 ? "Masking all tool results" : `Keeping last ${n} turns intact`;
          ctx.ui.notify(label, "info");
          updateStatus(ctx);
          break;
        }

        // ── /mask keep-errors on|off ──────────────────────────
        case "keep-errors": {
          const val = rest.toLowerCase();
          if (val === "on" || val === "true") {
            config.keepErrors = true;
            ctx.ui.notify("Error tool results will remain UNMASKED", "info");
          } else if (val === "off" || val === "false") {
            config.keepErrors = false;
            ctx.ui.notify("Error tool results will also be masked", "info");
          } else {
            ctx.ui.notify(
              `Error preservation: ${config.keepErrors ? "ON" : "OFF"}\nUse /mask keep-errors on|off`,
              "info",
            );
            return;
          }
          await saveConfig(config);
          updateStatus(ctx);
          break;
        }

        // ── /mask status ──────────────────────────────────────
        case "status":
        case "stats":
        case "": {
          const savedTokens = sessionStats.tokensBefore - sessionStats.tokensAfter;

          const lines = [
            `ObsMask: ${config.enabled ? "✅ enabled" : "❌ disabled"}`,
            `Turns kept intact: ${config.keepTurns}${config.keepTurns === 0 ? " (all masked)" : ""}`,
            `Error preservation: ${config.keepErrors ? "on" : "off"}`,
          ];

          // Provider-reported context usage (real numbers from the API)
          const cw = ctx.model?.contextWindow;
          if (lastProviderInputTokens != null && cw) {
            const pct = Math.round((lastProviderInputTokens / cw) * 100);
            lines.push(
              ``,
              `Context (provider): ${lastProviderInputTokens.toLocaleString()} / ${cw.toLocaleString()} tokens (${pct}%)`,
            );
          }

          lines.push(
            ``,
            `Session savings (chars ÷ 4 estimates):`,
            `  Outputs masked:  ${sessionStats.maskedCount}`,
            `  Est. saved:      ~${savedTokens.toLocaleString()} tokens`,
          );
          if (lastMaskResult?.maskedCount) {
            const lastSaved = lastMaskResult.tokensBefore - lastMaskResult.tokensAfter;
            lines.push(`  Last turn saved: ~${lastSaved.toLocaleString()} tokens (${lastMaskResult.maskedCount} outputs)`);
          }
          ctx.ui.notify(lines.join("\n"), "info");
          break;
        }

        default:
          ctx.ui.notify(
            [
              "/mask on               Enable masking",
              "/mask off              Disable masking",
              "/mask keep <N>         Turns to keep intact (default: 5)",
              "/mask keep 0           Mask ALL tool results",
              "/mask keep-errors on   Keep error outputs unmasked",
              "/mask keep-errors off  Mask errors too",
              "/mask status           Show config and savings",
            ].join("\n"),
            "info",
          );
          break;
      }
    },
  });
}
