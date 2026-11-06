/**
 * async-tracker.ts — In-memory async job tracker with file-based poller.
 *
 * Tracks background subagent jobs: registers new jobs, polls status.json
 * files at a configurable interval, updates in-memory state, and manages
 * completion cleanup timers.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { userInfo } from "node:os";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// ── Types ────────────────────────────────────────────────────────────

export interface AsyncJobState {
  id: string;
  asyncDir: string;
  status: "queued" | "running" | "complete" | "failed" | "cancelled";
  pid?: number;
  agent: string;
  task: string;
  sessionFile: string;
  startedAt: number;
  updatedAt: number;
  turnCount: number;
  toolCount: number;
  currentTool?: string;
  currentPath?: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
  durationMs: number;
  error?: string;
}

export interface AsyncTrackerConfig {
  pollIntervalMs: number;
  completionRetentionMs: number;
}

interface StatusSnapshot {
  state: "running" | "complete" | "failed";
  pid: number;
  agent: string;
  task: string;
  turnCount: number;
  toolCount: number;
  currentTool?: string;
  currentPath?: string;
  lastActivityAt: number;
  startedAt: number;
  sessionFile: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
  durationMs: number;
  error?: string;
}

// ── Temp directory ───────────────────────────────────────────────────

const SCOPE_ID = userInfo().username ?? "default";
const TEMP_ROOT = join(tmpdir(), `pi-subagent-${SCOPE_ID}`);
const ASYNC_RUNS_DIR = join(TEMP_ROOT, "async-runs");

export function getAsyncRunDir(runId: string): string {
  return join(ASYNC_RUNS_DIR, runId);
}

// ── Tracker state ────────────────────────────────────────────────────

const jobs = new Map<string, AsyncJobState>();
const cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
let poller: ReturnType<typeof setInterval> | null = null;
let lastUiContext: ExtensionContext | null = null;
let config: AsyncTrackerConfig = {
  pollIntervalMs: 250,
  completionRetentionMs: 10000,
};

type OnChangeCallback = () => void;
let onChange: OnChangeCallback | null = null;

// ── Public API ───────────────────────────────────────────────────────

export function configure(cfg: Partial<AsyncTrackerConfig>): void {
  if (cfg.pollIntervalMs !== undefined)
    config.pollIntervalMs = cfg.pollIntervalMs;
  if (cfg.completionRetentionMs !== undefined)
    config.completionRetentionMs = cfg.completionRetentionMs;
}

export function setOnChange(cb: OnChangeCallback | null): void {
  onChange = cb;
}

/** Register a newly spawned background job. Starts the poller if needed. */
export function registerJob(
  id: string,
  agent: string,
  task: string,
  pid: number,
  sessionFile: string,
): void {
  const now = Date.now();
  jobs.set(id, {
    id,
    asyncDir: getAsyncRunDir(id),
    status: "queued",
    pid,
    agent,
    task: task.slice(0, 200),
    sessionFile,
    startedAt: now,
    updatedAt: now,
    turnCount: 0,
    toolCount: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: 0,
    durationMs: 0,
  });

  ensurePoller();
  onChange?.();
}

/** Get a specific job by ID. */
export function getJob(id: string): AsyncJobState | undefined {
  return jobs.get(id);
}

/** Get all active/completed jobs (within retention window). */
export function listJobs(): AsyncJobState[] {
  return [...jobs.values()];
}

/** Cancel a running job (marks as cancelled; killing is the caller's responsibility). */
export function cancelJob(id: string): void {
  const job = jobs.get(id);
  if (!job) return;
  job.status = "cancelled";
  job.updatedAt = Date.now();
  scheduleCleanup(id);
  onChange?.();
}

/** Remove a job from tracking immediately. */
export function removeJob(id: string): void {
  cancelCleanup(id);
  const job = jobs.get(id);
  if (job) {
    job.status = "cancelled";
    job.updatedAt = Date.now();
  }
  scheduleCleanup(id);
}

/** Clear all in-memory jobs (on session restart). */
export function clearAll(): void {
  for (const timer of cleanupTimers.values()) clearTimeout(timer);
  cleanupTimers.clear();
  jobs.clear();
  if (poller) {
    clearInterval(poller);
    poller = null;
  }
  onChange?.();
}

/** Set the last known UI context (for widget refreshing). */
export function setUiContext(ctx: ExtensionContext | null): void {
  lastUiContext = ctx;
}

/** Get the total count of active (non-completed) jobs. */
export function activeJobCount(): number {
  let count = 0;
  for (const job of jobs.values()) {
    if (job.status === "queued" || job.status === "running") count++;
  }
  return count;
}

// ── Poller ───────────────────────────────────────────────────────────

function scheduleCleanup(id: string): void {
  cancelCleanup(id);
  const timer = setTimeout(() => {
    cleanupTimers.delete(id);
    jobs.delete(id);
    onChange?.();
    // Auto-stop poller if no jobs remain
    if (jobs.size === 0 && poller) {
      clearInterval(poller);
      poller = null;
    }
  }, config.completionRetentionMs);
  cleanupTimers.set(id, timer);
}

function cancelCleanup(id: string): void {
  const timer = cleanupTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    cleanupTimers.delete(id);
  }
}

function ensurePoller(): void {
  if (poller) return;

  poller = setInterval(() => {
    if (jobs.size === 0) {
      if (poller) {
        clearInterval(poller);
        poller = null;
      }
      return;
    }

    let changed = false;

    for (const job of jobs.values()) {
      // Only poll jobs that are queued or running
      if (job.status !== "queued" && job.status !== "running") continue;

      const statusPath = join(job.asyncDir, "status.json");
      if (!existsSync(statusPath)) {
        // Job hasn't written status yet (still starting up)
        if (job.status === "queued") {
          job.status = "running";
          job.updatedAt = Date.now();
          changed = true;
        }
        continue;
      }

      try {
        const raw = readFileSync(statusPath, "utf8");
        const snap: StatusSnapshot = JSON.parse(raw);

        const previousStatus = job.status;

        // Update from snapshot
        if (snap.state === "running" && job.status === "queued") {
          job.status = "running";
        }
        job.pid = snap.pid ?? job.pid;
        job.agent = snap.agent ?? job.agent;
        job.turnCount = snap.turnCount ?? job.turnCount;
        job.toolCount = snap.toolCount ?? job.toolCount;
        job.currentTool = snap.currentTool;
        job.currentPath = snap.currentPath;
        job.input = snap.input ?? job.input;
        job.output = snap.output ?? job.output;
        job.cacheRead = snap.cacheRead ?? job.cacheRead;
        job.cacheWrite = snap.cacheWrite ?? job.cacheWrite;
        job.totalTokens = snap.totalTokens ?? job.totalTokens;
        job.cost = snap.cost ?? job.cost;
        job.durationMs = snap.durationMs ?? job.durationMs;
        job.sessionFile = snap.sessionFile ?? job.sessionFile;
        job.updatedAt = snap.lastActivityAt ?? job.updatedAt;

        if (snap.state === "complete") job.status = "complete";
        else if (snap.state === "failed") {
          job.status = "failed";
          job.error = snap.error ?? job.error;
        }

        // Schedule cleanup on terminal state
        if (
          (job.status === "complete" || job.status === "failed") &&
          (previousStatus as string) !== job.status
        ) {
          scheduleCleanup(job.id);
        }

        changed = true;
      } catch {
        // Failed to parse status — job may still be writing, retry next poll
      }
    }

    if (changed) onChange?.();
  }, config.pollIntervalMs);

  // Don't let the poller keep the process alive
  poller.unref?.();
}

// ── Session recovery ─────────────────────────────────────────────────

/**
 * Scan the async-runs directory for existing jobs (on /reload or session_start).
 * Recovers any running or recently completed jobs.
 */
export function recoverJobs(): void {
  if (!existsSync(ASYNC_RUNS_DIR)) return;
  const entries = readdirSync(ASYNC_RUNS_DIR, { withFileTypes: true });
  const now = Date.now();

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Skip if already tracked
    if (jobs.has(entry.name)) continue;

    const statusPath = join(ASYNC_RUNS_DIR, entry.name, "status.json");
    if (!existsSync(statusPath)) continue;

    try {
      const raw = readFileSync(statusPath, "utf8");
      const snap: StatusSnapshot = JSON.parse(raw);

      jobs.set(entry.name, {
        id: entry.name,
        asyncDir: join(ASYNC_RUNS_DIR, entry.name),
        status:
          snap.state === "complete"
            ? "complete"
            : snap.state === "failed"
              ? "failed"
              : "running",
        pid: snap.pid,
        agent: snap.agent ?? "unknown",
        task: snap.task ?? "",
        sessionFile: snap.sessionFile ?? "",
        startedAt: snap.startedAt ?? now,
        updatedAt: now,
        turnCount: snap.turnCount ?? 0,
        toolCount: snap.toolCount ?? 0,
        currentTool: snap.currentTool,
        currentPath: snap.currentPath,
        input: snap.input ?? 0,
        output: snap.output ?? 0,
        cacheRead: snap.cacheRead ?? 0,
        cacheWrite: snap.cacheWrite ?? 0,
        totalTokens: snap.totalTokens ?? 0,
        cost: snap.cost ?? 0,
        durationMs: snap.durationMs ?? 0,
        error: snap.error,
      });

      // Schedule cleanup for terminal jobs
      if (snap.state === "complete" || snap.state === "failed") {
        scheduleCleanup(entry.name);
      }
    } catch {
      // Corrupt status file — skip
    }
  }

  if (jobs.size > 0) ensurePoller();
  onChange?.();
}
