/**
 * Fastfetch-style startup header.
 *
 * Replaces pi's built-in startup header with a fastfetch-style layout: the pi
 * mascot on the left, aligned key/value rows on the right showing pi info
 * instead of OS info — version, active model + thinking level, cwd, theme,
 * and the loaded resources (context files, skills, prompt templates,
 * extensions), plus registered tools and the session file. Long resource
 * lists wrap onto indented continuation lines; the mascot is dropped
 * automatically on narrow terminals.
 *
 * The resource rows mirror pi's own startup listing section by section
 * (interactive-mode.js):
 *
 * - context: SYSTEM.md, APPEND_SYSTEM.md, then the AGENTS.md/CLAUDE.md chain,
 *   formatted like pi's formatContextPath (cwd-relative or ~-shortened).
 *   Sourced from the live system prompt + pi's discovery conventions.
 * - skills: names of ALL loaded skills (including disableModelInvocation
 *   ones), scanned from pi's skill roots — user agent dir, project .pi/skills,
 *   ancestor .agents/skills dirs, ~/.agents/skills, and package sources.
 * - prompts: /name entries from pi's prompt roots (same scopes).
 * - extensions: pi-style labels from pi's extension roots, filtered by the
 *   settings/packages +, -, ! override patterns with pi's precedence
 *   (! exclude < + force-include < - force-exclude).
 *
 * CLI resource flags are honored by parsing pi's own process.argv:
 * -e/--extension, --skill, --prompt-template add temporary sources (resolved
 * from the cwd; builtin: extensions are hidden like pi hides them), and
 * -ne/--no-extensions, -ns/--no-skills, -np/--no-prompt-templates disable
 * discovery while explicit paths still load — mirroring pi. The context rows
 * come from the live system prompt, so -nc and similar are reflected
 * automatically.
 *
 * Everything is best-effort display logic: scan failures degrade to empty
 * rows, never a crash. Snapshots are rebuilt on session_start (including
 * /reload, /new, /resume) and on /model switches (model_select).
 *
 * Commands:
 *   builtin-header  restore pi's stock startup header
 */

import {
  VERSION,
  type ExtensionAPI,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

/** Context slice passed to event handlers (structural, live property reads). */
interface HeaderCtx {
  mode: string;
  cwd: string;
  model?: { provider: string; id: string; name: string } | undefined;
  thinkingLevel?: string;
  sessionManager: {
    getSessionFile(): string | undefined;
    getSessionName(): string | undefined;
  };
  getSystemPrompt(): string;
  isProjectTrusted?: () => boolean;
  ui: {
    theme: Theme;
    setHeader(factory: unknown): void;
  };
}

/** Values captured at install time; render reads only these + theme + width. */
interface Snapshot {
  model: string;
  provider: string;
  cwd: string;
  context: string[];
  skills: string[];
  prompts: string[];
  extensions: string[];
  tools: number;
  session: string;
}

// --- pi mascot (adapted from pi's examples/extensions/custom-header.ts) ---

const BLOCK = "█";
const PUPIL = "▌"; // vertical half-block for the pupil
const LOGO_WIDTH = 16; // widest mascot line, ignoring color escapes
const LOGO_GAP = 3; // spaces between mascot and info column

/** Mascot lines paired with their visible widths (color escapes excluded). */
function mascot(theme: Theme): Array<{ text: string; width: number }> {
  const blue = (t: string) => theme.fg("accent", t);
  const dim = (t: string) => theme.fg("dim", t);

  // [white block][dark pupil] creates the "looking sideways" effect
  const eye = `${BLOCK}${dim(PUPIL)}`;
  const eyes = { text: `     ${eye}  ${eye}`, width: 11 };
  const bar = { text: `  ${blue(BLOCK.repeat(14))}`, width: 16 };
  const leg = {
    text: `     ${blue(BLOCK.repeat(2))}    ${blue(BLOCK.repeat(2))}`,
    width: 13,
  };

  return [
    { text: "", width: 0 },
    eyes,
    bar,
    leg,
    leg,
    leg,
    leg,
    { text: "", width: 0 },
  ];
}

function shortPath(p: string): string {
  const home = homedir();
  if (p === home) return "~";
  return p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

/** Keep single-line values short (fastfetch-style); visible-width aware. */
function trunc(value: string, max = 30): string {
  return truncateToWidth(value, max, "…");
}

function getSessionId(value: string): string {
  return value.split(/[_.]/)[1];
}

/** Wrap a comma-separated list into chunks of at most `maxWidth` columns. */
function wrapList(value: string, maxWidth: number): string[] {
  if (visibleWidth(value) <= maxWidth || maxWidth <= 0) return [value];
  const items = value.split(", ");
  const lines: string[] = [];
  let current = "";
  for (const item of items) {
    const candidate = current ? `${current}, ${item}` : item;
    if (visibleWidth(candidate) > maxWidth && current) {
      lines.push(current);
      current = item;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// --- override patterns (mirrors pi's isEnabledByOverrides) ---

interface Overrides {
  excludes: string[]; // !pattern — glob exclude
  forceIncludes: string[]; // +path — exact force-include
  forceExcludes: string[]; // -path — exact force-exclude
}

const NO_OVERRIDES: Overrides = {
  excludes: [],
  forceIncludes: [],
  forceExcludes: [],
};

function parseOverrides(entries: unknown): Overrides {
  if (!Array.isArray(entries)) return NO_OVERRIDES;
  const mods = entries
    .filter((e): e is string => typeof e === "string")
    .filter((e) => e.startsWith("!") || e.startsWith("+") || e.startsWith("-"));
  return {
    excludes: mods.filter((e) => e.startsWith("!")).map((e) => e.slice(1)),
    forceIncludes: mods.filter((e) => e.startsWith("+")).map((e) => e.slice(1)),
    forceExcludes: mods.filter((e) => e.startsWith("-")).map((e) => e.slice(1)),
  };
}

/** Minimal glob: `**` any, `*` not across `/`, `?` one char. */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

/**
 * Match a path the way pi does: against the baseDir-relative path, the
 * basename, and the full path (plus the parent directory for SKILL.md files).
 * Exact matching compares strings; glob matching uses the patterns above.
 */
function pathMatches(
  absPath: string,
  baseDir: string,
  pattern: string,
  exact: boolean,
): boolean {
  const toPosix = (p: string) => p.replace(/\\/g, "/");
  const rel = toPosix(relative(baseDir, absPath));
  const name = basename(absPath);
  const full = toPosix(absPath);
  const norm = pattern.replace(/^\.\//, "").replace(/\\/g, "/");
  const candidates = [rel, name, full];
  if (name === "SKILL.md")
    candidates.push(toPosix(relative(baseDir, dirname(absPath))));
  if (exact) return candidates.some((c) => c === norm);
  const re = globToRegExp(norm);
  return candidates.some((c) => re.test(c));
}

/** pi's override precedence: ! exclude, then + force-include, then - force-exclude. */
function isEnabledByOverrides(
  absPath: string,
  baseDir: string,
  o: Overrides,
): boolean {
  let enabled = true;
  if (o.excludes.some((p) => pathMatches(absPath, baseDir, p, false)))
    enabled = false;
  if (o.forceIncludes.some((p) => pathMatches(absPath, baseDir, p, true)))
    enabled = true;
  if (o.forceExcludes.some((p) => pathMatches(absPath, baseDir, p, true)))
    enabled = false;
  return enabled;
}

// --- per-root resource collectors ---

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** Read a package's `pi` manifest key, or undefined when absent/invalid. */
function readPiManifest(
  root: string,
): { extensions?: unknown; skills?: unknown; prompts?: unknown } | undefined {
  const pkg = readJson(join(root, "package.json"));
  const pi = pkg?.pi;
  return pi && typeof pi === "object"
    ? (pi as Record<string, unknown>)
    : undefined;
}

/**
 * Resolve one pi.extensions pattern entry to absolute paths. Supports the
 * glob forms pi manifests use ("dir/STAR.ts" and "dir/STAR/index.ts"), plain
 * files, and directories (a directory with an index file is a single
 * extension).
 */
function resolveExtensionPattern(root: string, pattern: string): string[] {
  const isExtensionEntry = (p: string): boolean => {
    try {
      const st = statSync(p); // follows symlinks
      return st.isDirectory()
        ? existsSync(join(p, "index.ts")) || existsSync(join(p, "index.js"))
        : /\.(ts|js)$/.test(p) && !p.endsWith(".d.ts");
    } catch {
      return false;
    }
  };

  let match = pattern.match(/^(.*)\/\*\.(ts|js)$/); // "dir/*.ts"
  if (match) {
    const dir = resolve(root, match[1]);
    const ext = match[2];
    try {
      return readdirSync(dir)
        .filter((n) => n.endsWith(`.${ext}`))
        .map((n) => join(dir, n))
        .filter(isExtensionEntry);
    } catch {
      return [];
    }
  }

  match = pattern.match(/^(.*)\/\*\/index\.(ts|js)$/); // "dir/*/index.ts"
  if (match) {
    const dir = resolve(root, match[1]);
    const ext = match[2];
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => join(dir, e.name, `index.${ext}`))
        .filter((p) => existsSync(p));
    } catch {
      return [];
    }
  }

  const abs = resolve(root, pattern);
  try {
    const st = statSync(abs); // follows symlinks
    if (st.isFile()) return isExtensionEntry(abs) ? [abs] : [];
    if (!st.isDirectory()) return [];
    // Directory with an index file = one extension (pi-web-access "./dist");
    // otherwise a directory of extensions.
    if (existsSync(join(abs, "index.ts")) || existsSync(join(abs, "index.js")))
      return [abs];
    return readdirSync(abs)
      .filter((n) => n !== "node_modules" && !n.startsWith("."))
      .map((n) => join(abs, n))
      .filter(isExtensionEntry);
  } catch {
    return [];
  }
}

/**
 * Extension display names for one root, mirroring pi's labels: npm packages
 * get a "pkg:segment" prefix ("pi-web-access:dist"); other roots show bare
 * names ("context-tokens.ts", "pi-worktree"). Overrides use pi's
 * isEnabledByOverrides against baseDir.
 */
function extensionNamesFor(
  root: string,
  baseDir: string,
  prefix: string | undefined,
  o: Overrides,
): string[] {
  const manifest = readPiManifest(root);
  const patterns: string[] =
    manifest &&
    Array.isArray(manifest.extensions) &&
    manifest.extensions.length > 0
      ? (manifest.extensions as string[])
      : ["./extensions/*.ts", "./extensions/*/index.ts"];

  const names = new Set<string>();
  for (const pattern of patterns) {
    for (const p of resolveExtensionPattern(root, pattern)) {
      if (!isEnabledByOverrides(p, baseDir, o)) continue;
      const rel = p.slice(resolve(root).length + 1).replace(/\\/g, "/");
      const base = basename(rel);
      // directory extension: name is the last real path segment
      const name =
        base === "index.ts" || base === "index.js"
          ? (rel.split("/").slice(-2)[0] ?? base)
          : base;
      names.add(prefix ? `${prefix}:${name}` : name);
    }
  }
  return [...names];
}

/**
 * Collect skill files from seed paths (directories or single .md files).
 * Mirrors pi's collectSkillEntries: a directory containing SKILL.md is a
 * skill (no recursion past it); loose .md files count only at the root level
 * for "pi"-mode seeds (.pi/skills, agent skills, package skills, --skill
 * dirs) and only below the root for "agents"-mode seeds (.agents/skills).
 */
function collectSkillFiles(seeds: string[], mode: "pi" | "agents"): string[] {
  const files: string[] = [];
  const walk = (dir: string, isRoot: boolean): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // A directory containing SKILL.md is itself a skill; stop there.
    if (entries.some((e) => e.name === "SKILL.md")) {
      files.push(join(dir, "SKILL.md"));
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const p = join(dir, entry.name);
      let st;
      try {
        st = statSync(p); // follows symlinks
      } catch {
        continue;
      }
      const isDir = st.isDirectory();
      // Loose .md files: root level only (pi mode) or below root (agents mode).
      const looseMd =
        !isDir &&
        entry.name.endsWith(".md") &&
        (mode === "pi" ? isRoot : !isRoot);
      if (looseMd) files.push(p);
      else if (isDir) walk(p, false);
    }
  };
  for (const seed of seeds) {
    try {
      if (statSync(seed).isDirectory()) walk(seed, true);
      else if (seed.endsWith(".md")) files.push(seed);
    } catch {
      // missing dir — skip
    }
  }
  return files;
}

/**
 * Skill names for one root: manifest skills paths or the conventional
 * ./skills directory, override-filtered like pi. All loaded skills are
 * listed, including disableModelInvocation ones.
 */
function skillNamesFor(
  root: string,
  baseDir: string,
  o: Overrides,
  mode: "pi" | "agents" = "pi",
): string[] {
  const manifest = readPiManifest(root);
  const seeds: string[] =
    manifest && Array.isArray(manifest.skills) && manifest.skills.length > 0
      ? (manifest.skills as string[]).map((s) => resolve(root, s))
      : [join(root, "skills")];
  return collectSkillFiles(seeds, mode)
    .filter((file) => isEnabledByOverrides(file, baseDir, o))
    .map(skillNameFor);
}

/** Skill name: frontmatter `name`, falling back to the parent directory name. */
function skillNameFor(file: string): string {
  try {
    const raw = readFileSync(file, "utf8");
    const frontmatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const name = frontmatter?.[1].match(/^name:[ \t]*(.+)$/m);
    if (name) return name[1].trim();
  } catch {
    // unreadable — fall through
  }
  return basename(dirname(file));
}

/** Prompt template names ("/implement" style) from seed paths (dirs or .md files). */
function promptNamesFromSeeds(
  seeds: string[],
  baseDir: string,
  o: Overrides,
): string[] {
  const names: string[] = [];
  for (const seed of seeds) {
    const abs = resolve(seed);
    try {
      const st = statSync(abs);
      if (st.isDirectory()) {
        for (const entry of readdirSync(abs)) {
          if (!entry.endsWith(".md")) continue;
          const p = join(abs, entry);
          if (isEnabledByOverrides(p, baseDir, o))
            names.push(`/${entry.replace(/\.md$/, "")}`);
        }
      } else if (abs.endsWith(".md") && isEnabledByOverrides(abs, baseDir, o)) {
        names.push(`/${basename(abs, ".md")}`);
      }
    } catch {
      // missing dir / unreadable — skip
    }
  }
  return names;
}

/** Prompt template names for one root: manifest prompts paths or ./prompts. */
function promptNamesFor(root: string, baseDir: string, o: Overrides): string[] {
  const manifest = readPiManifest(root);
  const patterns: string[] =
    manifest && Array.isArray(manifest.prompts) && manifest.prompts.length > 0
      ? (manifest.prompts as string[]).map((p) => resolve(root, p))
      : [join(root, "prompts")];
  return promptNamesFromSeeds(patterns, baseDir, o);
}

/** All ancestor dirs of cwd that contain an .agents/skills directory. */
function ancestorAgentsSkillDirs(cwd: string): string[] {
  const dirs: string[] = [];
  let current = resolve(cwd);
  for (;;) {
    const agentsDir = join(current, ".agents");
    if (existsSync(join(agentsDir, "skills"))) dirs.push(agentsDir);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs;
}

interface ScopedOverrides {
  extensions: Overrides;
  skills: Overrides;
  prompts: Overrides;
}

const NO_OV_SCOPED: ScopedOverrides = {
  extensions: NO_OVERRIDES,
  skills: NO_OVERRIDES,
  prompts: NO_OVERRIDES,
};

// --- CLI resource flags (parsed from pi's own process.argv) ---

interface CliResources {
  extensions: string[];
  skills: string[];
  prompts: string[];
  noExtensions: boolean;
  noSkills: boolean;
  noPrompts: boolean;
}

/**
 * Parse pi's resource CLI flags: -e/--extension, --skill, --prompt-template
 * (repeatable, values resolve from the cwd) and the discovery switches
 * -ne/--no-extensions, -ns/--no-skills, -np/--no-prompt-templates. Explicit
 * paths still load when discovery is off, mirroring pi.
 */
function parseResourceFlags(argv: string[]): CliResources {
  const out: CliResources = {
    extensions: [],
    skills: [],
    prompts: [],
    noExtensions: false,
    noSkills: false,
    noPrompts: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") break;
    let flag = arg;
    let value: string | undefined;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        flag = arg.slice(0, eq);
        value = arg.slice(eq + 1);
      }
    }
    if (flag === "-e" || flag === "--extension") {
      if (value === undefined) value = argv[++i];
      if (value) out.extensions.push(value);
    } else if (flag === "--skill") {
      if (value === undefined) value = argv[++i];
      if (value) out.skills.push(value);
    } else if (flag === "--prompt-template") {
      if (value === undefined) value = argv[++i];
      if (value) out.prompts.push(value);
    } else if (flag === "-ne" || flag === "--no-extensions") {
      out.noExtensions = true;
    } else if (flag === "-ns" || flag === "--no-skills") {
      out.noSkills = true;
    } else if (flag === "-np" || flag === "--no-prompt-templates") {
      out.noPrompts = true;
    }
  }
  return out;
}

/**
 * Resolve one -e/--extension source the way pi does: builtin: names are
 * hidden from the listing; a file is a single extension; a package-shaped
 * directory (pi manifest resource fields or conventional resource dirs)
 * contributes all resource types; a bare directory with an index file is a
 * single extension.
 */
function cliExtensionScan(
  source: string,
  cwd: string,
): { extensions: string[]; skills: string[]; prompts: string[] } {
  const out = {
    extensions: [] as string[],
    skills: [] as string[],
    prompts: [] as string[],
  };
  if (source.startsWith("builtin:")) return out; // hidden like pi hides them
  const abs = resolve(cwd, source);
  let st;
  try {
    st = statSync(abs); // follows symlinks
  } catch {
    return out;
  }
  if (st.isFile()) {
    if (/\.(ts|js)$/.test(abs) && !abs.endsWith(".d.ts"))
      out.extensions.push(basename(abs));
    return out;
  }
  if (!st.isDirectory()) return out;
  const manifest = readPiManifest(abs);
  const pkgShaped =
    (!!manifest &&
      [manifest.extensions, manifest.skills, manifest.prompts].some(
        Array.isArray,
      )) ||
    ["extensions", "skills", "prompts"].some((d) => existsSync(join(abs, d)));
  if (pkgShaped) {
    out.extensions.push(
      ...extensionNamesFor(abs, abs, undefined, NO_OVERRIDES),
    );
    out.skills.push(...skillNamesFor(abs, abs, NO_OVERRIDES));
    out.prompts.push(...promptNamesFor(abs, abs, NO_OVERRIDES));
    return out;
  }
  if (existsSync(join(abs, "index.ts")) || existsSync(join(abs, "index.js"))) {
    out.extensions.push(basename(abs));
  }
  return out;
}

/**
 * Discover skills, prompt templates, and extensions across pi's scopes:
 * CLI/temporary sources first (pi merges them ahead of discovered ones), then
 * project .pi/ (trusted), ancestor .agents/skills dirs, the user agent dir,
 * ~/.agents/skills, and the packages listed in settings.json. The -ne/-ns/-np
 * switches disable the discovered scans while explicit CLI paths still load.
 * Name collisions resolve first-wins in pi's order; display sorts with
 * localeCompare like pi's compact lists.
 */
function discoverResources(
  ctx: HeaderCtx,
  agentDir: string,
  cli: CliResources,
): { skills: string[]; prompts: string[]; extensions: string[] } {
  const trusted = ctx.isProjectTrusted?.() ?? true;
  const globalSettings = readJson(join(agentDir, "settings.json")) ?? {};
  const projectSettings = trusted
    ? (readJson(join(ctx.cwd, ".pi", "settings.json")) ?? {})
    : {};

  const userOv: ScopedOverrides = {
    extensions: parseOverrides(globalSettings.extensions),
    skills: parseOverrides(globalSettings.skills),
    prompts: parseOverrides(globalSettings.prompts),
  };
  const projectOv: ScopedOverrides = {
    extensions: parseOverrides(projectSettings.extensions),
    skills: parseOverrides(projectSettings.skills),
    prompts: parseOverrides(projectSettings.prompts),
  };

  // First-wins name maps in pi's root order.
  const skills = new Map<string, true>();
  const prompts = new Map<string, true>();
  const extensions = new Map<string, true>();
  const add = (map: Map<string, true>, names: string[]) => {
    for (const name of names) if (!map.has(name)) map.set(name, true);
  };

  const scanRoot = (
    root: string,
    baseDir: string,
    ov: ScopedOverrides,
    prefix?: string,
  ) => {
    if (!cli.noExtensions)
      add(extensions, extensionNamesFor(root, baseDir, prefix, ov.extensions));
    if (!cli.noSkills) add(skills, skillNamesFor(root, baseDir, ov.skills));
    if (!cli.noPrompts) add(prompts, promptNamesFor(root, baseDir, ov.prompts));
  };

  // CLI/temporary sources first — pi merges them ahead of discovered ones,
  // and explicit paths still load under the -ne/-ns/-np switches.
  for (const source of cli.extensions) {
    const found = cliExtensionScan(source, ctx.cwd);
    add(extensions, found.extensions);
    add(skills, found.skills);
    add(prompts, found.prompts);
  }
  for (const source of cli.skills) {
    const abs = resolve(ctx.cwd, source);
    add(skills, collectSkillFiles([abs], "pi").map(skillNameFor));
  }
  for (const source of cli.prompts) {
    add(
      prompts,
      promptNamesFromSeeds([resolve(ctx.cwd, source)], ctx.cwd, NO_OVERRIDES),
    );
  }

  // Discovered scopes, gated by the -ne/-ns/-np switches.
  if (trusted) {
    scanRoot(join(ctx.cwd, ".pi"), join(ctx.cwd, ".pi"), projectOv);
  }
  if (!cli.noSkills) {
    for (const agentsDir of ancestorAgentsSkillDirs(ctx.cwd)) {
      add(
        skills,
        skillNamesFor(
          join(agentsDir, "skills"),
          agentsDir,
          projectOv.skills,
          "agents",
        ),
      );
    }
  }

  // User scope: agent dir, then ~/.agents/skills.
  scanRoot(agentDir, agentDir, userOv);
  if (!cli.noSkills && existsSync(join(join(homedir(), ".agents"), "skills"))) {
    const homeAgents = join(homedir(), ".agents");
    add(
      skills,
      skillNamesFor(
        join(homeAgents, "skills"),
        homeAgents,
        userOv.skills,
        "agents",
      ),
    );
  }

  // Packages from settings.json. The baseDir for override patterns is the
  // package root; npm packages get the "pkg:segment" extension label.
  try {
    const packages = Array.isArray(globalSettings.packages)
      ? (globalSettings.packages as unknown[])
      : [];
    for (const entry of packages) {
      if (typeof entry === "string" && entry.startsWith("npm:")) {
        const pkgName = entry.slice("npm:".length);
        const root = join(agentDir, "npm", "node_modules", pkgName);
        scanRoot(root, root, NO_OV_SCOPED, pkgName);
      } else if (
        entry &&
        typeof entry === "object" &&
        typeof (entry as Record<string, unknown>).source === "string"
      ) {
        const root = resolve(
          agentDir,
          (entry as Record<string, unknown>).source as string,
        );
        scanRoot(root, root, {
          extensions: parseOverrides(
            (entry as Record<string, unknown>).extensions,
          ),
          skills: parseOverrides((entry as Record<string, unknown>).skills),
          prompts: parseOverrides((entry as Record<string, unknown>).prompts),
        });
      }
    }
  } catch {
    // unreadable packages config — earlier scopes still shown
  }

  const sorted = (map: Map<string, true>) =>
    [...map.keys()].sort((a, b) => a.localeCompare(b));
  return {
    skills: sorted(skills),
    prompts: sorted(prompts),
    extensions: sorted(extensions),
  };
}

// --- context files (mirrors pi's [Context] section) ---

/**
 * Format a context path the way pi's startup listing does: relative to the
 * cwd when the file lives under it, else ~-shortened.
 */
function formatContextPath(p: string, cwd: string): string {
  const abs = resolve(p);
  const rel = relative(resolve(cwd), abs);
  if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
  return shortPath(abs);
}

/**
 * Discover SYSTEM.md / APPEND_SYSTEM.md the way pi's resource loader does:
 * the project .pi/ file when the project is trusted, else the agent-dir one.
 * These replace/append to the system prompt, so they never appear in the
 * <project_instructions> blocks and must be found by convention.
 */
function discoverPromptOverride(
  name: "SYSTEM.md" | "APPEND_SYSTEM.md",
  ctx: HeaderCtx,
  agentDir: string,
): string | undefined {
  const projectPath = join(ctx.cwd, ".pi", name);
  if (ctx.isProjectTrusted?.() && existsSync(projectPath)) return projectPath;
  const globalPath = join(agentDir, name);
  if (existsSync(globalPath)) return globalPath;
  return undefined;
}

/**
 * Context files in pi's [Context] order: SYSTEM.md, APPEND_SYSTEM.md, then
 * the <project_instructions> blocks (pi renders agentsFiles there in load
 * order: global file first, then ancestors from repo root down to cwd).
 */
function contextPaths(
  ctx: HeaderCtx,
  agentDir: string,
  systemPrompt: string,
): string[] {
  const out: string[] = [];
  for (const name of ["SYSTEM.md", "APPEND_SYSTEM.md"] as const) {
    const found = discoverPromptOverride(name, ctx, agentDir);
    if (found) out.push(formatContextPath(found, ctx.cwd));
  }
  const seen = new Set(out);
  for (const match of systemPrompt.matchAll(
    /<project_instructions path="([^"]+)">/g,
  )) {
    const formatted = formatContextPath(match[1], ctx.cwd);
    if (!seen.has(formatted)) {
      seen.add(formatted);
      out.push(formatted);
    }
  }
  return out;
}

function buildSnapshot(
  pi: ExtensionAPI,
  ctx: HeaderCtx,
  agentDir: string,
): Snapshot {
  const systemPrompt = ctx.getSystemPrompt();
  const resources = discoverResources(
    ctx,
    agentDir,
    parseResourceFlags(process.argv),
  );
  const sessionFile = ctx.sessionManager.getSessionFile();
  const sessionName = ctx.sessionManager.getSessionName();

  return {
    model: ctx.model ? ctx.model.name : "none",
    provider: ctx.model ? ctx.model.provider : "none",
    // model: ctx.model
    //   ? `${ctx.model.provider}/${ctx.model.id}${ctx.thinkingLevel ? ` (${ctx.thinkingLevel})` : ""}`
    //   : "none",
    cwd: shortPath(ctx.cwd),
    context: contextPaths(ctx, agentDir, systemPrompt),
    skills: resources.skills,
    prompts: resources.prompts,
    extensions: resources.extensions,
    tools: pi.getAllTools().length,
    session: sessionName
      ? sessionName
      : sessionFile
        ? getSessionId(basename(sessionFile))
        : "ephemeral",
  };
}

// --- rendering ---

function renderLines(snap: Snapshot, theme: Theme, width: number): string[] {
  // Key column width: widest label across every row.
  const keyWidth = Math.max(
    ...[
      "pi",
      "model",
      "cwd",
      "theme",
      "context",
      "skills",
      "prompts",
      "extensions",
      "tools",
      "session",
    ].map((key) => key.length),
  );

  const logo =
    width >= LOGO_WIDTH + LOGO_GAP + keyWidth + 2 + 30 ? mascot(theme) : null;
  const columnStart = logo ? LOGO_WIDTH + LOGO_GAP : 0;
  const valueWidth = Math.max(0, width - columnStart - keyWidth - 2);
  // Wrap list rows to the real remaining width (floor 20 for readability);
  // the final clamp below guarantees nothing exceeds the terminal.
  const wrapAt = Math.max(20, valueWidth);

  // Single-line rows; cwd gets whatever width is actually available.
  const single: Array<[string, string]> = [
    ["pi", `v${VERSION}`],
    ["model", snap.model],
    ["provider", snap.provider],
    ["cwd", trunc(snap.cwd, Math.max(30, valueWidth))],
    ["theme", theme.name ?? "default"],
  ];

  // Each row becomes one or more styled lines; list rows wrap with an indent.
  const oneLine = (key: string, value: string): string =>
    `${theme.fg("accent", key.padEnd(keyWidth))}${theme.fg("dim", ": ")}${theme.fg("text", value)}`;
  const listBlock = (key: string, list: string[]): string[] => {
    const chunks =
      list.length > 0 ? wrapList(list.join(", "), wrapAt) : ["none"];
    const styled = chunks.map((chunk) => theme.fg("text", chunk));
    const indent = " ".repeat(keyWidth + 2);
    return [
      `${theme.fg("accent", key.padEnd(keyWidth))}${theme.fg("dim", ": ")}${styled[0]}`,
      ...styled.slice(1).map((line) => indent + line),
    ];
  };
  // Resource rows mirror pi's startup section order: Context, Skills,
  // Prompts, Extensions.
  const info = [
    ...single.map(([key, value]) => oneLine(key, value)),
    ...listBlock("context", snap.context),
    oneLine("skills", `${snap.skills.length}`),
    oneLine("prompts", `${snap.prompts.length}`),
    oneLine("extensions", `${snap.extensions.length}`),
    oneLine("tools", `${snap.tools}`),
    oneLine("session", snap.session),
    theme.fg("muted", "? hints · / commands · ctrl+p model"),
  ];

  // Overlay: pad every info line to the mascot column (also beyond its height).
  const height = Math.max(logo?.length ?? 0, info.length + 1);
  const lines: string[] = [];
  for (let i = 0; i < height; i++) {
    let line = "";
    if (logo) {
      const l = logo[i] ?? { text: "", width: 0 };
      line += l.text + " ".repeat(LOGO_WIDTH - l.width + LOGO_GAP);
    }
    const row = info[i - (logo ? 1 : 0)];
    if (row !== undefined) line += row;
    lines.push(line);
  }
  // Safety clamp: pi-tui crashes if any rendered line exceeds the terminal
  // width, so truncate every line (ANSI- and visible-width aware).
  return lines.map((line) => truncateToWidth(line, Math.max(0, width)));
}

export default function (pi: ExtensionAPI) {
  const install = (ctx: HeaderCtx) => {
    if (ctx.mode !== "tui") return;
    const agentDir =
      process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
    const theme = ctx.ui.theme;
    // Snapshot resources once per install; cheap property reads stay live.
    const snap = buildSnapshot(pi, ctx, agentDir);
    ctx.ui.setHeader(() => ({
      render(width: number) {
        return renderLines(snap, theme, width);
      },
      invalidate() {},
    }));
  };

  pi.on("session_start", async (_event, ctx) => install(ctx));
  // Re-install so the header re-renders after /model or ctrl+p switches.
  pi.on("model_select", async (_event, ctx) => install(ctx));

  pi.registerCommand("builtin-header", {
    description: "Restore pi's built-in startup header",
    handler: async (_args, ctx) => {
      ctx.ui.setHeader(undefined);
      ctx.ui.notify("Built-in header restored", "info");
    },
  });
}
