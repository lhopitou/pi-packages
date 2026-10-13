import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Runtime } from "./src/runtime.ts";
import { registerConsolidationTrigger } from "./src/compaction/consolidation.ts";
import { registerCompactionTrigger } from "./src/compaction/trigger.ts";
import { registerCompactionHook } from "./src/compaction/hook.ts";
import { registerStatusCommand } from "./src/commands/status.ts";
import { registerViewCommand } from "./src/commands/view.ts";
import { registerConfigCommand } from "./src/commands/config.ts";
import { registerHandoverCommand } from "./src/handover/command.ts";
import { registerHandoverInjection } from "./src/handover/injection.ts";
import { registerHandoverSuggest } from "./src/handover/suggest.ts";

export default function piOm(pi: ExtensionAPI) {
	const runtime = new Runtime();

	// Within-phase foundation (from elpapi42 V3)
	registerConsolidationTrigger(pi, runtime);
	registerCompactionTrigger(pi, runtime);
	registerCompactionHook(pi, runtime);

	registerStatusCommand(pi, runtime);
	registerViewCommand(pi, runtime);
	pi.registerCommand("om:config", {
		description: "View and set pi-om settings",
		handler: registerConfigCommand(runtime),
	});

	// Phase boundary layer (new for pi-om)
	registerHandoverCommand(pi, runtime);
	registerHandoverInjection(pi);
	registerHandoverSuggest(pi, runtime);

	// Reset handover suggestion flag on new session
	pi.on("session_start", async () => {
		runtime.handoverSuggested = false;
	});
}
