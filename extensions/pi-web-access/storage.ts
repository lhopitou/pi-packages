import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchResponse {
  answer: string;
  results: SearchResult[];
  inlineContent?: ExtractedContent[];
}

export interface ExtractedContent {
  url: string;
  title: string;
  content: string;
  error: string | null;
}

export interface QueryResultData {
  query: string;
  answer: string;
  results: SearchResult[];
  error: string | null;
}

export interface StoredSearchData {
  id: string;
  type: "search" | "fetch";
  timestamp: number;
  queries?: QueryResultData[];
  urls?: ExtractedContent[];
}

const storedResults = new Map<string, StoredSearchData>();

export function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function storeResult(id: string, data: StoredSearchData): void {
  storedResults.set(id, data);
}

export function getResult(id: string): StoredSearchData | null {
  const val = storedResults.get(id);
  return val != null ? val : null;
}

export function getAllResults(): StoredSearchData[] {
  return Array.from(storedResults.values());
}

export function clearResults(): void {
  storedResults.clear();
}

const CACHE_TTL_MS = 60 * 60 * 1000;

function isValidStoredData(data: unknown): data is StoredSearchData {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  if (typeof d.id !== "string" || !d.id) return false;
  if (d.type !== "search" && d.type !== "fetch") return false;
  if (typeof d.timestamp !== "number") return false;
  if (d.type === "search" && !Array.isArray(d.queries)) return false;
  if (d.type === "fetch" && !Array.isArray(d.urls)) return false;
  return true;
}

export function restoreFromSession(ctx: ExtensionContext): void {
  storedResults.clear();
  const now = Date.now();
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === "web-search-results") {
      const data = entry.data;
      if (isValidStoredData(data) && now - data.timestamp < CACHE_TTL_MS) {
        storedResults.set(data.id, data);
      }
    }
  }
}

export type { SearchResponse as SearchResponseType };
