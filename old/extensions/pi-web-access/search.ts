import { getExaApiKey } from "./config.js";
import { isAbortError, errorMessage } from "./utils.js";
import type {
  SearchResponse,
  SearchResult,
  ExtractedContent,
} from "./storage.js";

const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const EXA_ANSWER_URL = "https://api.exa.ai/answer";
const EXA_SEARCH_URL = "https://api.exa.ai/search";

export interface SearchOptions {
  numResults?: number;
  recencyFilter?: "day" | "week" | "month" | "year";
  domainFilter?: string[];
  includeContent?: boolean;
  signal?: AbortSignal;
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(60000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

// ─── MCP (no API key) ───────────────────────────────────────────────────────

interface McpRpcResponse {
  result?: {
    content?: Array<{ type?: string; text?: string }>;
    isError?: boolean;
  };
  error?: {
    code?: number;
    message?: string;
  };
}

export async function callExaMcp(
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch(EXA_MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }),
    signal: requestSignal(signal),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      "Exa MCP error " + response.status + ": " + errorText.slice(0, 300),
    );
  }

  const body = await response.text();
  const dataLines = body.split("\n").filter(function (line) {
    return line.startsWith("data:");
  });

  let parsed: McpRpcResponse | null = null;
  for (const line of dataLines) {
    const payload = line.slice(5).trim();
    if (!payload) continue;
    try {
      const candidate = JSON.parse(payload) as McpRpcResponse;
      if (candidate.result != null || candidate.error != null) {
        parsed = candidate;
        break;
      }
    } catch {
      /* try next line */
    }
  }

  if (!parsed) {
    try {
      const candidate = JSON.parse(body) as McpRpcResponse;
      if (candidate.result != null || candidate.error != null) {
        parsed = candidate;
      }
    } catch {
      /* ignore */
    }
  }

  if (!parsed) throw new Error("Exa MCP returned an empty response");

  if (parsed.error) {
    const code =
      typeof parsed.error.code === "number" ? " " + parsed.error.code : "";
    throw new Error(
      "Exa MCP error" + code + ": " + (parsed.error.message || "Unknown error"),
    );
  }

  const result = parsed.result;
  if (result != null && result.isError === true) {
    const items = result.content;
    let msg = "";
    if (items != null) {
      for (const item of items) {
        if (item.type === "text" && typeof item.text === "string") {
          msg = item.text.trim();
          break;
        }
      }
    }
    throw new Error(msg || "Exa MCP returned an error");
  }

  let text = "";
  if (result != null && result.content != null) {
    for (const item of result.content) {
      if (
        item.type === "text" &&
        typeof item.text === "string" &&
        item.text.trim().length > 0
      ) {
        text = item.text;
        break;
      }
    }
  }

  if (!text) throw new Error("Exa MCP returned empty content");
  return text;
}

// ─── MCP result parsing ─────────────────────────────────────────────────────

interface McpParsedResult {
  title: string;
  url: string;
  content: string;
}

function parseMcpResults(text: string): McpParsedResult[] | null {
  const blocks = text.split(/(?=^Title: )/m).filter(function (b) {
    return b.trim().length > 0;
  });
  const parsed = blocks
    .map(function (block) {
      const titleMatch = block.match(/^Title: (.+)/m);
      const title =
        titleMatch != null && titleMatch[1] != null ? titleMatch[1].trim() : "";
      const urlMatch = block.match(/^URL: (.+)/m);
      const url =
        urlMatch != null && urlMatch[1] != null ? urlMatch[1].trim() : "";
      let content = "";
      const textStart = block.indexOf("\nText: ");
      if (textStart >= 0) {
        content = block.slice(textStart + 7).trim();
      } else {
        const hlMatch = block.match(/\nHighlights:\s*\n/);
        if (hlMatch != null && hlMatch.index != null) {
          content = block.slice(hlMatch.index + hlMatch[0].length).trim();
        }
      }
      content = content.replace(/\n---\s*$/, "").trim();
      return { title: title, url: url, content: content };
    })
    .filter(function (r) {
      return r.url.length > 0;
    });
  return parsed.length > 0 ? parsed : null;
}

function buildAnswerFromMcp(results: McpParsedResult[]): string {
  const parts: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const snippet = r.content.replace(/\s+/g, " ").trim().slice(0, 500);
    if (!snippet) continue;
    parts.push(
      snippet +
        "\nSource: " +
        (r.title || "Source " + (i + 1)) +
        " (" +
        r.url +
        ")",
    );
  }
  return parts.join("\n\n");
}

function mapMcpInlineContent(results: McpParsedResult[]): ExtractedContent[] {
  return results
    .filter(function (r) {
      return r.content.length > 0;
    })
    .map(function (r) {
      return { url: r.url, title: r.title, content: r.content, error: null };
    });
}

function buildMcpQuery(query: string, options: SearchOptions): string {
  const parts = [query];
  if (options.domainFilter != null && options.domainFilter.length > 0) {
    for (const d of options.domainFilter) {
      parts.push(d.startsWith("-") ? "-site:" + d.slice(1) : "site:" + d);
    }
  }
  if (options.recencyFilter != null) {
    const now = new Date();
    switch (options.recencyFilter) {
      case "day":
        parts.push("past 24 hours");
        break;
      case "week":
        parts.push("past week");
        break;
      case "month":
        parts.push(
          now.toLocaleString("en", { month: "long" }) + " " + now.getFullYear(),
        );
        break;
      case "year":
        parts.push(String(now.getFullYear()));
        break;
    }
  }
  return parts.join(" ");
}

async function searchWithExaMcp(
  query: string,
  options: SearchOptions = {},
): Promise<SearchResponse | null> {
  const enrichedQuery = buildMcpQuery(query, options);
  const text = await callExaMcp(
    "web_search_exa",
    {
      query: enrichedQuery,
      numResults: options.numResults != null ? options.numResults : 5,
      livecrawl: "fallback",
      type: "auto",
      contextMaxCharacters: options.includeContent ? 50000 : 3000,
    },
    options.signal,
  );

  const parsedResults = parseMcpResults(text);
  if (!parsedResults) return null;

  const response: SearchResponse = {
    answer: buildAnswerFromMcp(parsedResults),
    results: parsedResults.map(function (r, i) {
      return {
        title: r.title || "Source " + (i + 1),
        url: r.url,
        snippet: "",
      };
    }),
  };

  if (options.includeContent) {
    const inlineContent = mapMcpInlineContent(parsedResults);
    if (inlineContent.length > 0) response.inlineContent = inlineContent;
  }

  return response;
}

// ─── Direct API (with key) ──────────────────────────────────────────────────

interface ExaAnswerResponse {
  answer?: string;
  citations?: Array<{
    url?: string;
    title?: string;
    text?: string;
    publishedDate?: string;
  }>;
}

interface ExaSearchResponse {
  results?: Array<{
    title?: string;
    url?: string;
    publishedDate?: string;
    author?: string;
    text?: string;
    highlights?: unknown;
  }>;
}

function recencyToStartDate(filter: string): string {
  const now = new Date();
  const offsets: Record<string, number> = {
    day: 1,
    week: 7,
    month: 30,
    year: 365,
  };
  const days = offsets[filter] != null ? offsets[filter] : 0;
  return new Date(now.getTime() - days * 86400000).toISOString();
}

function mapDomainFilter(domainFilter: string[] | undefined): {
  includeDomains?: string[];
  excludeDomains?: string[];
} {
  if (domainFilter == null || domainFilter.length === 0) return {};
  const includeDomains = domainFilter
    .filter(function (d) {
      return !d.startsWith("-") && d.trim().length > 0;
    })
    .map(function (d) {
      return d.trim();
    });
  const excludeDomains = domainFilter
    .filter(function (d) {
      return d.startsWith("-");
    })
    .map(function (d) {
      return d.slice(1).trim();
    })
    .filter(Boolean);
  const result: { includeDomains?: string[]; excludeDomains?: string[] } = {};
  if (includeDomains.length > 0) result.includeDomains = includeDomains;
  if (excludeDomains.length > 0) result.excludeDomains = excludeDomains;
  return result;
}

function normalizeHighlights(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(function (item): item is string {
    return typeof item === "string" && item.trim().length > 0;
  });
}

function buildAnswerFromApiResults(
  results: ExaSearchResponse["results"],
): string {
  if (results == null || results.length === 0) return "";
  const parts: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const item = results[i];
    if (item == null || item.url == null) continue;
    const highlights = normalizeHighlights(item.highlights);
    const content =
      highlights.length > 0
        ? highlights.join(" ")
        : typeof item.text === "string"
          ? item.text.trim().slice(0, 1000)
          : "";
    if (!content) continue;
    parts.push(
      content +
        "\nSource: " +
        (item.title || "Source " + (i + 1)) +
        " (" +
        item.url +
        ")",
    );
  }
  return parts.join("\n\n");
}

function mapApiResults(
  results: Array<{ url?: string; title?: string }> | undefined,
): SearchResult[] {
  if (!Array.isArray(results)) return [];
  const mapped: SearchResult[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r == null || r.url == null) continue;
    mapped.push({
      title: r.title || "Source " + (i + 1),
      url: r.url,
      snippet: "",
    });
  }
  return mapped;
}

function mapApiInlineContent(
  results: ExaSearchResponse["results"],
): ExtractedContent[] {
  if (results == null || results.length === 0) return [];
  const out: ExtractedContent[] = [];
  for (const r of results) {
    if (
      r != null &&
      r.url != null &&
      typeof r.text === "string" &&
      r.text.length > 0
    ) {
      out.push({
        url: r.url,
        title: r.title || "",
        content: r.text,
        error: null,
      });
    }
  }
  return out;
}

async function searchWithExaApi(
  query: string,
  options: SearchOptions = {},
): Promise<SearchResponse> {
  const apiKey = getExaApiKey()!;
  const useSearch =
    options.includeContent ||
    options.recencyFilter != null ||
    (options.domainFilter != null && options.domainFilter.length > 0) ||
    (options.numResults != null && options.numResults !== 5);

  if (!useSearch) {
    const response = await fetch(EXA_ANSWER_URL, {
      method: "POST",
      headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ query: query, text: true }),
      signal: requestSignal(options.signal),
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        "Exa API error " + response.status + ": " + errorText.slice(0, 300),
      );
    }
    const data = (await response.json()) as ExaAnswerResponse;
    return {
      answer: data.answer || "",
      results: mapApiResults(data.citations),
    };
  }

  const startDate =
    options.recencyFilter != null
      ? recencyToStartDate(options.recencyFilter)
      : null;
  const domainFilters = mapDomainFilter(options.domainFilter);
  const numResults = options.numResults != null ? options.numResults : 5;

  const body: Record<string, unknown> = {
    query: query,
    type: "auto",
    numResults: numResults,
    ...domainFilters,
    contents: {
      text: options.includeContent ? true : { maxCharacters: 3000 },
      highlights: true,
    },
  };
  if (startDate != null) body.startPublishedDate = startDate;

  const response = await fetch(EXA_SEARCH_URL, {
    method: "POST",
    headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: requestSignal(options.signal),
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      "Exa API error " + response.status + ": " + errorText.slice(0, 300),
    );
  }
  const data = (await response.json()) as ExaSearchResponse;
  const mapped: SearchResponse = {
    answer: buildAnswerFromApiResults(data.results),
    results: mapApiResults(data.results),
  };
  if (options.includeContent) {
    const inlineContent = mapApiInlineContent(data.results);
    if (inlineContent.length > 0) mapped.inlineContent = inlineContent;
  }
  return mapped;
}

// ─── Public: search ─────────────────────────────────────────────────────────

export async function search(
  query: string,
  options: SearchOptions = {},
): Promise<SearchResponse> {
  const apiKey = getExaApiKey();

  try {
    if (apiKey) {
      return await searchWithExaApi(query, options);
    }
    const result = await searchWithExaMcp(query, options);
    if (result) return result;
    throw new Error("Exa MCP search returned no results.");
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw new Error(
      "Exa search failed: " +
        errorMessage(err) +
        "\n\n" +
        "Exa MCP provides 1,000 free requests/month with no API key. " +
        "Set EXA_API_KEY or exaApiKey in ~/.pi/web-search.json for higher limits.",
    );
  }
}

export function isExaAvailable(): boolean {
  return true; // MCP always available without key
}
