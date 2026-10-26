import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, keyHint } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
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

    // ── renderCall ──────────────────────────────────────────────────

    renderCall(args, theme, _context) {
      const queryLabel = args.queries?.length
        ? args.queries.map(function (q: string) { return '"' + q + '"'; }).join(", ")
        : args.query
          ? '"' + args.query + '"'
          : "...";
      return new Text(
        theme.fg("toolTitle", theme.bold("web_search ")) + theme.fg("muted", queryLabel),
        0, 0,
      );
    },

    // ── renderResult ────────────────────────────────────────────────

    renderResult(result, { expanded }, theme, _context) {
      const details = result.details as { responseId?: string; queries?: QueryResultData[] } | undefined;
      if (!details || !details.queries) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
      }

      const mdTheme = getMarkdownTheme();
      const container = new Container();
      const hasErrors = details.queries.some(function (q) { return q.error != null; });
      const icon = hasErrors ? theme.fg("warning", "⚠") : theme.fg("success", "✓");
      const label = theme.fg("toolTitle", theme.bold("web_search"));
      const rid = theme.fg("dim", " · " + details.responseId);

      // ── Collapsed ────────────────────────────────────────
      if (!expanded) {
        let header = icon + " " + label + rid;
        const count = details.queries.reduce(function (sum, q) { return sum + q.results.length; }, 0);
        header += theme.fg("dim", " · " + count + " result" + (count !== 1 ? "s" : ""));
        container.addChild(new Text(header, 0, 0));

        for (const qd of details.queries.slice(0, 2)) {
          container.addChild(new Text(theme.fg("muted", "─── " + qd.query + " ───"), 0, 0));
          if (qd.answer) {
            const answerLines = qd.answer.trim().split(/\r?\n/).map(function (l) { return l.trimEnd(); }).filter(function (l) { return l.trim(); });
            container.addChild(new Text(theme.fg("toolOutput", answerLines.slice(0, 3).join("\n")), 0, 0));
            if (answerLines.length > 3) {
              container.addChild(new Text(theme.fg("dim", "… " + (answerLines.length - 3) + " more lines"), 0, 0));
            }
          }
          for (const r of qd.results.slice(0, 3)) {
            container.addChild(new Text(
              theme.fg("accent", "• ") + theme.fg("text", r.title) + "\n" +
              theme.fg("dim", "  " + r.url),
              0, 0,
            ));
          }
          if (qd.results.length > 3) {
            container.addChild(new Text(theme.fg("dim", "… " + (qd.results.length - 3) + " more results"), 0, 0));
          }
          if (qd.error) {
            container.addChild(new Text(theme.fg("error", qd.error.slice(0, 120)), 0, 0));
          }
        }
        if (details.queries.length > 2) {
          container.addChild(new Text(theme.fg("dim", "… " + (details.queries.length - 2) + " more queries"), 0, 0));
        }
        container.addChild(new Text(
          theme.fg("dim", keyHint("app.tools.expand", "expand")) +
          theme.fg("dim", " · get_search_content for full content"),
          0, 0,
        ));
        return container;
      }

      // ── Expanded ─────────────────────────────────────────
      container.addChild(new Text(
        icon + " " + label + rid +
        theme.fg("dim", " · " + keyHint("app.tools.expand", "collapse")),
        0, 0,
      ));

      for (const qd of details.queries) {
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("muted", '─── "' + qd.query + '" ───'), 0, 0));
        if (qd.answer) {
          container.addChild(new Markdown(qd.answer.trim(), 0, 0, mdTheme));
        }
        for (const r of qd.results) {
          container.addChild(new Text(
            theme.fg("accent", "• ") + theme.fg("text", r.title) + "\n" +
            theme.fg("dim", "  " + r.url) +
            (r.snippet ? "\n" + theme.fg("muted", "  " + r.snippet) : ""),
            0, 0,
          ));
        }
        if (qd.error) {
          container.addChild(new Text(theme.fg("error", "Error: " + qd.error), 0, 0));
        }
      }

      container.addChild(new Spacer(1));
      container.addChild(new Text(
        theme.fg("dim", "Response ID: " + details.responseId + ". Use get_search_content to retrieve full content."),
        0, 0,
      ));
      return container;
    },

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

    // ── renderCall ──────────────────────────────────────────────────

    renderCall(args, theme, _context) {
      return new Text(
        theme.fg("toolTitle", theme.bold("code_search ")) + theme.fg("muted", '"' + args.query + '"'),
        0, 0,
      );
    },

    // ── renderResult ────────────────────────────────────────────────

    renderResult(result, { expanded }, theme, _context) {
      const details = result.details as { query?: string; maxTokens?: number; mode?: string; error?: string } | undefined;
      const text = result.content[0];
      const rawText = text?.type === "text" ? text.text : "";

      if (!rawText) {
        return new Text(theme.fg("dim", "(no output)"), 0, 0);
      }

      const icon = details?.error ? theme.fg("warning", "⚠") : theme.fg("success", "✓");
      const meta = theme.fg("dim", " · " + (details?.mode ?? "") + (details?.maxTokens ? " · " + details.maxTokens + " tok" : ""));

      if (!expanded) {
        const lines = rawText.split("\n").map(function (l) { return l.trimEnd(); }).filter(function (l) { return l.trim(); });
        const preview = lines.slice(0, 5);
        const hidden = Math.max(0, lines.length - 5);
        let content = icon + " " + theme.fg("toolTitle", theme.bold("code_search")) + meta;
        for (const line of preview) {
          content += "\n" + theme.fg("toolOutput", line);
        }
        if (hidden > 0) {
          content += "\n" + theme.fg("dim", "… " + hidden + " more lines");
        }
        content += "\n" + theme.fg("dim", keyHint("app.tools.expand", "expand"));
        return new Text(content, 0, 0);
      }

      // Expanded
      const container = new Container();
      container.addChild(new Text(
        icon + " " + theme.fg("toolTitle", theme.bold("code_search")) + meta +
        theme.fg("dim", " · " + keyHint("app.tools.expand", "collapse")),
        0, 0,
      ));
      container.addChild(new Spacer(1));
      container.addChild(new Markdown(rawText.trim(), 0, 0, getMarkdownTheme()));
      return container;
    },

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

    // ── renderCall ──────────────────────────────────────────────────

    renderCall(args, theme, _context) {
      const urlLabel = args.urls?.length
        ? args.urls.length + " URL(s)"
        : args.url
          ? args.url
          : "...";
      return new Text(
        theme.fg("toolTitle", theme.bold("fetch_content ")) + theme.fg("muted", urlLabel),
        0, 0,
      );
    },

    // ── renderResult ────────────────────────────────────────────────

    renderResult(result, { expanded }, theme, _context) {
      const details = result.details as { responseId?: string; urls?: { url: string; title?: string; error?: string }[] } | undefined;
      if (!details || !details.urls) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
      }

      const mdTheme = getMarkdownTheme();
      const container = new Container();
      const hasErrors = details.urls.some(function (u) { return u.error != null; });
      const icon = hasErrors ? theme.fg("warning", "⚠") : theme.fg("success", "✓");
      const label = theme.fg("toolTitle", theme.bold("fetch_content"));
      const rid = theme.fg("dim", " · " + details.responseId);

      // ── Collapsed ────────────────────────────────────────
      if (!expanded) {
        let header = icon + " " + label + rid +
          theme.fg("dim", " · " + details.urls.length + " URL" + (details.urls.length !== 1 ? "s" : ""));
        container.addChild(new Text(header, 0, 0));

        for (const uc of details.urls.slice(0, 3)) {
          const title = uc.title || uc.url;
          if (uc.error) {
            container.addChild(new Text(
              theme.fg("error", "✗ ") + theme.fg("muted", title) +
              "\n" + theme.fg("error", "  " + uc.error.slice(0, 80)),
              0, 0,
            ));
          } else {
            container.addChild(new Text(
              theme.fg("success", "✓ ") + theme.fg("text", title) +
              "\n" + theme.fg("dim", "  " + uc.url),
              0, 0,
            ));
          }
        }
        if (details.urls.length > 3) {
          container.addChild(new Text(theme.fg("dim", "… " + (details.urls.length - 3) + " more URLs"), 0, 0));
        }
        container.addChild(new Text(
          theme.fg("dim", keyHint("app.tools.expand", "expand")) +
          theme.fg("dim", " · get_search_content for full content"),
          0, 0,
        ));
        return container;
      }

      // ── Expanded ─────────────────────────────────────────
      container.addChild(new Text(
        icon + " " + label + rid +
        theme.fg("dim", " · " + keyHint("app.tools.expand", "collapse")),
        0, 0,
      ));

      // Re-render the full markdown output for each URL
      const fullText = result.content[0];
      const rawText = fullText?.type === "text" ? fullText.text : "";

      for (const uc of details.urls) {
        container.addChild(new Spacer(1));
        const title = uc.title || uc.url;
        container.addChild(new Text(theme.fg("muted", "─── " + title + " ───"), 0, 0));
        if (uc.error) {
          container.addChild(new Text(theme.fg("error", "Error: " + uc.error), 0, 0));
        } else {
          // Find this URL's section in the full markdown output
          const sectionRegex = /^## /m;
          const sections = rawText.split(sectionRegex);
          for (const section of sections) {
            const trimmed = section.trim();
            if (!trimmed) continue;
            // Check if this section matches the URL or title
            const firstLine = trimmed.split("\n")[0] || "";
            if (firstLine === title || firstLine === uc.url) {
              container.addChild(new Markdown(trimmed, 0, 0, mdTheme));
              break;
            }
          }
        }
      }

      container.addChild(new Spacer(1));
      container.addChild(new Text(
        theme.fg("dim", "Response ID: " + details.responseId + ". Use get_search_content to retrieve full content."),
        0, 0,
      ));
      return container;
    },

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

    // ── renderCall ──────────────────────────────────────────────────

    renderCall(args, theme, _context) {
      const target = args.url
        ? args.url
        : args.urlIndex !== undefined
          ? "#" + args.urlIndex
          : args.responseId;
      return new Text(
        theme.fg("toolTitle", theme.bold("get_search_content ")) + theme.fg("muted", target),
        0, 0,
      );
    },

    // ── renderResult ────────────────────────────────────────────────

    renderResult(result, { expanded }, theme, _context) {
      const text = result.content[0];
      const rawText = text?.type === "text" ? text.text : "";
      if (!rawText) {
        return new Text(theme.fg("dim", "(no output)"), 0, 0);
      }

      const icon = result.isError ? theme.fg("warning", "⚠") : theme.fg("success", "✓");
      const label = theme.fg("toolTitle", theme.bold("get_search_content"));

      if (!expanded) {
        const lines = rawText.split("\n").map(function (l) { return l.trimEnd(); }).filter(function (l) { return l.trim(); });
        const preview = lines.slice(0, 5);
        const hidden = Math.max(0, lines.length - 5);
        let content = icon + " " + label;
        for (const line of preview) {
          content += "\n" + theme.fg("toolOutput", line);
        }
        if (hidden > 0) {
          content += "\n" + theme.fg("dim", "… " + hidden + " more lines");
        }
        content += "\n" + theme.fg("dim", keyHint("app.tools.expand", "expand"));
        return new Text(content, 0, 0);
      }

      // Expanded
      const container = new Container();
      container.addChild(new Text(
        icon + " " + label +
        theme.fg("dim", " · " + keyHint("app.tools.expand", "collapse")),
        0, 0,
      ));
      container.addChild(new Spacer(1));
      container.addChild(new Markdown(rawText.trim(), 0, 0, getMarkdownTheme()));
      return container;
    },

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
