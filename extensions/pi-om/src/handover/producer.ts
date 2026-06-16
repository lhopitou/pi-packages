/**
 * Handover producer: spawns a pi subprocess in JSON mode to produce
 * a structured handoff document from the rendered summary.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const HANDOVER_PRODUCER_SYSTEM = `You are a handover document producer for a coding assistant's memory system.

You receive a rendered memory summary containing reflections and observations from the current session phase. Your job is to produce a structured handover document that a fresh session can use to continue work effectively.

Read the summary carefully. You may read files referenced in the observations to verify paths and details.

Auto-assign a phase label from: exploration, planning, implementation, testing.

Produce the handover document in this EXACT markdown format:

# Handover: [phase label]

## Phase Summary
[1-3 paragraphs: what was accomplished, current state, any blockers]

## Key Decisions
- [Decision]: [rationale]

## Observations
[Filtered and re-prioritized observations relevant to the next phase. Distill aggressively — much shorter than full rendered summary. Only include what the next phase needs to know.]

## Durable Artifacts
- \`path/to/file\` — description

## Next Phase
Suggested scope: [label]
[Specific next steps or open questions]

## Not Carried Forward
[What was explored and abandoned. Dead ends, rejected approaches.]

Rules:
- Be concise. The next session starts fresh with only this document.
- Distill observations aggressively. Drop routine tool outputs, transient debugging, and anything trivially re-derivable.
- Preserve user preferences, constraints, corrections, and completed outcomes.
- Preserve architectural decisions and rationale.
- Include file paths for artifacts that actually exist on disk.
- The "Not Carried Forward" section is important — it prevents the next session from retracing dead ends.
- Output ONLY the markdown document, nothing else.`;

async function writePromptToTempFile(prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-om-handover-"));
	const filePath = path.join(tmpDir, "prompt.md");
	await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

export interface ProduceHandoverResult {
	document: string;
	success: boolean;
	error?: string;
}

export async function produceHandover(
	summary: string,
	cwd: string,
	signal?: AbortSignal,
): Promise<ProduceHandoverResult> {
	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	try {
		const tmp = await writePromptToTempFile(HANDOVER_PRODUCER_SYSTEM);
		tmpPromptDir = tmp.dir;
		tmpPromptPath = tmp.filePath;

		const args: string[] = [
			"--mode", "json",
			"-p",
			"--no-session",
			"--append-system-prompt", tmpPromptPath,
			`Produce a handover document from the following session memory summary. Auto-assign a phase label.\n\n${summary}`,
		];

		let wasAborted = false;
		let output = "";
		let lastAssistantText = "";

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});

			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message;
					if (msg.role === "assistant") {
						for (const part of msg.content) {
							if (part.type === "text") {
								lastAssistantText = part.text;
							}
						}
					}
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				output += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		if (wasAborted) {
			return { document: "", success: false, error: "Handover producer was aborted" };
		}

		if (exitCode !== 0) {
			return { document: "", success: false, error: `Handover producer exited with code ${exitCode}: ${output.slice(0, 500)}` };
		}

		if (!lastAssistantText.trim()) {
			return { document: "", success: false, error: "Handover producer returned empty output" };
		}

		return { document: lastAssistantText, success: true };
	} catch (error) {
		return { document: "", success: false, error: error instanceof Error ? error.message : String(error) };
	} finally {
		if (tmpPromptPath) try { fs.unlinkSync(tmpPromptPath); } catch { /* ignore */ }
		if (tmpPromptDir) try { fs.rmdirSync(tmpPromptDir); } catch { /* ignore */ }
	}
}
