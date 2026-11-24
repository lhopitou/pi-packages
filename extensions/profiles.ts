/**
 * Profile Switcher
 *
 * Named system-prompt profiles — a lightweight context switcher. A profile
 * is a markdown file; the active profile's content is appended to the system
 * prompt of every run, so the session behaves as configured for that role.
 *
 * Profile files (loaded at session start and on /profile; project wins on
 * name collision):
 * - ~/.pi/agent/profiles/<name>.md   global
 * - <cwd>/.pi/profiles/<name>.md    project
 *
 * Usage:
 * - pi --profile reviewer         start with a profile (CLI flag)
 * - /profile                      list profiles + the active one
 * - /profile reviewer             switch mid-session (applies next run)
 * - /profile off                  clear
 *
 * The active profile is persisted as a session entry — written immediately on
 * flag activation, switch, and clear — and restored on /resume, /fork,
 * --continue, and /reload; an explicit --profile flag wins.
 *
 * Spawned subagents receive profiles through the mux_spawn `profile`
 * parameter: profile="reviewer".
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const CUSTOM_TYPE = "profile-state";
const NAME = "profile";

interface Profile {
  name: string;
  content: string;
  source: "global" | "project";
}

/** Profile name → profile; project entries overwrite global ones. */
function loadProfiles(cwd: string): Map<string, Profile> {
  const profiles = new Map<string, Profile>();
  const sources: Array<[string, Profile["source"]]> = [
    [join(getAgentDir(), "profiles"), "global"],
    [join(cwd, CONFIG_DIR_NAME, "profiles"), "project"],
  ];
  for (const [dir, source] of sources) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const name = entry.name.slice(0, -".md".length);
      if (!name) continue;
      profiles.set(name, {
        name,
        content: readFileSync(join(dir, entry.name), "utf-8"),
        source,
      });
    }
  }
  return profiles;
}

export default function profilesExtension(pi: ExtensionAPI): void {
  let profiles = new Map<string, Profile>();
  let activeName: string | undefined;

  pi.registerFlag(NAME, {
    description:
      "Start with a named system-prompt profile (~/.pi/agent/profiles or .pi/profiles). See /profile.",
    type: "string",
  });

  function listNames(): string {
    const names = [...profiles.keys()].sort();
    return names.length ? names.join(", ") : "(none defined)";
  }

  function setStatus(ctx: ExtensionContext): void {
    ctx.ui.setStatus(
      NAME,
      activeName
        ? ctx.ui.theme.fg("accent", `profile:${activeName}`)
        : undefined,
    );
  }

  /** Last persisted profile-state entry's name; a null name means "cleared". */
  function persistedName(
    entries: Array<{ type?: string; customType?: string; data?: unknown }>,
  ): string | undefined {
    const last = entries
      .filter((e) => e.type === "custom" && e.customType === CUSTOM_TYPE)
      .pop() as { data?: { name?: string | null } } | undefined;
    return last?.data?.name ?? undefined;
  }

  pi.on("session_start", async (_event, ctx) => {
    profiles = loadProfiles(ctx.cwd);

    // --profile flag wins; otherwise restore from session entries.
    const flag = pi.getFlag(NAME);
    if (typeof flag === "string" && flag) {
      if (profiles.has(flag)) {
        activeName = flag;
        pi.appendEntry(CUSTOM_TYPE, { name: flag });
        ctx.ui.notify(`Profile "${flag}" active.`, "info");
      } else {
        activeName = undefined;
        ctx.ui.notify(
          `Unknown profile "${flag}". Available: ${listNames()}.`,
          "warning",
        );
      }
    } else {
      const name = persistedName(ctx.sessionManager.getEntries());
      if (name && profiles.has(name)) activeName = name;
    }
    setStatus(ctx);
  });

  // Inject the active profile into every run's system prompt. The options
  // are rebuilt per run, so this is stable across turns and survives
  // compaction; switching profiles is a single prompt-section change.
  pi.on("before_agent_start", async (event) => {
    const profile = activeName ? profiles.get(activeName) : undefined;
    if (!profile) return;
    const addition = `<profile name="${profile.name}">\n${profile.content.trim()}\n</profile>`;
    const options = event.systemPromptOptions;
    options.appendSystemPrompt = options.appendSystemPrompt
      ? `${options.appendSystemPrompt}\n\n${addition}`
      : addition;
  });

  pi.registerCommand(NAME, {
    description: "List or switch system-prompt profiles: /profile [name|off]",
    handler: async (args, ctx) => {
      // Reload from disk so new profile files are picked up without /reload.
      profiles = loadProfiles(ctx.cwd);

      const arg = args?.trim();
      if (!arg) {
        const lines = [...profiles.values()]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(
            (p) =>
              `  ${p.name === activeName ? "* " : "  "}${p.name} (${p.source}, ${p.content.split("\n").length} lines)`,
          );
        ctx.ui.notify(
          (lines.length ? lines.join("\n") : "  (no profiles defined)") +
            `\nActive: ${activeName ?? "(none)"} — profiles live in ~/.pi/agent/profiles and .pi/profiles`,
          "info",
        );
        return;
      }
      if (arg === "off" || arg === "none") {
        activeName = undefined;
        pi.appendEntry(CUSTOM_TYPE, { name: null });
        setStatus(ctx);
        ctx.ui.notify("Profile cleared.", "info");
        return;
      }
      const profile = profiles.get(arg);
      if (!profile) {
        ctx.ui.notify(
          `Unknown profile "${arg}". Available: ${listNames()}.`,
          "error",
        );
        return;
      }
      activeName = arg;
      pi.appendEntry(CUSTOM_TYPE, { name: arg });
      setStatus(ctx);
      ctx.ui.notify(
        `Profile "${arg}" (${profile.source}) active — applies from the next message.`,
        "info",
      );
    },
  });
}
