import { execSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getGitHubCloneConfig } from "./config.js";
import { isAbortError, errorMessage } from "./utils.js";
import type { ExtractedContent } from "./storage.js";

// ─── URL detection ──────────────────────────────────────────────────────────

const GITHUB_PATTERNS = [
  /^https?:\/\/github\.com\/[^/]+\/[^/]+\/blob\//,
  /^https?:\/\/github\.com\/[^/]+\/[^/]+\/tree\//,
  /^https?:\/\/github\.com\/[^/]+\/[^/]+\/?(\?|$)/,
  /^https?:\/\/github\.com\/[^/]+\/[^/]+\/commit\//,
];

export function isGitHubURL(url: string): boolean {
  return GITHUB_PATTERNS.some((p) => p.test(url));
}

interface ParsedGitHubURL {
  owner: string;
  repo: string;
  type: "root" | "tree" | "blob" | "commit";
  ref: string;
  path: string;
}

function parseGitHubURL(url: string): ParsedGitHubURL | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "github.com") return null;
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;

    const owner = parts[0];
    const repo = parts[1];

    if (parts.length === 2 || (parts.length === 3 && parts[2] === "tree")) {
      return { owner, repo, type: "root", ref: "", path: "" };
    }

    if (parts[2] === "tree" && parts.length >= 4) {
      const ref = parts[3];
      const path = parts.slice(4).join("/");
      return { owner, repo, type: "tree", ref, path };
    }

    if (parts[2] === "blob" && parts.length >= 5) {
      const ref = parts[3];
      const path = parts.slice(4).join("/");
      return { owner, repo, type: "blob", ref, path };
    }

    if (parts[2] === "commit" && parts.length >= 4) {
      return { owner, repo, type: "commit", ref: parts[3], path: "" };
    }

    // Default: root
    return { owner, repo, type: "root", ref: "", path: "" };
  } catch {
    return null;
  }
}

// ─── Clone cache ────────────────────────────────────────────────────────────

let cloneCache = new Map<string, string>(); // repoKey → localPath

export function clearCloneCache(): void {
  cloneCache.clear();
}

function repoKey(owner: string, repo: string): string {
  return `${owner}/${repo}`;
}

// ─── Repo size check (GitHub API) ───────────────────────────────────────────

async function getRepoSize(
  owner: string,
  repo: string,
  signal?: AbortSignal,
): Promise<number | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: { "User-Agent": "PiAgent/1.0" },
      signal: AbortSignal.any([
        AbortSignal.timeout(10000),
        ...(signal ? [signal] : []),
      ]),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { size?: number };
    return typeof data.size === "number" ? data.size : null; // size in KB
  } catch {
    return null;
  }
}

// ─── Clone repo ─────────────────────────────────────────────────────────────

async function cloneRepo(
  owner: string,
  repo: string,
  signal?: AbortSignal,
): Promise<string> {
  const config = getGitHubCloneConfig();
  const key = repoKey(owner, repo);

  if (cloneCache.has(key)) return cloneCache.get(key)!;

  const clonePath = join(
    config.clonePath || "/tmp/pi-github-repos",
    `${owner}-${repo}`,
  );
  if (existsSync(clonePath)) {
    cloneCache.set(key, clonePath);
    return clonePath;
  }

  mkdirSync(clonePath, { recursive: true });
  const parentDir = join(clonePath, "..");

  const sizeKB = await getRepoSize(owner, repo, signal);
  const maxSizeMB = config.maxRepoSizeMB != null ? config.maxRepoSizeMB : 350;
  if (sizeKB !== null && sizeKB > maxSizeMB * 1024) {
    throw new Error(
      `Repo ${key} is ${Math.round(sizeKB / 1024)}MB, exceeding ${maxSizeMB}MB limit. ` +
        `Use forceClone: true to override.`,
    );
  }

  const url = `https://github.com/${owner}/${repo}.git`;
  const timeout =
    (config.cloneTimeoutSeconds != null ? config.cloneTimeoutSeconds : 30) *
    1000;

  try {
    execSync(`git clone --depth 1 ${url} ${owner}-${repo}`, {
      cwd: parentDir,
      timeout,
      stdio: "pipe",
    });
  } catch (err) {
    throw new Error(`git clone failed for ${key}: ${errorMessage(err)}`);
  }

  cloneCache.set(key, clonePath);
  return clonePath;
}

// ─── File tree listing ──────────────────────────────────────────────────────

function listDirectory(
  dirPath: string,
  prefix: string = "",
  depth: number = 0,
  maxDepth: number = 3,
): string {
  if (depth > maxDepth) return `${prefix}...\n`;
  const entries = readdirSync(dirPath, { withFileTypes: true })
    .filter((d) => !d.name.startsWith(".") && d.name !== "node_modules")
    .sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

  let output = "";
  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      output += `${prefix}${entry.name}/\n`;
      output += listDirectory(fullPath, `${prefix}  `, depth + 1, maxDepth);
    } else {
      const size = statSync(fullPath).size;
      const sizeStr = size > 1024 ? `${Math.round(size / 1024)}KB` : `${size}B`;
      output += `${prefix}${entry.name} (${sizeStr})\n`;
    }
  }
  return output;
}

// ─── GitHub API fallback (for commit SHAs, large repos) ────────────────────

async function fetchFromGitHubAPI(
  owner: string,
  repo: string,
  path: string,
  ref: string,
  signal?: AbortSignal,
): Promise<string> {
  const refPart = ref ? `?ref=${ref}` : "";
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}${refPart}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "PiAgent/1.0",
      Accept: "application/vnd.github.v3+json",
    },
    signal: AbortSignal.any([
      AbortSignal.timeout(15000),
      ...(signal ? [signal] : []),
    ]),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`GitHub API ${res.status}: ${errText.slice(0, 300)}`);
  }

  const data = (await res.json()) as
    | Array<{ name: string; type: string; path: string; download_url?: string }>
    | { name: string; content?: string; type: string; download_url?: string };

  if (Array.isArray(data)) {
    return (
      `## Directory: ${path || "/"}\n\n` +
      data
        .map((item) => `${item.type === "dir" ? "📁" : "📄"} ${item.name}`)
        .join("\n")
    );
  }

  if (data.content) {
    const decoded = Buffer.from(data.content, "base64").toString("utf-8");
    return `## File: ${data.name}\n\n${decoded}`;
  }

  if (data.download_url) {
    const fileRes = await fetch(data.download_url, { signal });
    if (!fileRes.ok) throw new Error(`Failed to download ${data.download_url}`);
    return await fileRes.text();
  }

  return "No content available.";
}

// ─── Commit SHA via API ─────────────────────────────────────────────────────

async function fetchCommitFromAPI(
  owner: string,
  repo: string,
  sha: string,
  signal?: AbortSignal,
): Promise<string> {
  const url = `https://api.github.com/repos/${owner}/${repo}/commits/${sha}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "PiAgent/1.0" },
    signal: AbortSignal.any([
      AbortSignal.timeout(15000),
      ...(signal ? [signal] : []),
    ]),
  });

  if (!res.ok) throw new Error(`GitHub API ${res.status} for commit ${sha}`);

  const data = (await res.json()) as {
    sha: string;
    commit: { message: string; author: { name: string; date: string } };
    files?: Array<{
      filename: string;
      status: string;
      additions: number;
      deletions: number;
      patch?: string;
    }>;
  };

  let output = `## Commit ${data.sha.slice(0, 7)}\n\n`;
  output += `**${data.commit.message}**\n`;
  output += `Author: ${data.commit.author.name} | Date: ${data.commit.author.date}\n\n`;

  if (data.files != null && data.files.length > 0) {
    output += "### Changed files\n\n";
    for (const f of data.files.slice(0, 20)) {
      output += `- \`${f.filename}\` (+${f.additions}/-${f.deletions}) ${f.status}\n`;
      if (f.patch)
        output += `\n\`\`\`diff\n${f.patch.slice(0, 1000)}\n\`\`\`\n`;
    }
  }

  return output;
}

// ─── Public: extractGitHub ───────────────────────────────────────────────────

export async function extractGitHub(
  url: string,
  signal?: AbortSignal,
  forceClone?: boolean,
): Promise<ExtractedContent> {
  const parsed = parseGitHubURL(url);
  if (!parsed)
    return { url, title: "", content: "", error: "Could not parse GitHub URL" };

  const { owner, repo, type, ref, path } = parsed;
  const fullName = `${owner}/${repo}`;

  // Commit SHA → API only
  if (type === "commit") {
    try {
      const content = await fetchCommitFromAPI(owner, repo, ref, signal);
      return {
        url,
        title: `Commit ${ref.slice(0, 7)} - ${fullName}`,
        content,
        error: null,
      };
    } catch (err) {
      return {
        url,
        title: "",
        content: "",
        error: `GitHub commit API failed: ${errorMessage(err)}`,
      };
    }
  }

  const config = getGitHubCloneConfig();
  const maxSizeMB = config.maxRepoSizeMB != null ? config.maxRepoSizeMB : 350;
  const sizeKB = await getRepoSize(owner, repo, signal);
  const tooLarge = !forceClone && sizeKB !== null && sizeKB > maxSizeMB * 1024;

  // Large repo → API fallback
  if (tooLarge) {
    try {
      let content: string;
      if (type === "blob" && path) {
        content = await fetchFromGitHubAPI(owner, repo, path, ref, signal);
      } else {
        content = await fetchFromGitHubAPI(
          owner,
          repo,
          path || "",
          ref || "",
          signal,
        );
      }
      return {
        url,
        title: `${fullName} (API view — repo too large to clone)`,
        content,
        error: null,
      };
    } catch (err) {
      return {
        url,
        title: "",
        content: "",
        error: `GitHub API fallback failed: ${errorMessage(err)}`,
      };
    }
  }

  // Clone the repo
  let localPath: string;
  try {
    localPath = await cloneRepo(owner, repo, signal);
  } catch (err) {
    if (isAbortError(err))
      return { url, title: "", content: "", error: "Aborted" };
    // Clone failed → try API fallback
    try {
      const content = await fetchFromGitHubAPI(
        owner,
        repo,
        path || "",
        ref || "",
        signal,
      );
      return { url, title: `${fullName} (API fallback)`, content, error: null };
    } catch (apiErr) {
      return {
        url,
        title: "",
        content: "",
        error: `Clone and API both failed: ${errorMessage(err)}`,
      };
    }
  }

  // Build content from local clone
  if (type === "root") {
    const readmePath = findReadme(localPath);
    let content = `## ${fullName}\n\nCloned to: \`${localPath}\`\n\n### File tree\n\n${listDirectory(localPath)}`;
    if (readmePath) {
      content += `\n\n### README\n\n${readFileSync(readmePath, "utf-8").slice(0, 10000)}`;
    }
    return { url, title: fullName, content, error: null };
  }

  if (type === "tree" && path) {
    const dirPath = resolve(localPath, path);
    if (!existsSync(dirPath)) {
      return {
        url,
        title: fullName,
        content: `Directory not found: ${path}\n\nLocal clone: \`${localPath}\``,
        error: null,
      };
    }
    return {
      url,
      title: `${fullName}/${path}`,
      content: `## Directory: ${path}\n\nCloned to: \`${localPath}\`\n\n${listDirectory(dirPath)}`,
      error: null,
    };
  }

  if (type === "blob" && path) {
    const filePath = resolve(localPath, path);
    if (!existsSync(filePath)) {
      return {
        url,
        title: fullName,
        content: `File not found: ${path}\n\nLocal clone: \`${localPath}\``,
        error: null,
      };
    }
    const stat = statSync(filePath);
    if (stat.size > 100_000) {
      return {
        url,
        title: `${fullName}/${path}`,
        content: `File: ${path} (${Math.round(stat.size / 1024)}KB)\n\nCloned to: \`${localPath}\`\n\nFile is large. Use \`read\` tool on \`${filePath}\` to view contents.`,
        error: null,
      };
    }
    return {
      url,
      title: `${fullName}/${path}`,
      content: `## File: ${path}\n\nCloned to: \`${localPath}\`\n\n${readFileSync(filePath, "utf-8")}`,
      error: null,
    };
  }

  // Fallback
  return {
    url,
    title: fullName,
    content: `Cloned to: \`${localPath}\``,
    error: null,
  };
}

function findReadme(dirPath: string): string | null {
  const names = [
    "README.md",
    "README.MD",
    "Readme.md",
    "README.rst",
    "README.txt",
    "README",
  ];
  for (const name of names) {
    const p = join(dirPath, name);
    if (existsSync(p)) return p;
  }
  return null;
}
