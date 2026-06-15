import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { search, isExaAvailable } from "./search.js";
import { executeCodeSearch } from "./code-search.js";
import { fetchAllContent, truncateForInline } from "./extract.js";
import { clearCloneCache } from "./github.js";
import {
  generateId,
  storeResult,
  getResult,
  getAllResults,
  clearResults,
  restoreFromSession,
  type ExtractedContent,
  type QueryResultData,
  type StoredSearchData,
} from "./storage.js";
import { isAbortError, errorMessage } from "./utils.js";

const MAX_INLINE_CONTENT = 30000;

function formatSearchOutput(queries: QueryResultData[], responseId: string): string {
  let output = "";
  for (const qd of queries) {
    output += '## Results for: "' + qd.query + '"\n\n';
    if (qd.answer) output += qd.answer + "\n\n---\n\n";
    for (let i = 0; i < qd.results.length; i++) {
      const r = qd.results[i];
      output += (i + 1) + ". **" + r.title + "**\n   " + r.url + "\n";
      if (r.snippet) output += "   " + r.snippet + "\n";
    }
    output += "\n";
  }
  output += "\n_Response ID: " + responseId + ". Use get_search_content with this ID to retrieve full content._";
  return output;
}

function formatFetchOutput(urls: ExtractedContent[], responseId: string): string {
  let output = "";
  for (const uc of urls) {
    output += "## " + (uc.title || uc.url) + "\n\n";
    if (uc.error) {
      output += "Error: " + uc.error + "\n\n";
    } else {
      output += truncateForInline(uc.content);
      output += "\n\n";
    }
  }
  output += "\n_Response ID: " + responseId + ". Use get_search_content with this ID to retrieve full content._";
  return output;
}

export default function (pi: ExtensionAPI) {
  // ─── Session lifecycle ──────────────────────────────────────────────────

  pi.on("session_start", async function (_event, ctx) {
    clearResults();
    clearCloneCache();
    restoreFromSession(ctx);
  });

  pi.on("session_shutdown", async function () {
    clearCloneCache();
  });

  // ─── web_search ─────────────────────────────────────────────────────────

  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web via Exa (zero-config MCP, no API key needed). Returns a synthesized answer with source citations.",
    promptSnippet: "Search the web for current information",
    promptGuidelines: [
      "Use web_search when you need current information from the internet, recent events, or facts not in your training data.",
      "Use code_search when looking for code examples, API docs, or programming solutions.",
      "Use fetch_content when you have a specific URL and want to read its full content.",
    ],
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Single search query" })),
      queries: Type.Optional(Type.Array(Type.String(), { description: "Multiple search queries (batch)" })),
      numResults: Type.Optional(Type.Number({ description: "Results per query (default 5, max 20)", minimum: 1, maximum: 20 })),
      recencyFilter: Type.Optional(StringEnum(["day", "week", "month", "year"] as const, { description: "Filter by recency" })),
      domainFilter: Type.Optional(Type.Array(Type.String(), { description: "Limit to domains (prefix - to exclude)" })),
      includeContent: Type.Optional(Type.Boolean({ description: "Fetch full page content from search result sources" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      let queryList: string[];
      if (params.queries != null && params.queries.length > 0) {
        queryList = params.queries;
      } else if (params.query != null && params.query.length > 0) {
        queryList = [params.query];
      } else {
        queryList = [];
      }

      if (queryList.length === 0) {
        return {
          content: [{ type: "text", text: "Error: Provide at least one query via 'query' or 'queries'." }],
          details: { error: "No query provided" },
        };
      }

      const responseId = generateId();
      const queryResults: QueryResultData[] = [];

      for (const query of queryList) {
        try {
          if (onUpdate != null) {
            onUpdate({ content: [{ type: "text", text: 'Searching: "' + query + '"...' }] });
          }

          const result = await search(query, {
            numResults: params.numResults,
            recencyFilter: params.recencyFilter as "day" | "week" | "month" | "year" | undefined,
            domainFilter: params.domainFilter,
            includeContent: params.includeContent,
            signal: signal,
          });

          queryResults.push({
            query: query,
            answer: result.answer,
            results: result.results,
            error: null,
          });

          // Store inline content if fetched
          if (result.inlineContent) {
            const stored: StoredSearchData = {
              id: responseId,
              type: "fetch",
              timestamp: Date.now(),
              urls: result.inlineContent,
            };
            storeResult(responseId, stored);
            pi.appendEntry("web-search-results", stored);
          }
        } catch (err) {
          if (isAbortError(err)) {
            queryResults.push({ query: query, answer: "", results: [], error: "Aborted" });
          } else {
            queryResults.push({ query: query, answer: "", results: [], error: errorMessage(err) });
          }
        }
      }

      // Store search results
      const stored: StoredSearchData = {
        id: responseId,
        type: "search",
        timestamp: Date.now(),
        queries: queryResults,
      };
      storeResult(responseId, stored);
      pi.appendEntry("web-search-results", stored);

      const hasErrors = queryResults.some(function (q) { return q.error != null; });
      const output = formatSearchOutput(queryResults, responseId);

      return {
        content: [{ type: "text", text: output }],
        details: { responseId: responseId, queries: queryResults },
        isError: hasErrors,
      };
    },
  });

  // ─── code_search ────────────────────────────────────────────────────────

  pi.registerTool({
    name: "code_search",
    label: "Code Search",
    description:
      "Search for code examples, documentation, and API references via Exa MCP. No API key required. Falls back to code-focused web search.",
    promptSnippet: "Search for code examples and documentation",
    parameters: Type.Object({
      query: Type.String({ description: "Programming question, API, library, or debugging topic" }),
      maxTokens: Type.Optional(Type.Number({ description: "Max tokens of context (default 5000, max 50000)", minimum: 1000, maximum: 50000 })),
    }),
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const maxTokens = params.maxTokens != null ? params.maxTokens : 5000;
      const result = await executeCodeSearch(params.query, maxTokens, signal);

      return {
        content: [{ type: "text", text: result.content }],
        details: { query: params.query, maxTokens: maxTokens, mode: result.mode, error: result.error },
        isError: result.error != null,
      };
    },
  });

  // ─── fetch_content ──────────────────────────────────────────────────────

  pi.registerTool({
    name: "fetch_content",
    label: "Fetch Content",
    description:
      "Fetch URL(s) and extract readable content as markdown. Handles GitHub repos (clones locally), PDFs, and regular web pages. Falls back to Jina Reader for JS-rendered pages.",
    promptSnippet: "Fetch and read web page content",
    parameters: Type.Object({
      url: Type.Optional(Type.String({ description: "Single URL to fetch" })),
      urls: Type.Optional(Type.Array(Type.String(), { description: "Multiple URLs to fetch" })),
      forceClone: Type.Optional(Type.Boolean({ description: "Force-clone GitHub repos exceeding size threshold" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      let urlList: string[];
      if (params.urls != null && params.urls.length > 0) {
        urlList = params.urls;
      } else if (params.url != null && params.url.length > 0) {
        urlList = [params.url];
      } else {
        urlList = [];
      }

      if (urlList.length === 0) {
        return {
          content: [{ type: "text", text: "Error: Provide at least one URL via 'url' or 'urls'." }],
          details: { error: "No URL provided" },
        };
      }

      const responseId = generateId();
      if (onUpdate != null) {
        onUpdate({ content: [{ type: "text", text: "Fetching " + urlList.length + " URL(s)..." }] });
      }

      const results = await fetchAllContent(urlList, {
        signal: signal,
        forceClone: params.forceClone,
      });

      // Store full content for retrieval
      const stored: StoredSearchData = {
        id: responseId,
        type: "fetch",
        timestamp: Date.now(),
        urls: results,
      };
      storeResult(responseId, stored);
      pi.appendEntry("web-search-results", stored);

      const output = formatFetchOutput(results, responseId);
      const hasErrors = results.some(function (r) { return r.error != null; });

      return {
        content: [{ type: "text", text: output }],
        details: { responseId: responseId, urls: results.map(function (r) { return { url: r.url, title: r.title, error: r.error }; }) },
        isError: hasErrors,
      };
    },
  });

  // ─── get_search_content ─────────────────────────────────────────────────

  pi.registerTool({
    name: "get_search_content",
    label: "Get Search Content",
    description:
      "Retrieve stored content from previous searches or fetches. Content over 30,000 chars is truncated in tool responses but stored in full here.",
    parameters: Type.Object({
      responseId: Type.String({ description: "Response ID from a previous web_search or fetch_content call" }),
      urlIndex: Type.Optional(Type.Number({ description: "Index of URL in the results" })),
      url: Type.Optional(Type.String({ description: "Specific URL to retrieve content for" })),
      query: Type.Optional(Type.String({ description: "Original query to look up" })),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const stored = getResult(params.responseId);
      if (!stored) {
        // Try searching by query
        if (params.query) {
          const all = getAllResults();
          const match = all.find(function (s) {
            if (s.type !== "search" || s.queries == null) return false;
            return s.queries.some(function (q) { return q.query === params.query; });
          });
          if (match) {
            return getFullContent(match, params);
          }
        }
        return {
          content: [{ type: "text", text: 'No results found for response ID "' + params.responseId + '".' }],
          details: { error: "Not found" },
        };
      }

      return getFullContent(stored, params);
    },
  });

  function getFullContent(stored: StoredSearchData, params: { urlIndex?: number; url?: string }) {
    if (stored.type === "search" && stored.queries != null) {
      let output = "";
      for (const qd of stored.queries) {
        output += '## Query: "' + qd.query + '"\n\n';
        if (qd.answer) output += qd.answer + "\n\n";
        for (const r of qd.results) {
          output += "- **" + r.title + "** " + r.url + "\n";
          if (r.snippet) output += "  " + r.snippet + "\n";
        }
        output += "\n";
      }
      return {
        content: [{ type: "text", text: output }],
        details: { id: stored.id, type: stored.type },
      };
    }

    if (stored.type === "fetch" && stored.urls != null) {
      let targetUrls = stored.urls;

      if (params.url) {
        targetUrls = stored.urls.filter(function (u) { return u.url === params.url; });
        if (targetUrls.length === 0) {
          return {
            content: [{ type: "text", text: 'URL "' + params.url + '" not found in stored results.' }],
            details: { error: "URL not found" },
          };
        }
      } else if (params.urlIndex !== undefined && params.urlIndex >= 0 && params.urlIndex < stored.urls.length) {
        targetUrls = [stored.urls[params.urlIndex]];
      }

      let output = "";
      for (const uc of targetUrls) {
        output += "## " + (uc.title || uc.url) + "\n\n";
        if (uc.error) {
          output += "Error: " + uc.error + "\n\n";
        } else {
          output += uc.content;
          output += "\n\n";
        }
      }

      return {
        content: [{ type: "text", text: output }],
        details: { id: stored.id, type: stored.type, count: targetUrls.length },
      };
    }

    return {
      content: [{ type: "text", text: "No content available." }],
      details: { id: stored.id, type: stored.type },
    };
  }

  // ─── Commands ───────────────────────────────────────────────────────────

  pi.registerCommand("websearch", {
    description: "Run a web search with the current editor text or provided queries",
    handler: async function (args, ctx) {
      const queries = args
        ? args.split(",").map(function (q) { return q.trim(); }).filter(Boolean)
        : [];
      if (queries.length === 0) {
        ctx.ui.notify("Usage: /websearch query1, query2, ...", "info");
        return;
      }
      const queryText = queries.length === 1
        ? "Use web_search to search for: " + queries[0]
        : "Use web_search to search for each of these: " + queries.map(function (q) { return '"' + q + '"'; }).join(", ");
      pi.sendUserMessage(queryText, { deliverAs: "followUp" });
    },
  });

  pi.registerCommand("search", {
    description: "Browse stored search results from the current session",
    handler: async function (_args, ctx) {
      const results = getAllResults();
      if (results.length === 0) {
        ctx.ui.notify("No stored search results in this session.", "info");
        return;
      }
      const lines = results.map(function (r) {
        const time = new Date(r.timestamp).toLocaleTimeString();
        if (r.type === "search") {
          const queries = r.queries != null ? r.queries.map(function (q) { return q.query; }).join(", ") : "?";
          return "[" + time + "] " + r.id + " search: " + queries;
        }
        const urls = r.urls != null ? r.urls.map(function (u) { return u.url; }).join(", ") : "?";
        return "[" + time + "] " + r.id + " fetch: " + urls;
      });
      ctx.ui.notify("Stored results:\n" + lines.join("\n"), "info");
    },
  });
}
