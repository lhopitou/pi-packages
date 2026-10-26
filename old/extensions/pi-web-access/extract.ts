import TurndownService from "turndown";
import pLimit from "p-limit";
import { extractGitHub, isGitHubURL } from "./github.js";
import { extractPDFToMarkdown, isPDF } from "./pdf.js";
import { isAbortError, errorMessage } from "./utils.js";
import type { ExtractedContent } from "./storage.js";

const DEFAULT_TIMEOUT_MS = 30000;
const CONCURRENT_LIMIT = 3;
const MAX_INLINE_CONTENT = 30000;

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
});

const fetchLimit = pLimit(CONCURRENT_LIMIT);

const JINA_READER_BASE = "https://r.jina.ai/";
const JINA_TIMEOUT_MS = 30000;

function extractHeadingTitle(markdown: string): string | null {
  const match = markdown.match(/^#\s+(.+)/m);
  return match ? match[1].trim() : null;
}

function stripHtmlTags(html: string): string {
  // Remove script and style blocks
  let text = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<nav[\s\S]*?<\/nav>/gi, "");
  text = text.replace(/<footer[\s\S]*?<\/footer>/gi, "");
  text = text.replace(/<header[\s\S]*?<\/header>/gi, "");
  // Remove HTML tags
  text = text.replace(/<[^>]+>/g, " ");
  // Collapse whitespace
  text = text.replace(/\s+/g, " ").trim();
  return text;
}

function extractTitleFromHtml(html: string): string {
  const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return match ? match[1].trim() : "";
}

async function extractWithJinaReader(url: string, signal?: AbortSignal): Promise<ExtractedContent | null> {
  const jinaUrl = JINA_READER_BASE + url;
  try {
    const res = await fetch(jinaUrl, {
      headers: { Accept: "text/markdown", "X-No-Cache": "true" },
      signal: AbortSignal.any([AbortSignal.timeout(JINA_TIMEOUT_MS), ...(signal ? [signal] : [])]),
    });
    if (!res.ok) return null;

    const content = await res.text();
    const contentStart = content.indexOf("Markdown Content:");
    if (contentStart < 0) return null;

    const markdownPart = content.slice(contentStart + 17).trim();
    if (
      markdownPart.length < 100 ||
      markdownPart.startsWith("Loading...") ||
      markdownPart.startsWith("Please enable JavaScript")
    ) {
      return null;
    }

    const title = extractHeadingTitle(markdownPart) || new URL(url).pathname.split("/").pop() || url;
    return { url, title, content: markdownPart, error: null };
  } catch (err) {
    if (isAbortError(err)) throw err;
    return null;
  }
}

function extractWithFallback(html: string, url: string): ExtractedContent | null {
  // Try turndown first — it handles HTML → markdown reasonably for simple pages
  try {
    const markdown = turndown.turndown(html);
    if (markdown && markdown.trim().length >= 200) {
      const title = extractTitleFromHtml(html) || new URL(url).pathname.split("/").pop() || url;
      return { url, title, content: markdown, error: null };
    }
  } catch {
    // turndown failed, fall through
  }

  // Last resort: strip tags
  const text = stripHtmlTags(html);
  if (text.length < 100) return null;

  const title = extractTitleFromHtml(html) || new URL(url).pathname.split("/").pop() || url;
  return { url, title, content: text, error: null };
}

async function fetchSingleUrl(url: string, signal?: AbortSignal, forceClone?: boolean): Promise<ExtractedContent> {
  // GitHub
  if (isGitHubURL(url)) {
    try {
      return await extractGitHub(url, signal, forceClone);
    } catch (err) {
      return { url, title: "", content: "", error: "GitHub extraction failed: " + errorMessage(err) };
    }
  }

  // HTTP fetch
  try {
    const res = await fetch(url, {
      signal: AbortSignal.any([AbortSignal.timeout(DEFAULT_TIMEOUT_MS), ...(signal ? [signal] : [])]),
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; PiAgent/1.0)",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });

    if (!res.ok) {
      return { url, title: "", content: "", error: "HTTP " + res.status + ": " + res.statusText };
    }

    const contentType = res.headers.get("content-type") || "";

    // PDF
    if (isPDF(contentType, url)) {
      try {
        const buffer = await res.arrayBuffer();
        return await extractPDFToMarkdown(url, Buffer.from(buffer));
      } catch (err) {
        return { url, title: "", content: "", error: "PDF extraction failed: " + errorMessage(err) };
      }
    }

    // Plain text / JSON / Markdown
    if (
      contentType.includes("text/plain") ||
      contentType.includes("application/json") ||
      contentType.includes("text/markdown")
    ) {
      const text = await res.text();
      const title = new URL(url).pathname.split("/").pop() || url;
      return { url, title, content: text, error: null };
    }

    // HTML
    if (contentType.includes("text/html") || contentType.includes("application/xhtml")) {
      const html = await res.text();

      // Primary: Jina Reader (handles JS rendering, SPAs, anti-bot)
      const jinaResult = await extractWithJinaReader(url, signal);
      if (jinaResult) return jinaResult;

      // Fallback: turndown or tag stripping on raw HTML
      const fallbackResult = extractWithFallback(html, url);
      if (fallbackResult) return fallbackResult;

      return { url, title: "", content: "", error: "Could not extract readable content from page" };
    }

    // Unknown content type
    return { url, title: "", content: "", error: "Unsupported content type: " + contentType };
  } catch (err) {
    if (isAbortError(err)) return { url, title: "", content: "", error: "Aborted" };
    return { url, title: "", content: "", error: "Fetch failed: " + errorMessage(err) };
  }
}

export interface FetchOptions {
  forceClone?: boolean;
  signal?: AbortSignal;
}

export async function fetchAllContent(
  urls: string[],
  options: FetchOptions = {},
): Promise<ExtractedContent[]> {
  return Promise.all(
    urls.map(function (url) {
      return fetchLimit(function () {
        return fetchSingleUrl(url, options.signal, options.forceClone);
      });
    }),
  );
}

export function truncateForInline(content: string): string {
  if (content.length <= MAX_INLINE_CONTENT) return content;
  return content.slice(0, MAX_INLINE_CONTENT).trimEnd() + "\n\n[Content truncated. Use get_search_content to retrieve full content.]";
}
