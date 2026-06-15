import { complete } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

const MEMORY_FILE = ".agents/MEMORY.md";
const MEMORY_HEADER = "# Agent Memory\n\nCorrections, facts, and preferences learned from sessions.\n";

export default function (pi: ExtensionAPI) {
  // ── Inject memories into context at session start ──
  pi.on("before_agent_start", async (_event, ctx) => {
    const memoryPath = resolve(ctx.cwd, MEMORY_FILE);
    if (!existsSync(memoryPath)) return;

    const content = readFileSync(memoryPath, "utf-8").trim();
    if (!content || content === MEMORY_HEADER.trim()) return;

    // Extract just the bullet items (skip the header)
    const lines = content
      .split("\n")
      .filter((l) => l.startsWith("- "))
      .join("\n");

    if (!lines) return;

    return {
      message: {
        customType: "auto-memory",
        content: `## Learned Memories\n\n${lines}\n\nThese are corrections and preferences from past sessions. Follow them.`,
        display: false,
      },
    };
  });

  // ── /save-memories command ──
  pi.registerCommand("save-memories", {
    description: "Extract corrections from this session and save to memory file",
    handler: async (_args, ctx) => {
      const memoryPath = resolve(ctx.cwd, MEMORY_FILE);

      // Read existing memories
      const existingMemories = existsSync(memoryPath)
        ? readFileSync(memoryPath, "utf-8").trim()
        : "";

      // Collect conversation from session
      const entries = ctx.sessionManager.getEntries();
      const conversation: string[] = [];

      for (const entry of entries) {
        if (entry.type !== "message") continue;
        const msg = (entry as any).message;
        if (!msg) continue;

        if (msg.role === "user") {
          const text =
            typeof msg.content === "string"
              ? msg.content
              : Array.isArray(msg.content)
                ? msg.content
                    .filter((b: any) => b.type === "text")
                    .map((b: any) => b.text)
                    .join("\n")
                : "";
          if (text) conversation.push(`[User]: ${text}`);
        } else if (msg.role === "assistant") {
          const textParts = Array.isArray(msg.content)
            ? msg.content
                .filter((b: any) => b.type === "text")
                .map((b: any) => b.text)
                .join("\n")
            : "";
          if (textParts) conversation.push(`[Assistant]: ${textParts}`);
        }
      }

      if (conversation.length === 0) {
        ctx.ui.notify("No conversation to extract memories from.", "info");
        return;
      }

      const conversationText = conversation.join("\n\n");

      // Build extraction prompt
      const existingSection = existingMemories
        ? `\n## Existing memories (currently in MEMORY.md):\n${existingMemories}\n`
        : "\n## Existing memories:\n(none — this is the first save)\n";

      const prompt = `You are a memory extraction assistant. Analyze the conversation below and extract corrections, facts, and preferences that the user gave to the agent.

## Rules:
- Extract ONLY things the user explicitly corrected, stated as a fact about the project, or expressed as a preference.
- Do NOT extract task instructions (e.g. "add a column for email") — only things that should persist across sessions.
- Each memory should be a single concise bullet point.
- If a new correction contradicts an existing memory, mark the old one for removal and the new one for addition.
- If a new correction updates an existing memory (e.g. "actually it's /api/v3 not /api/v2"), mark the old one for update.
- If an existing memory is not contradicted, leave it untouched.
- Deduplicate: don't add a memory that already exists with the same meaning.
- Today's date is ${new Date().toISOString().split("T")[0]}.

${existingSection}

## Conversation:
${conversationText}

## Output format:
Respond with a JSON object with exactly these keys:
- "add": array of strings (new memories to add, each as a single concise sentence)
- "update": array of objects with "old" (exact existing bullet text, minus the "- [date]" prefix) and "new" (replacement sentence)
- "remove": array of strings (exact existing bullet texts to remove, minus the "- [date]" prefix)

If no changes are needed, return empty arrays.
Respond with ONLY the JSON object, no other text.`;

      // Use the current session model for extraction
      const model = ctx.model;
      if (!model) {
        ctx.ui.notify("No model available for extraction.", "error");
        return;
      }

      // Resolve auth for the model
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok) {
        ctx.ui.notify(`Auth failed for extraction model: ${auth.error}`, "error");
        return;
      }

      ctx.ui.notify("Extracting memories...", "info");

      try {
        const response = await complete(
          model,
          {
            messages: [
              {
                role: "user" as const,
                content: [{ type: "text" as const, text: prompt }],
                timestamp: Date.now(),
              },
            ],
          },
          {
            apiKey: auth.apiKey,
            headers: auth.headers,
            maxTokens: 2000,
            temperature: 0,
          },
        );

        const responseText = response.content
          .filter((c: any): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join("")
          .trim();

        // Parse the JSON response
        let changes: {
          add: string[];
          update: { old: string; new: string }[];
          remove: string[];
        };

        try {
          // Strip markdown code fences if present
          const jsonText = responseText
            .replace(/^```json?\n?/, "")
            .replace(/\n?```$/, "")
            .trim();
          changes = JSON.parse(jsonText);
        } catch (e) {
          ctx.ui.notify("Failed to parse extraction result. Raw output saved to console.", "error");
          console.error("Extraction response:", responseText);
          return;
        }

        const { add = [], update = [], remove = [] } = changes;

        // Check if there are any changes
        if (add.length === 0 && update.length === 0 && remove.length === 0) {
          ctx.ui.notify("No new memories found in this session.", "info");
          return;
        }

        // Build change summary for review
        const summaryLines: string[] = [];
        for (const item of add) {
          summaryLines.push(`  📝 NEW: ${item}`);
        }
        for (const item of update) {
          summaryLines.push(`  ✏️ UPDATE: ${item.old}  →  ${item.new}`);
        }
        for (const item of remove) {
          summaryLines.push(`  🗑️ REMOVE: ${item}`);
        }

        const summary = summaryLines.join("\n");
        const approved = await ctx.ui.confirm(
          `Save these memory changes?`,
          summary,
        );

        if (!approved) {
          ctx.ui.notify("No changes saved.", "info");
          return;
        }

        // Build current memory lines from existing file
        let currentLines = existingMemories
          ? existingMemories
              .split("\n")
              .filter((l: string) => l.startsWith("- "))
          : [];

        // Apply removals — match by the text portion (after date prefix if present)
        for (const item of remove) {
          currentLines = currentLines.filter((l: string) => {
            // Strip "- [date] " prefix for comparison
            const text = l.replace(/^- \[\d{4}-\d{2}-\d{2}\] /, "- ");
            return text !== `- ${item}` && l !== `- ${item}`;
          });
        }

        // Apply updates
        const today = new Date().toISOString().split("T")[0];
        for (const { old, new: newSentence } of update) {
          const idx = currentLines.findIndex((l: string) => {
            const text = l.replace(/^- \[\d{4}-\d{2}-\d{2}\] /, "- ");
            return text === `- ${old}` || l === `- ${old}`;
          });
          if (idx !== -1) {
            currentLines[idx] = `- [${today}] ${newSentence}`;
          }
        }

        // Apply additions
        for (const item of add) {
          const sentence = item.startsWith("- ") ? item.slice(2) : item;
          currentLines.push(`- [${today}] ${sentence}`);
        }

        // Write the memory file
        const dir = dirname(memoryPath);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }

        const newContent = MEMORY_HEADER + currentLines.join("\n") + "\n";
        writeFileSync(memoryPath, newContent, "utf-8");

        const saveSummary = [
          add.length && `+${add.length} added`,
          update.length && `~${update.length} updated`,
          remove.length && `-${remove.length} removed`,
        ]
          .filter(Boolean)
          .join(", ");

        ctx.ui.notify(`Memories saved (${summary})`, "info");
      } catch (err: any) {
        ctx.ui.notify(`Memory extraction failed: ${err.message}`, "error");
        console.error(err);
      }
    },
  });
}
