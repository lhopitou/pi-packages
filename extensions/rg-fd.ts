/**
 * rg-fd.ts — Exposes ripgrep (rg) and fd as named tools.
 *
 * The default coding agent tends to write `grep`/`find` in bash commands
 * instead of the optimized `rg`/`fd` binaries. By registering `rg`
 * and `fd` as first-class tool names, the model naturally prefers them
 * (matching its training data) while getting the benefits of ripgrep/fd:
 * faster execution, .gitignore respect, and structured output.
 *
 * These tools mirror the built-in grep/find tool schemas so the model
 * can use the same parameters it would pass to those tools.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const MAX_OUTPUT_BYTES = 50 * 1024; // 50KB

function truncateOutput(output: string): string {
  if (Buffer.byteLength(output, "utf8") <= MAX_OUTPUT_BYTES) return output;
  // Keep the tail (most recent results)
  const lines = output.split("\n");
  let kept = "";
  for (let i = lines.length - 1; i >= 0; i--) {
    const candidate = lines.slice(0, i + 1).join("\n");
    if (Buffer.byteLength(candidate, "utf8") > MAX_OUTPUT_BYTES) break;
    kept = candidate;
  }
  const removed = lines.length - kept.split("\n").length;
  return kept + `\n\n[Truncated: ${removed} earlier lines omitted]`;
}

export default function rgFdExtension(pi: ExtensionAPI) {
  // ─── rg tool ─────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "rg",
    label: "rg",
    description:
      "Search file contents for a pattern using ripgrep. Returns matching lines with file paths and line numbers. " +
      "Respects .gitignore. Faster than grep. Output is truncated to 50KB.",
    promptSnippet: "Search file contents with ripgrep (respects .gitignore)",
    promptGuidelines: [
      "Prefer rg over running grep in bash — it's faster and respects .gitignore by default.",
      "Use glob to filter by file type, e.g. glob='*.ts' to search only TypeScript files.",
      "Use context to see surrounding lines for each match.",
    ],
    parameters: Type.Object({
      pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
      path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
      glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
      ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
      literal: Type.Optional(Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" })),
      context: Type.Optional(Type.Number({ description: "Number of lines to show before and after each match (default: 0)" })),
      limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 100)" })),
    }),
    renderCall(args, theme, _context) {
      const pattern = args.pattern ?? "...";
      const path = args.path || ".";
      let text =
        theme.fg("toolTitle", theme.bold("rg")) + " " +
        theme.fg("accent", `/${pattern}/`) +
        theme.fg("toolOutput", ` in ${path}`);
      if (args.glob) text += theme.fg("toolOutput", ` (${args.glob})`);
      if (args.ignoreCase) text += theme.fg("toolOutput", " -i");
      if (args.literal) text += theme.fg("toolOutput", " --literal");
      if (args.limit !== undefined) text += theme.fg("toolOutput", ` limit ${args.limit}`);
      return new Text(text, 0, 0);
    },

    renderResult(result, options, theme, _context) {
      const content = result.content[0];
      const text = content?.type === "text" ? content.text : "";
      if (!text) return new Text("(no output)", 0, 0);

      const lines = text.split("\n");
      const maxLines = options.expanded ? lines.length : 15;
      const displayLines = lines.slice(0, maxLines);
      const remaining = lines.length - maxLines;

      let out = displayLines.map((line) => theme.fg("toolOutput", line)).join("\n");
      if (remaining > 0) {
        out += theme.fg("muted", `\n... (${remaining} more lines, `) + keyHint("app.tools.expand", "expand") + theme.fg("muted", ")");
      }
      return new Text(out, 0, 0);
    },

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const limit = params.limit ?? 100;
      const args = [
        "--line-number",
        "--color=never",
        "--hidden",
        "--max-count", String(limit),
      ];

      if (params.ignoreCase) args.push("--ignore-case");
      if (params.literal) args.push("--fixed-strings");
      if (params.glob) args.push("--glob", params.glob);
      if (params.context && params.context > 0) {
        args.push("--context", String(params.context));
      }

      args.push("--", params.pattern, params.path || ".");

      const { stdout, stderr, code } = await pi.exec("rg", args);

      if (code === 1 && !stdout) {
        return {
          content: [{ type: "text", text: "No matches found" }],
          details: { pattern: params.pattern, path: params.path },
        };
      }

      if (code !== 0 && code !== 1) {
        return {
          content: [{ type: "text", text: `Error: ${stderr || `rg exited with code ${code}`}` }],
          details: { error: true },
        };
      }

      const output = truncateOutput(stdout);
      const matchCount = output.split("\n").filter((l) => !l.startsWith("--") && l.includes(":")).length;
      const limited = matchCount >= limit;

      let text = output;
      if (limited) {
        text += `\n\n[${limit} matches limit reached. Increase limit or refine pattern for more.]`;
      }

      return {
        content: [{ type: "text", text }],
        details: { pattern: params.pattern, path: params.path, limited },
      };
    },
  });

  // ─── fd tool ─────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "fd",
    label: "fd",
    description:
      "Search for files by glob pattern using fd. Returns matching file paths relative to the search directory. " +
      "Respects .gitignore. Faster than find. Output is truncated to 50KB.",
    promptSnippet: "Find files by glob pattern with fd (respects .gitignore)",
    promptGuidelines: [
      "Prefer fd over running find in bash — it's faster and respects .gitignore by default.",
      "Pattern is a glob: '*.ts', '**/*.json', 'src/**/*.spec.ts'.",
    ],
    parameters: Type.Object({
      pattern: Type.String({
        description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
      }),
      path: Type.Optional(Type.String({ description: "Directory to search in (default: current directory)" })),
      limit: Type.Optional(Type.Number({ description: "Maximum number of results (default: 1000)" })),
    }),
    renderCall(args, theme, _context) {
      const pattern = args.pattern ?? "...";
      const path = args.path || ".";
      let text =
        theme.fg("toolTitle", theme.bold("fd")) + " " +
        theme.fg("accent", pattern) +
        theme.fg("toolOutput", ` in ${path}`);
      if (args.limit !== undefined) text += theme.fg("toolOutput", ` limit ${args.limit}`);
      return new Text(text, 0, 0);
    },

    renderResult(result, options, theme, _context) {
      const content = result.content[0];
      const text = content?.type === "text" ? content.text : "";
      if (!text) return new Text("(no output)", 0, 0);

      const lines = text.split("\n");
      const maxLines = options.expanded ? lines.length : 20;
      const displayLines = lines.slice(0, maxLines);
      const remaining = lines.length - maxLines;

      let out = displayLines.map((line) => theme.fg("toolOutput", line)).join("\n");
      if (remaining > 0) {
        out += theme.fg("muted", `\n... (${remaining} more lines, `) + keyHint("app.tools.expand", "expand") + theme.fg("muted", ")");
      }
      return new Text(out, 0, 0);
    },

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const limit = params.limit ?? 1000;
      const args = [
        "--glob",
        "--color=never",
        "--hidden",
        "--no-require-git",
        "--max-results", String(limit),
      ];

      // If pattern contains /, use --full-path and prepend **/ if needed
      // (mirrors the built-in find tool's logic)
      let effectivePattern = params.pattern;
      if (params.pattern.includes("/")) {
        args.push("--full-path");
        if (!params.pattern.startsWith("/") && !params.pattern.startsWith("**/") && params.pattern !== "**") {
          effectivePattern = `**/${params.pattern}`;
        }
      }

      args.push("--", effectivePattern, params.path || ".");

      const { stdout, stderr, code } = await pi.exec("fd", args);

      if (code !== 0 && !stdout) {
        return {
          content: [{ type: "text", text: `Error: ${stderr || `fd exited with code ${code}`}` }],
          details: { error: true },
        };
      }

      if (!stdout.trim()) {
        return {
          content: [{ type: "text", text: "No files found" }],
          details: { pattern: params.pattern, path: params.path },
        };
      }

      const output = truncateOutput(stdout);
      const count = output.split("\n").filter(Boolean).length;
      const limited = count >= limit;

      let text = output;
      if (limited) {
        text += `\n\n[${limit} results limit reached. Increase limit or refine pattern for more.]`;
      }

      return {
        content: [{ type: "text", text }],
        details: { pattern: params.pattern, path: params.path, limited },
      };
    },
  });
}
