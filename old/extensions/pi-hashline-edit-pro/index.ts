import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile } from "fs/promises";
import { join, isAbsolute } from "path";
import { computeLineHashes, formatHashlineRegion } from "./src/hashline";
import { registerReplaceTool } from "./src/replace";
import { registerReadTool } from "./src/read";
import { normalizeToLF } from "./src/replace-diff";
import { getVisibleLines } from "./src/utils";

export default function (pi: ExtensionAPI): void {
  registerReadTool(pi);
  registerReplaceTool(pi);

  // Disable the built-in `edit` tool so the model uses `replace` instead.
  pi.on("session_start", async (_event, ctx) => {
    const active = pi.getActiveTools();
    pi.setActiveTools(active.filter((t) => t !== "edit"));
  });

  // Auto-read after write: append hashline read output to write results
  // so the model immediately has anchors for subsequent edits.
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "write" || event.isError) return;

    const filePath = (event.input as Record<string, unknown>)?.path;
    if (typeof filePath !== "string") return;

    try {
      const absolutePath = isAbsolute(filePath) ? filePath : join(ctx.cwd, filePath);
      const content = await readFile(absolutePath, "utf-8");

      // Normalize and compute hashline output
		const normalized = normalizeToLF(content);
		const visibleLines = getVisibleLines(normalized);

      if (visibleLines.length === 0) return;

      // Truncate to a reasonable limit to avoid excessive token usage
      const MAX_LINES = 2000;
      const truncated = visibleLines.length > MAX_LINES;
      const displayLines = truncated ? visibleLines.slice(0, MAX_LINES) : visibleLines;

      const hashes = computeLineHashes(normalized);
      const selectedHashes = hashes.slice(0, displayLines.length);
      const hashlineOutput = formatHashlineRegion(selectedHashes, displayLines);

      // Add pagination hint if truncated
      const paginationHint = truncated
        ? `\n\n[Showing lines 1-${MAX_LINES} of ${visibleLines.length}. Use offset=${MAX_LINES + 1} to continue.]`
        : "";

      if (hashlineOutput) {
        return {
          content: [
            ...(event.content ?? []),
            { type: "text", text: `\n\n--- Auto-read (hashline anchors) ---\n${hashlineOutput}${paginationHint}` },
          ],
        };
      }
    } catch {
      // Auto-read failure should not affect write result
    }
  });

  const debugValue = process.env.PI_HASHLINE_DEBUG;
  if (debugValue === "1" || debugValue === "true") {
    pi.on("session_start", async (_event, ctx) => {
      ctx.ui.notify("Hashline Edit mode active", "info");
    });
  }
}
