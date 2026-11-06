import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { rawTokensSinceLastCompaction, type Entry } from "../ledger/index.ts";
import type { Runtime } from "../runtime.ts";

const RETRYABLE_ERROR_RE =
  /overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i;

export function registerCompactionTrigger(
  pi: ExtensionAPI,
  runtime: Runtime,
): void {
  pi.on("agent_end", async (event: any, ctx: any) => {
    await runtime.ensureConfig(ctx.cwd);
    if (runtime.config.passive === true) return;
    if (runtime.compactInFlight) return;

    const lastAssistant = [...event.messages]
      .reverse()
      .find(
        (m): m is Extract<typeof m, { role: "assistant" }> =>
          m.role === "assistant",
      );
    if (
      lastAssistant &&
      lastAssistant.stopReason === "error" &&
      lastAssistant.errorMessage &&
      RETRYABLE_ERROR_RE.test(lastAssistant.errorMessage)
    ) {
      return;
    }

    const entries = ctx.sessionManager.getBranch() as Entry[];
    const tokens = rawTokensSinceLastCompaction(entries);
    if (tokens < runtime.config.compactAfterTokens) return;

    // Snapshot all ctx methods before the setTimeout to avoid stale closures.
    const hasUI = ctx.hasUI;
    const ui = ctx.ui;
    const isIdle = ctx.isIdle;
    const getBranch = ctx.sessionManager.getBranch.bind(ctx.sessionManager);
    const compact = ctx.compact.bind(ctx);

    if (hasUI)
      ui?.notify(
        `pi-om: compaction threshold reached (~${tokens.toLocaleString()} tokens); triggering compaction`,
        "info",
      );

    runtime.compactInFlight = true;
    setTimeout(() => {
      try {
        if (!isIdle()) {
          runtime.compactInFlight = false;
          if (hasUI)
            ui?.notify(
              "pi-om: compaction deferred — agent became busy before compaction",
              "info",
            );
          return;
        }
        const currentEntries = getBranch() as Entry[];
        const currentTokens = rawTokensSinceLastCompaction(currentEntries);
        if (currentTokens < runtime.config.compactAfterTokens) {
          runtime.compactInFlight = false;
          return;
        }
        compact({
          onComplete: () => {
            runtime.compactInFlight = false;
            if (hasUI) ui?.notify("pi-om: compaction complete", "info");
          },
          onError: (error: { message: string }) => {
            runtime.compactInFlight = false;
            if (error.message === "Compaction cancelled") return;
            if (hasUI) ui?.notify(`pi-om: ${error.message}`, "error");
          },
        });
      } catch (error) {
        runtime.compactInFlight = false;
        const msg = error instanceof Error ? error.message : String(error);
        if (hasUI) ui?.notify(`pi-om: compact threw: ${msg}`, "error");
      }
    }, 0);
  });
}
