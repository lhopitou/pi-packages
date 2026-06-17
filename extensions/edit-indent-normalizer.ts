/**
 * Edit Indentation Normalizer
 *
 * Fixes "oldText not found" errors caused by tab/space indentation mismatch between
 * the LLM's generated oldText and the actual file content.
 *
 * When an LLM reads a file that uses spaces, it sometimes reconstructs oldText with
 * tabs (or vice versa). Pi's fuzzy match handles Unicode quotes, dashes, and special
 * spaces, but does NOT normalize tab ↔ space. This extension fills that gap by:
 *
 * 1. Hooking tool_call for edit: reads the target file, detects its indentation style,
 *    and normalizes each edit's oldText (and newText) to match.
 * 2. Hooking tool_result for read: appends an indentation hint so the LLM knows
 *    whether the file uses tabs or spaces.
 */

import {
  type ExtensionAPI,
  isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import { readFile } from "fs/promises";
import { resolve } from "path";

// ─── Types ──────────────────────────────────────────────────────────────────

interface IndentStyle {
  /** The indentation character: tab or space */
  char: "\t" | " ";
  /** Indent width (1 for tabs, N for spaces) */
  width: number;
}

// ─── Indentation Detection ──────────────────────────────────────────────────

/**
 * Detect the dominant indentation style of a file.
 *
 * Counts tab-indented and space-indented lines. For spaces, finds the most
 * common difference between consecutive indentation widths (the mode of the
 * indent increments). Defaults to 4-space if no indentation is found.
 */
function detectIndentStyle(content: string): IndentStyle | null {
  const lines = content.split("\n");
  let tabLines = 0;
  const spaceWidths: number[] = [];

  for (const line of lines) {
    if (line.trim() === "") continue;

    const leadingLen = (line.match(/^(\s+)/)?.[1] ?? "").length;
    if (leadingLen === 0) continue;

    if (line.startsWith("\t")) {
      tabLines++;
    } else if (line.startsWith(" ")) {
      spaceWidths.push(leadingLen);
    }
  }

  // No indented lines at all
  if (tabLines === 0 && spaceWidths.length === 0) return null;

  // Tabs dominate
  if (tabLines > spaceWidths.length) {
    return { char: "\t", width: 1 };
  }

  // Spaces dominate – find the most common indent increment
  if (spaceWidths.length > 0) {
    const sorted = [...spaceWidths].sort((a, b) => a - b);
    const diffs: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      const diff = sorted[i] - sorted[i - 1];
      if (diff > 0) diffs.push(diff);
    }

    if (diffs.length === 0) {
      // All lines have the same indent width (e.g., everything at 2 spaces)
      return { char: " ", width: sorted[0] || 4 };
    }

    // Mode of indent increments
    const freq = new Map<number, number>();
    for (const d of diffs) freq.set(d, (freq.get(d) ?? 0) + 1);

    let bestWidth = 4;
    let bestCount = 0;
    for (const [w, c] of freq) {
      if (c > bestCount) {
        bestCount = c;
        bestWidth = w;
      }
    }

    // Heuristic: if the mode is 1 or 2, it might be a degenerate case
    // (e.g., code with only 1-space indent for alignment). Use a higher count
    // threshold. If in doubt, use the smallest plausible width.
    if (bestCount >= 2 || sorted.length >= 3) {
      return { char: " ", width: bestWidth >= 2 ? bestWidth : 4 };
    }
    return { char: " ", width: sorted[0] || 4 };
  }

  return null;
}

/**
 * Detect what indentation style a text snippet uses.
 * More permissive than file-level detection since oldText is often short.
 *
 * Returns the best guess, or null if no indentation is present.
 */
function detectSnippetIndentStyle(text: string): IndentStyle | null {
  const lines = text.split("\n");
  let tabCount = 0;
  let spaceCount = 0;
  const spaceWidths: number[] = [];

  for (const line of lines) {
    if (line.trim() === "") continue;
    const leadingLen = (line.match(/^(\s+)/)?.[1] ?? "").length;
    if (leadingLen === 0) continue;

    if (line.startsWith("\t")) {
      tabCount++;
    } else if (line.startsWith(" ")) {
      spaceCount++;
      spaceWidths.push(leadingLen);
    }
  }

  if (tabCount === 0 && spaceCount === 0) return null;

  if (tabCount >= spaceCount) return { char: "\t", width: 1 };

  // Spaces – guess width from the minimum indentation
  const minWidth = Math.min(...spaceWidths);
  // Most common indent widths are 2, 4, or 8
  for (const w of [2, 4, 8]) {
    if (minWidth % w === 0 && spaceWidths.every((sw) => sw % w === 0)) {
      return { char: " ", width: w };
    }
  }
  return { char: " ", width: minWidth };
}

// ─── Indentation Normalization ──────────────────────────────────────────────

/**
 * Normalize a single line's leading indentation to match the target style.
 *
 * Only leading whitespace is touched; inline tabs/spaces within the line
 * (e.g., inside string literals) are preserved.
 */
function normalizeLineIndent(
  line: string,
  fromStyle: IndentStyle | null,
  toStyle: IndentStyle,
): string {
  const match = line.match(/^([\t ]*)(.*)$/);
  if (!match) return line;

  const [, indent, rest] = match;
  if (indent.length === 0) return line;

  // Compute the logical indent level
  let level: number;
  if (indent.includes("\t")) {
    level = indent.length;
  } else {
    // Prefer the snippet's own detected width; fall back to 4
    const width = fromStyle?.width ?? 4;
    level = Math.round(indent.length / width);
  }

  // Rebuild with target style
  const newIndent =
    toStyle.char === "\t"
      ? "\t".repeat(level)
      : " ".repeat(level * toStyle.width);

  return newIndent + rest;
}

/**
 * Normalize all leading indentation in a text block to match targetStyle.
 *
 * For each line, detects the current logical indent level and rewrites it
 * using the target style's character and width.
 */
function normalizeIndentation(
  text: string,
  targetStyle: IndentStyle,
): string {
  const lines = text.split("\n");
  const snippetStyle = detectSnippetIndentStyle(text);

  // If the snippet already matches the target style, skip
  if (
    snippetStyle &&
    snippetStyle.char === targetStyle.char &&
    snippetStyle.width === targetStyle.width
  ) {
    return text;
  }

  return lines
    .map((line) => normalizeLineIndent(line, snippetStyle, targetStyle))
    .join("\n");
}

// ─── Indent Style Description ───────────────────────────────────────────────

function describeIndent(style: IndentStyle): string {
  if (style.char === "\t") return "tabs";
  return `${style.width}-space indentation`;
}

// ─── Extension ──────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── Edit: normalize indentation in oldText/newText before matching ──────

  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("edit", event)) return;

    const { path, edits } = event.input;
    if (!path || !edits || !Array.isArray(edits) || edits.length === 0)
      return;

    try {
      const absolutePath = resolve(ctx.cwd, path);
      const content = await readFile(absolutePath, "utf-8");
      const fileStyle = detectIndentStyle(content);

      // No indentation in the file – nothing to normalize
      if (!fileStyle) return;

      let modified = false;
      for (const edit of edits) {
        // Normalize oldText for matching
        if (typeof edit.oldText === "string") {
          const normalized = normalizeIndentation(edit.oldText, fileStyle);
          if (normalized !== edit.oldText) {
            edit.oldText = normalized;
            modified = true;
          }
        }
        // Also normalize newText so the edit preserves the file's indentation style
        if (typeof edit.newText === "string") {
          const normalized = normalizeIndentation(edit.newText, fileStyle);
          if (normalized !== edit.newText) {
            edit.newText = normalized;
            modified = true;
          }
        }
      }
    } catch {
      // File doesn't exist or can't be read (e.g., editing a new file).
      // Skip normalization – the write tool handles creation.
    }
  });

  // ── Read: append indentation hint to help LLM generate correct oldText ──

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "read") return;

    // Only annotate text file reads, not images
    const textBlocks = event.content.filter(
      (c) => typeof c === "object" && c !== null && "type" in c && c.type === "text",
    );
    if (textBlocks.length === 0) return;

    const input = event.input as { path?: string } | undefined;
    const rawPath = input?.path;
    if (!rawPath) return;

    try {
      const absolutePath = resolve(ctx.cwd, rawPath);
      const content = await readFile(absolutePath, "utf-8");
      const style = detectIndentStyle(content);

      if (!style) return;

      // Only annotate if the file has significant indentation
      const indentedLines = content
        .split("\n")
        .filter((l) => l.trim() !== "" && (l.startsWith("\t") || l.startsWith(" "))).length;

      if (indentedLines < 3) return;

      const hint = `\n[indent: ${describeIndent(style)}]`;

      // Return modified content with hint appended to the last text block
      const lastText = textBlocks[textBlocks.length - 1] as {
        type: "text";
        text: string;
      };
      if (lastText.text.endsWith(hint)) return;

      const modified = event.content.map((c) => {
        if (c === lastText) {
          return { ...c, text: (c as { text: string }).text + hint };
        }
        return c;
      });

      return { content: modified };
    } catch {
      // File gone or unreadable – fine to skip
    }
  });
}
