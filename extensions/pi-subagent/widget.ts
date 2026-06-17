/**
 * widget.ts — Background agent TUI widget.
 *
 * Renders one line per active/completed background job above the editor.
 * Updated on every async-tracker onChange callback.
 */

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { listJobs, activeJobCount, type AsyncJobState } from "./async-tracker.ts";

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(0)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  return `${min}m${sec}s`;
}

function formatTokens(n: number): string {
  if (n === 0) return "0";
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

function statusIcon(status: AsyncJobState["status"]): string {
  switch (status) {
    case "queued": return "○";
    case "running": return "◉";
    case "complete": return "✓";
    case "failed": return "✗";
    case "cancelled": return "⊘";
  }
}

function renderJobLine(job: AsyncJobState): string {
  const icon = statusIcon(job.status);
  const elapsed = formatDuration(Date.now() - job.startedAt);
  const tokens = `↑${formatTokens(job.input)} ↓${formatTokens(job.output)}`;
  const details: string[] = [];

  if (job.turnCount > 0) details.push(`${job.turnCount}t`);
  if (job.toolCount > 0) details.push(`${job.toolCount} tools`);
  details.push(tokens);
  details.push(elapsed);

  const detailStr = details.join(" · ");

  let line = ` ${icon} ${job.agent} · ${detailStr}`;

  if (job.status === "running" && job.currentTool) {
    line += ` · ${job.currentTool}`;
    if (job.currentPath) {
      const shortPath = job.currentPath.length > 40
        ? "…" + job.currentPath.slice(-39)
        : job.currentPath;
      line += ` ${shortPath}`;
    }
  }

  if (job.status === "failed" && job.error) {
    line += ` · ${job.error.slice(0, 60)}`;
  }

  return line;
}

export function renderBackgroundWidget(ui: ExtensionUIContext): void {
  const jobs = listJobs();
  const active = activeJobCount();

  if (jobs.length === 0) {
    ui.setWidget("bg-jobs", undefined);
    return;
  }

  const header = `╭─ Background agents (${active} active) ───`;
  const lines = [header, ...jobs.map(renderJobLine)];

  ui.setWidget("bg-jobs", lines, { placement: "aboveEditor" });
}
