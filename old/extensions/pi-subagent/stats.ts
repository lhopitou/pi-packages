/**
 * stats.ts — Per-agent aggregated usage statistics.
 *
 * Records each subagent completion to a session-scoped JSONL log and
 * provides aggregated views by agent name.  The log lives in memory
 * for the current process and is also appended to a file so stats
 * survive across reloads within the same Pi session.
 *
 * File: ~/.pi/agent/subagent-stats.jsonl  (one JSON object per line)
 */

import {
  existsSync,
  readFileSync,
  appendFileSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { SubagentMetadata } from "./runner.ts";

// ── Types ────────────────────────────────────────────────────────────

export interface AgentRunRecord {
  agent: string;
  metadata: SubagentMetadata;
  timestamp: number;
}

export interface AgentAggregatedStats {
  runs: number;
  successes: number;
  failures: number;
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  totalCost: number;
  totalDurationMs: number;
  totalTurns: number;
  totalToolCalls: number;
  lastRunAt: number;
}

// ── Persistence ──────────────────────────────────────────────────────

const STATS_DIR = join(homedir(), ".pi", "agent");
const STATS_FILE = join(STATS_DIR, "subagent-stats.jsonl");

function ensureStatsDir(): void {
  if (!existsSync(STATS_DIR)) {
    mkdirSync(STATS_DIR, { recursive: true });
  }
}

/** Append a run record to the JSONL log. Best-effort — never throws. */
export function persistRun(record: AgentRunRecord): void {
  try {
    ensureStatsDir();
    appendFileSync(STATS_FILE, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // Stats persistence is best-effort
  }
}

/** Read all persisted run records from the JSONL log. */
export function loadPersistedRuns(): AgentRunRecord[] {
  if (!existsSync(STATS_FILE)) return [];
  try {
    const raw = readFileSync(STATS_FILE, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        try {
          return JSON.parse(line) as AgentRunRecord;
        } catch {
          return undefined;
        }
      })
      .filter((r): r is AgentRunRecord => r !== undefined);
  } catch {
    return [];
  }
}

// ── In-memory accumulator ────────────────────────────────────────────

/** In-memory records for the current process (includes reloaded persisted data). */
const inMemoryRuns: AgentRunRecord[] = [];

/** Whether we've loaded the persisted log yet. */
let loaded = false;

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  inMemoryRuns.push(...loadPersistedRuns());
}

// ── Public API ───────────────────────────────────────────────────────

/** Record a completed subagent run. */
export function recordAgentRun(record: AgentRunRecord): void {
  ensureLoaded();
  inMemoryRuns.push(record);
  persistRun(record);
}

/** Get all run records for the current session (includes persisted). */
export function getSessionRunLog(): AgentRunRecord[] {
  ensureLoaded();
  return [...inMemoryRuns];
}

/** Compute per-agent aggregated stats from all known runs. */
export function getAggregatedStats(): Record<string, AgentAggregatedStats> {
  ensureLoaded();
  const stats: Record<string, AgentAggregatedStats> = {};

  for (const run of inMemoryRuns) {
    const name = run.agent;
    if (!stats[name]) {
      stats[name] = {
        runs: 0,
        successes: 0,
        failures: 0,
        totalInput: 0,
        totalOutput: 0,
        totalCacheRead: 0,
        totalCacheWrite: 0,
        totalCost: 0,
        totalDurationMs: 0,
        totalTurns: 0,
        totalToolCalls: 0,
        lastRunAt: 0,
      };
    }

    const s = stats[name]!;
    s.runs++;
    // A run with 0 turns and non-zero duration likely failed before first LLM response
    const success = run.metadata.turns > 0 || run.metadata.durationMs === 0;
    if (success) s.successes++;
    else s.failures++;
    s.totalInput += run.metadata.input;
    s.totalOutput += run.metadata.output;
    s.totalCacheRead += run.metadata.cacheRead;
    s.totalCacheWrite += run.metadata.cacheWrite;
    s.totalCost += run.metadata.cost;
    s.totalDurationMs += run.metadata.durationMs;
    s.totalTurns += run.metadata.turns;
    s.totalToolCalls += run.metadata.toolCalls;
    s.lastRunAt = Math.max(s.lastRunAt, run.timestamp);
  }

  return stats;
}

/** Clear all in-memory and persisted stats. */
export function clearStats(): void {
  inMemoryRuns.length = 0;
  try {
    ensureStatsDir();
    writeFileSync(STATS_FILE, "", "utf8");
  } catch {
    // Best-effort
  }
}

/** Format aggregated stats for display. */
export function formatAggregatedStats(
  stats: Record<string, AgentAggregatedStats>,
): string {
  const agents = Object.keys(stats);
  if (agents.length === 0) {
    return "No subagent runs recorded in this session.";
  }

  const fmt = (n: number): string =>
    n < 1000
      ? String(n)
      : n < 10000
        ? `${(n / 1000).toFixed(1)}k`
        : `${Math.round(n / 1000)}k`;

  const fmtDur = (ms: number): string => {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 60000)}m${Math.floor((ms % 60000) / 1000)}s`;
  };

  const lines: string[] = ["Subagent Usage Stats", ""];

  // Grand totals
  const totals: AgentAggregatedStats = {
    runs: 0,
    successes: 0,
    failures: 0,
    totalInput: 0,
    totalOutput: 0,
    totalCacheRead: 0,
    totalCacheWrite: 0,
    totalCost: 0,
    totalDurationMs: 0,
    totalTurns: 0,
    totalToolCalls: 0,
    lastRunAt: 0,
  };
  for (const s of Object.values(stats)) {
    totals.runs += s.runs;
    totals.successes += s.successes;
    totals.failures += s.failures;
    totals.totalInput += s.totalInput;
    totals.totalOutput += s.totalOutput;
    totals.totalCacheRead += s.totalCacheRead;
    totals.totalCacheWrite += s.totalCacheWrite;
    totals.totalCost += s.totalCost;
    totals.totalDurationMs += s.totalDurationMs;
    totals.totalTurns += s.totalTurns;
    totals.totalToolCalls += s.totalToolCalls;
  }

  lines.push(
    `  Total: ${totals.runs} runs (${totals.successes} ✓, ${totals.failures} ✗) · ↑${fmt(totals.totalInput)} ↓${fmt(totals.totalOutput)} R${fmt(totals.totalCacheRead)} CH${totals.totalCacheRead + totals.totalInput + totals.totalCacheWrite > 0 ? ((totals.totalCacheRead / (totals.totalCacheRead + totals.totalInput + totals.totalCacheWrite)) * 100).toFixed(0) : "0"}% · $${totals.totalCost.toFixed(3)} · ${fmtDur(totals.totalDurationMs)}`,
  );
  lines.push("");

  // Per-agent breakdown
  for (const [name, s] of Object.entries(stats).sort(
    ([, a], [, b]) => b.totalCost - a.totalCost,
  )) {
    const chRate =
      s.totalCacheRead + s.totalInput + s.totalCacheWrite > 0
        ? ` CH${((s.totalCacheRead / (s.totalCacheRead + s.totalInput + s.totalCacheWrite)) * 100).toFixed(0)}%`
        : "";
    const failStr = s.failures > 0 ? ` · ${s.failures} ✗` : "";
    lines.push(
      `  ${name}: ${s.runs} run${s.runs !== 1 ? "s" : ""} · ${s.totalTurns}t · ${s.totalToolCalls} tools · ↑${fmt(s.totalInput)} ↓${fmt(s.totalOutput)}${chRate} · $${s.totalCost.toFixed(3)} · ${fmtDur(s.totalDurationMs)}${failStr}`,
    );
  }

  return lines.join("\n");
}
