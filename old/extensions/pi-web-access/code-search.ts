import { callExaMcp } from "./search.js";
import { truncateToTokenEstimate } from "./utils.js";

const CODE_CONTEXT_TOOL = "get_code_context_exa";
const WEB_SEARCH_TOOL = "web_search_exa";
const DEFAULT_MAX_TOKENS = 5000;

let codeContextToolMissing = false;

function isMissingMcpToolError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("tool") && normalized.includes("not found");
}

function buildFallbackQuery(query: string): string {
  const hasCodeTerms = /\b(api|code|docs?|documentation|example|github|implementation|library|source|stackoverflow)\b/i.test(query);
  return hasCodeTerms ? query : `${query} code examples documentation GitHub Stack Overflow official docs`;
}

function maxTokensToResultCount(maxTokens: number): number {
  return Math.min(20, Math.max(5, Math.ceil(maxTokens / 1000)));
}

async function executeFallbackSearch(query: string, maxTokens: number, signal?: AbortSignal): Promise<string> {
  const text = await callExaMcp(WEB_SEARCH_TOOL, {
    query: buildFallbackQuery(query),
    numResults: maxTokensToResultCount(maxTokens),
    livecrawl: "fallback",
    type: "auto",
    contextMaxCharacters: Math.min(50000, Math.max(1000, maxTokens * 4)),
  }, signal);
  return truncateToTokenEstimate(text, maxTokens);
}

export async function executeCodeSearch(
  query: string,
  maxTokens: number = DEFAULT_MAX_TOKENS,
  signal?: AbortSignal,
): Promise<{
  content: string;
  mode: "code-context" | "web-search-fallback";
  error?: string;
}> {
  const trimmed = query.trim();
  if (!trimmed) return { content: "Error: No query provided.", mode: "web-search-fallback", error: "No query provided" };

  try {
    let mode: "code-context" | "web-search-fallback" = "web-search-fallback";
    let text: string;

    if (codeContextToolMissing) {
      text = await executeFallbackSearch(trimmed, maxTokens, signal);
    } else {
      try {
        text = await callExaMcp(CODE_CONTEXT_TOOL, { query: trimmed, tokensNum: maxTokens }, signal);
        mode = "code-context";
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!isMissingMcpToolError(message)) throw err;
        codeContextToolMissing = true;
        text = await executeFallbackSearch(trimmed, maxTokens, signal);
      }
    }

    return { content: text, mode };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: `Error: ${message}`, mode: "web-search-fallback", error: message };
  }
}
