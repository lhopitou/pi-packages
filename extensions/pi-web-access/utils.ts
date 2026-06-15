export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function isAbortError(err: unknown): boolean {
  return errorMessage(err).toLowerCase().includes("abort");
}

export function formatSeconds(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function truncateToTokenEstimate(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).trimEnd()}\n\n[Truncated to ~${maxTokens} tokens]`;
}
