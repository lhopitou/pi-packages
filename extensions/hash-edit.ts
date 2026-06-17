/**
 * Hashline Edit Extension
 *
 * Replaces str_replace exact-text matching with content-anchored line references.
 * Every line in a read file gets a LINE#HASH: prefix. The LLM copies those opaque
 * anchors into edit operations. The extension resolves anchors to actual line
 * numbers, reads the file, computes oldText from the file, and rewrites the edit
 * input so Pi's built-in edit tool (with its fuzzy matching, line-ending
 * normalization, and diff rendering) handles the actual file mutation.
 *
 * This eliminates whitespace-mismatch failures, non-unique-match failures, and
 * token waste from reproducing old text. It also detects stale-file conditions
 * via hash mismatch instead of silent no-ops.
 *
 * Architecture:
 *  - tool_result for read:  appends LINE#HASH anchors to file output
 *  - tool_call for edit:    transforms hashline ops into Pi's oldText/newText format
 *  - tool_result for edit:  appends fresh anchors after successful edits
 *
 * The hashline edit format:
 *   { path, edits: [{ op, pos, end?, lines }] }
 *
 *   ops: replace (pos only = single line; pos..end = span), append, prepend
 *   pos/end: "LINE#HASH" anchors copied verbatim from read output
 *   lines: literal file content with exact indentation (no LINE#HASH prefixes)
 */

import {
  type ExtensionAPI,
  isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import { readFile } from "fs/promises";
import { resolve } from "path";

// ─── Hash ───────────────────────────────────────────────────────────────────

/** djb2 hash of trimmed line content, folded to 1 byte → 2 hex chars */
function hashLine(content: string): string {
  let hash = 5381;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) + hash + content.charCodeAt(i)) | 0;
  }
  return ((hash >>> 0) % 256).toString(16).padStart(2, "0");
}

// ─── Anchor Parsing ─────────────────────────────────────────────────────────

/** Parse "LINE#HASH" anchor string into line number and hash. Returns null on failure. */
function parseAnchor(raw: string): { line: number; hash: string } | null {
  const m = raw.match(/^(\d+)#([0-9a-f]{2})$/);
  if (!m) return null;
  return { line: parseInt(m[1], 10), hash: m[2] };
}

// ─── Read Hook ──────────────────────────────────────────────────────────────

/**
 * After a file is read, append LINE#HASH anchors as a header block.
 * The model copies these anchors verbatim into edit calls.
 *
 * Format:
 *   [anchors: /path/to/file]
 *   1#a3:import { foo } from "bar";
 *   2#f1:
 *   3#9c:export function main() {
 *   ...
 */
// ─── Prompt Guidance ────────────────────────────────────────────────────────

/**
  * Injected into the system prompt so the LLM understands the LINE#HASH format.
  * These are prompt fragments, not tool descriptions — the built-in read/edit
  * tools keep their standard descriptions. This guidance tells the model how to
  * interpret the anchored output and how to construct hashline edit calls.
  */
const HASHLINE_GUIDANCE = `
## Hashline Editing

Every read of a text file shows [anchors: path] followed by LINE#HASH:content.
Copy those anchors verbatim into edit calls — they are the only way edits
address lines.

### edit with anchors

Batch every change to a file into one edit call. The format is:
{
    "path": "src/file.ts",
    "edits": [
        { "op": "replace", "pos": "12#MQ", "lines": ["const x = 1;"] },
        { "op": "replace", "pos": "5#VR", "end": "8#QV", "lines": [
            "function greet() {",
            "  return 'hello';",
            "}"
        ] },
        { "op": "append", "pos": "20#XZ", "lines": ["// new comment"] },
        { "op": "prepend", "pos": "1#AA", "lines": ["// header"] }
    ]
}

Ops:
- replace: replace the single line at pos, or the inclusive span pos..end.
    lines is the complete new content for the whole span; lines: [] deletes it.
    Without end, exactly one line is replaced no matter how many entries lines has.
- append: insert lines after pos; omit pos to append at end of file.
- prepend: insert lines before pos; omit pos to insert at start of file.

Rules:
- lines is literal file content with exact indentation. Never include
    LINE#HASH: prefixes, diff +/- markers, or copies of neighboring lines —
    repeating a boundary line duplicates it in the file.
- Anchors are opaque: copy them exactly, never compute, shift, or guess one.
- Edits in one call must not overlap or touch adjacent lines — merge such
    changes into a single edit span.

After a successful edit, the result includes --- Anchors A-B --- with fresh
LINE#HASH lines for the changed region. Use them directly for nearby follow-up
edits; re-read the file for distant changes.

On [E_STALE_ANCHOR], retry with the >>> lines quoted in the error instead of
re-reading the whole file.
`;

export default function (pi: ExtensionAPI) {
    // ── Inject hashline guidance into the system prompt ────────────────────

    pi.on("before_agent_start", async (event, _ctx) => {
        // Only append if not already present
        if (event.systemPrompt.includes("Hashline Editing")) return;
        return { systemPrompt: event.systemPrompt + HASHLINE_GUIDANCE };
    });

    // ── Read: replace output with hashline-anchored lines ──────────────────

    pi.on("tool_result", async (event, ctx) => {
        if (event.toolName !== "read") return;

    const input = event.input as { path?: string; offset?: number; limit?: number };
    const rawPath = input?.path;
    if (!rawPath) return;

    // Only annotate text reads, not images
    const textBlocks = event.content.filter(
      (c) =>
        typeof c === "object" && c !== null && "type" in c && c.type === "text",
    );
    if (textBlocks.length === 0) return;

    // Skip if the read failed (error text)
    if (event.isError) return;

    try {
      const absolutePath = resolve(ctx.cwd, rawPath);
      const fileContent = await readFile(absolutePath, "utf-8");
      const allLines = fileContent.split("\n");

      // Build hashline anchors for the displayed portion
      const offset = input.offset ?? 1;
      const limit = input.limit ?? allLines.length;
      const startIdx = Math.max(0, offset - 1);
      const endIdx = Math.min(allLines.length, startIdx + limit);

      const header = `[anchors: ${rawPath}]`;
      const anchorLines: string[] = [];
      for (let i = startIdx; i < endIdx; i++) {
        const lineNum = i + 1;
        const h = hashLine(allLines[i].trimEnd());
        anchorLines.push(`${lineNum}#${h}:${allLines[i]}`);
      }

      const anchorBlock = header + "\n" + anchorLines.join("\n");

      // Replace the first text block with the anchored version;
      // keep any subsequent text blocks (truncation notices, etc.)
      const modified = event.content.map((c, i) => {
        if (i === 0 && c === textBlocks[0]) {
          return { ...c, text: anchorBlock };
        }
        return c;
      });

      return { content: modified };
    } catch {
      // File disappeared or unreadable — leave output unchanged
    }
  });

  // ─── Edit Hook: transform hashline ops into oldText/newText ──────────────

  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("edit", event)) return;

    const { path, edits } = event.input as {
      path: string;
      edits: Record<string, unknown>[];
    };
    if (!path || !edits || !Array.isArray(edits) || edits.length === 0) return;

    // Detect if this is a hashline-format edit (has op field) or standard (has oldText)
    const firstEdit = edits[0] as Record<string, unknown>;
    if (!("op" in firstEdit) || "oldText" in firstEdit) {
      // Standard Pi edit format — pass through unchanged
      return;
    }

    // Hashline format detected — resolve anchors and rewrite
    try {
      const absolutePath = resolve(ctx.cwd, path);
      const fileContent = await readFile(absolutePath, "utf-8");
      const fileLines = fileContent.split("\n");

      const standardEdits: { oldText: string; newText: string }[] = [];

      for (const edit of edits) {
        const op = edit.op as string;
        const posRaw = edit.pos as string | undefined;
        const endRaw = edit.end as string | undefined;
        const lines = (edit.lines as string[] | undefined) ?? [];

        // Resolve anchors
        const posAnchor = posRaw ? parseAnchor(posRaw) : null;
        const endAnchor = endRaw ? parseAnchor(endRaw) : null;

        // Validate pos anchor when present
        if (posAnchor) {
          const actualLine = fileLines[posAnchor.line - 1] ?? "";
          const expectedHash = hashLine(actualLine.trimEnd());
          if (expectedHash !== posAnchor.hash) {
            // Stale anchor — return error with fresh anchors
            const freshAnchors = buildFreshAnchors(
              fileLines,
              posAnchor.line,
              endAnchor?.line ?? posAnchor.line,
            );
            return {
              block: true,
              reason:
                `[E_STALE_ANCHOR] Anchor ${posRaw} does not match ` +
                `current file content at line ${posAnchor.line}. ` +
                `The file has changed since the last read. Re-read the region ` +
                `and retry with fresh anchors.\n\n` +
                `Current content at this region:\n` +
                freshAnchors,
            };
          }
        }

        if (endAnchor && endRaw) {
          const actualEndLine = fileLines[endAnchor.line - 1] ?? "";
          const expectedEndHash = hashLine(actualEndLine.trimEnd());
          if (expectedEndHash !== endAnchor.hash) {
            const freshAnchors = buildFreshAnchors(
              fileLines,
              posAnchor?.line ?? endAnchor.line,
              endAnchor.line,
            );
            return {
              block: true,
              reason:
                `[E_STALE_ANCHOR] End anchor ${endRaw} does not match ` +
                `current file content at line ${endAnchor.line}. Re-read and retry.\n\n` +
                `Current content:\n${freshAnchors}`,
            };
          }
        }

        // Compute oldText and newText based on operation
        const { oldText, newText } = computeEdit(
          op,
          fileLines,
          posAnchor,
          endAnchor,
          lines,
        );

        standardEdits.push({ oldText, newText });
      }

      // Mutate the input in place — Pi's built-in edit tool will handle the rest
      (event.input as Record<string, unknown>).edits = standardEdits;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        block: true,
        reason: `[E_HASHLINE_ERROR] ${message}`,
      };
    }
  });

  // ─── Edit Result Hook: append fresh anchors after successful edits ───────

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "edit") return;
    if (event.isError) return;

    const input = event.input as { path?: string; edits?: unknown[] };
    const rawPath = input?.path;
    if (!rawPath) return;

    // Only annotate if the edit used hashline format (detected from input shape)
    const edits = input?.edits as Record<string, unknown>[] | undefined;
    if (!edits || edits.length === 0) return;
    if (!("op" in (edits[0] ?? {}))) return;

    try {
      const absolutePath = resolve(ctx.cwd, rawPath);
      const fileContent = await readFile(absolutePath, "utf-8");
      const fileLines = fileContent.split("\n");

      // Find the affected line range from the edit operations
      let minLine = Infinity;
      let maxLine = -Infinity;

      for (const edit of edits) {
        const posRaw = edit.pos as string | undefined;
        const endRaw = edit.end as string | undefined;

        const posAnchor = posRaw ? parseAnchor(posRaw) : null;
        const endAnchor = endRaw ? parseAnchor(endRaw) : null;

        if (posAnchor) {
          minLine = Math.min(minLine, posAnchor.line);
          maxLine = Math.max(maxLine, posAnchor.line);
        }
        if (endAnchor) {
          maxLine = Math.max(maxLine, endAnchor.line);
        }

        // For append/prepend without pos, the affected region is start/end of file
        const op = edit.op as string;
        const lines = (edit.lines as string[] | undefined) ?? [];
        if (!posAnchor && (op === "append" || op === "prepend")) {
          if (op === "append") {
            // After EOF → affected region is at end
            maxLine = Math.max(maxLine, fileLines.length);
            minLine = Math.min(minLine, fileLines.length - lines.length + 1);
          } else {
            // Before BOF → affected region is at start
            minLine = Math.min(minLine, 1);
            maxLine = Math.max(maxLine, lines.length);
          }
        }
      }

      if (minLine === Infinity || maxLine === -Infinity) return;

      // Expand range slightly to show context
      const ctxStart = Math.max(1, minLine);
      const ctxEnd = Math.min(fileLines.length, maxLine + 2);

      const freshAnchors = buildFreshAnchors(fileLines, ctxStart, ctxEnd);

      const anchorBlock = `\n\n--- Anchors ${ctxStart}-${ctxEnd} ---\n${freshAnchors}`;

      // Append to the last text block
      const textBlocks = event.content.filter(
        (c) =>
          typeof c === "object" &&
          c !== null &&
          "type" in c &&
          c.type === "text",
      );
      if (textBlocks.length === 0) return;

      const lastText = textBlocks[textBlocks.length - 1] as {
        type: "text";
        text: string;
      };
      if (lastText.text.includes("--- Anchors")) return; // already annotated

      const modified = event.content.map((c) => {
        if (c === lastText) {
          return { ...c, text: (c as { text: string }).text + anchorBlock };
        }
        return c;
      });

      return { content: modified };
    } catch {
      // File changed or unreadable — skip anchor annotation
    }
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Compute oldText and newText for Pi's standard edit format from a hashline operation.
 *
 * Strategy:
 *   replace(pos):          oldText = line at pos, newText = replacement
 *   replace(pos, end):     oldText = span from pos to end, newText = replacement
 *   replace(pos, end) with lines:[]: oldText = span, newText = "" (delete)
 *   append(pos):           oldText = line at pos, newText = line + "\n" + newLines
 *   append(no pos):        oldText = last line of file, newText = last line + "\n" + newLines
 *   prepend(pos):          oldText = line at pos, newText = newLines + "\n" + line
 *   prepend(no pos):       oldText = first line, newText = newLines + "\n" + first line
 *
 * Using oldText = existing line + newText = line + newContent ensures the existing
 * line text still matches exactly in the file, while the new content is inserted
 * around it.
 */
function computeEdit(
  op: string,
  fileLines: string[],
  posAnchor: { line: number; hash: string } | null,
  endAnchor: { line: number; hash: string } | null,
  newLines: string[],
): { oldText: string; newText: string } {
  const newContent = newLines.join("\n");

  switch (op) {
    case "replace": {
      if (!posAnchor) {
        throw new Error("replace op requires a pos anchor");
      }
      if (endAnchor && endAnchor.line >= posAnchor.line) {
        // Span replace: pos..end inclusive
        const startIdx = posAnchor.line - 1;
        const endIdx = endAnchor.line - 1;
        const oldSpan = fileLines.slice(startIdx, endIdx + 1).join("\n");
        return { oldText: oldSpan, newText: newContent };
      }
      // Single line replace
      const line = fileLines[posAnchor.line - 1] ?? "";
      return { oldText: line, newText: newContent };
    }

    case "append": {
      if (posAnchor) {
        // Append after pos
        const line = fileLines[posAnchor.line - 1] ?? "";
        return { oldText: line, newText: line + "\n" + newContent };
      }
      // Append at EOF
      const lastLine = fileLines[fileLines.length - 1] ?? "";
      return { oldText: lastLine, newText: lastLine + "\n" + newContent };
    }

    case "prepend": {
      if (posAnchor) {
        // Prepend before pos
        const line = fileLines[posAnchor.line - 1] ?? "";
        return { oldText: line, newText: newContent + "\n" + line };
      }
      // Prepend at BOF
      const firstLine = fileLines[0] ?? "";
      return { oldText: firstLine, newText: newContent + "\n" + firstLine };
    }

    default:
      throw new Error(
        `Unknown hashline operation: "${op}". Supported ops: replace, append, prepend.`,
      );
  }
}

/**
 * Build fresh LINE#HASH anchors for a line range.
 * Used for stale-anchor error messages and post-edit anchor blocks.
 */
function buildFreshAnchors(
  fileLines: string[],
  startLine: number,
  endLine: number,
): string {
  const lines: string[] = [];
  for (let i = Math.max(0, startLine - 1); i < Math.min(fileLines.length, endLine); i++) {
    const lineNum = i + 1;
    const h = hashLine(fileLines[i].trimEnd());
    lines.push(`${lineNum}#${h}:${fileLines[i]}`);
  }
  return lines.join("\n");
}