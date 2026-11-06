import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Runtime } from "../runtime.ts";
import {
  buildCompactionProjection,
  renderSummary,
  type Entry,
} from "../ledger/index.ts";

export function registerCompactionHook(
  pi: ExtensionAPI,
  runtime: Runtime,
): void {
  pi.on("session_before_compact", async (event: any, ctx: any) => {
    if (runtime.compactHookInFlight) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          "pi-om: another compaction is already in progress; cancelling duplicate",
          "warning",
        );
      }
      return { cancel: true };
    }

    runtime.compactHookInFlight = true;
    try {
      await runtime.ensureConfig(ctx.cwd);
      const { preparation, branchEntries } = event;
      const { firstKeptEntryId, tokensBefore } = preparation;
      const projection = buildCompactionProjection(
        branchEntries as Entry[],
        firstKeptEntryId,
      );
      const summary = renderSummary(
        projection.reflections,
        projection.observations,
      );

      return {
        compaction: {
          summary,
          firstKeptEntryId,
          tokensBefore,
          details: projection.details,
        },
      };
    } finally {
      runtime.compactHookInFlight = false;
    }
  });
}
