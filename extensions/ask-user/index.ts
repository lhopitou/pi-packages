/**
 * ask-user extension
 *
 * Tool `ask_user`: the agent composes a questionnaire (a flat list of
 * questions) and the user answers it in a blocking wizard inside the TUI —
 * one question per page, with single-select, multi-select, and free-text
 * questions. Choice questions also offer a free-text remarks field.
 * Completion returns the answers to the agent.
 *
 * Interrupting the wizard (Esc) saves the form, answers, and remarks under
 * <agent dir>/questionnaires/<guid>.json and aborts the agent loop like a
 * regular cancelled tool call. Command `/questionnaire` lists pending forms so
 * the user can resume (answers are then delivered as a user message that
 * triggers a new agent run) or discard them. `/questionnaire discard` deletes
 * a saved form directly.
 *
 * Interactive TUI only: in headless modes (RPC, print, delegated children)
 * the tool fails with guidance so the agent asks in plain text instead.
 */

import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  deleteQuestionnaire,
  listQuestionnaires,
  progressOf,
  type StoredQuestionnaire,
  saveQuestionnaire,
} from "./store.ts";
import {
  AskUserParams,
  type AnswerValue,
  type NormalizedQuestion,
  type QuestionnaireForm,
  type ReportedAnswer,
  isAnsweredValue,
  isMultiAnswer,
  normalizeForm,
  reportedAnswers,
} from "./types.ts";
import {
  positionAtFirstUnanswered,
  runWizard,
  type WizardState,
} from "./wizard.ts";

export const TOOL_NAME = "ask_user";

interface AskUserDetails {
  status: "completed" | "interrupted" | "discarded";
  title: string;
  answers: Record<string, ReportedAnswer>;
  /** File the interrupted questionnaire was saved to. */
  savedFile?: string;
}

function errorResult(message: string): {
  content: { type: "text"; text: string }[];
  details: AskUserDetails;
} {
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    details: { status: "discarded", title: "", answers: {} },
  };
}

/** Markdown summary of the form as answered — shared by the tool result and the resume user message. */
export function renderSummary(
  form: QuestionnaireForm,
  answers: ReadonlyMap<string, AnswerValue>,
  remarks: ReadonlyMap<string, string>,
): string {
  const lines: string[] = [];
  for (const question of form.questions) {
    const value = answers.get(question.id);
    const answer =
      value === undefined || !isAnsweredValue(value)
        ? "_(skipped)_"
        : formatAnswer(question, value);
    lines.push(`- **${question.prompt}**: ${answer}`);
    const remark = remarks.get(question.id);
    if (remark) {
      lines.push(`  - Remarks: ${quoteInline(remark)}`);
    }
  }
  return lines.join("\n");
}

function quoteInline(text: string): string {
  return `"${text.replace(/\n/g, " ⏎ ")}"`;
}

function formatAnswer(
  question: NormalizedQuestion,
  value: AnswerValue,
): string {
  if (question.type === "single") {
    const option = question.options.find((o) => o.value === value);
    return option?.label ?? String(value);
  }
  if (Array.isArray(value)) {
    return value
      .map((v) => question.options.find((o) => o.value === v)?.label ?? v)
      .join(", ");
  }
  return quoteInline(value);
}

function answersObject(
  answers: ReadonlyMap<string, AnswerValue>,
): Record<string, AnswerValue> {
  return Object.fromEntries(answers.entries());
}

function remarksObject(
  remarks: ReadonlyMap<string, string>,
): Record<string, string> {
  return Object.fromEntries(remarks.entries());
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function stateFromStored(stored: StoredQuestionnaire): WizardState {
  const state: WizardState = {
    form: stored.form,
    answers: new Map(Object.entries(stored.answers ?? {})),
    remarks: new Map(Object.entries(stored.remarks ?? {})),
    page: 0,
    cursor: 0,
    focus: "options",
    editing: false,
    warning: null,
  };
  positionAtFirstUnanswered(state);
  return state;
}

export default function askUserExtension(pi: ExtensionAPI): void {
  pi.registerTool<typeof AskUserParams, AskUserDetails>({
    name: TOOL_NAME,
    label: "Ask user",
    description:
      "Ask the user questions through an interactive questionnaire (blocking full-screen wizard in the terminal, one question per page). " +
      "Supports single-select, multi-select (checkbox), and free-text questions; every choice question also gets a free-text remarks field. " +
      "Blocks the current run until the user submits or interrupts. On completion you receive the answers keyed by question id " +
      "(choice answers include their remarks). " +
      "If the user interrupts, progress is saved to disk, the agent loop aborts, and the user resumes later via /questionnaire — the answers then arrive as a user message. " +
      "Use for structured clarification mid-task (requirements, preferences, decisions) when several questions at once would be tedious in plain text. " +
      "Requires an interactive terminal: in headless, piped, or delegated contexts the tool fails — ask in plain text instead.",
    promptSnippet:
      "Interactive questionnaires (single/multi/text, one question per page) for structured clarification; blocks on the user.",
    parameters: AskUserParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (ctx.mode !== "tui") {
        return errorResult(
          "ask_user needs an interactive terminal UI and none is available in this mode. " +
            "Ask the user your questions in plain text instead.",
        );
      }
      const normalized = normalizeForm(params);
      if (normalized.error || !normalized.form) {
        return errorResult(normalized.error ?? "Invalid questionnaire.");
      }
      const form = normalized.form;

      const state: WizardState = {
        form,
        answers: new Map(),
        remarks: new Map(),
        page: 0,
        cursor: 0,
        focus: "options",
        editing: false,
        warning: null,
      };
      const outcome = await runWizard(ctx, state);

      if (outcome.status === "completed") {
        const summary = renderSummary(form, state.answers, state.remarks);
        return {
          content: [
            { type: "text", text: `Questionnaire completed.\n\n${summary}` },
          ],
          details: {
            status: "completed",
            title: form.title,
            answers: reportedAnswers(form, state.answers, state.remarks),
          },
        };
      }
      if (outcome.status === "interrupted") {
        const guid = randomUUID();
        const savedFile = saveQuestionnaire({
          version: 2,
          guid,
          title: form.title,
          createdAt: new Date().toISOString(),
          cwd: ctx.cwd,
          form,
          answers: answersObject(state.answers),
          remarks: remarksObject(state.remarks),
        });
        ctx.ui.notify(
          "Questionnaire saved — resume later with /questionnaire",
          "info",
        );
        ctx.abort();
        return {
          content: [
            {
              type: "text",
              text: `The user interrupted the questionnaire. Progress was saved (${savedFile}) and the user can resume it with /questionnaire; the answers will then arrive as a user message.`,
            },
          ],
          details: {
            status: "interrupted",
            title: form.title,
            answers: reportedAnswers(form, state.answers, state.remarks),
            savedFile,
          },
        };
      }
      ctx.abort();
      return {
        content: [
          { type: "text", text: "The user discarded the questionnaire." },
        ],
        details: { status: "discarded", title: form.title, answers: {} },
      };
    },

    renderCall(args, theme, _context) {
      const questions = args.questions ?? [];
      let text = theme.fg("toolTitle", theme.bold(`${TOOL_NAME} `));
      text += theme.fg("muted", `"${args.title ?? ""}" `);
      text += theme.fg(
        "dim",
        `${questions.length} question${questions.length !== 1 ? "s" : ""}`,
      );
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme, _context) {
      const details = result.details as AskUserDetails | undefined;
      if (!details) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "", 0, 0);
      }
      if (details.status === "interrupted") {
        return new Text(
          theme.fg(
            "warning",
            "Interrupted — saved, resume with /questionnaire",
          ),
          0,
          0,
        );
      }
      if (details.status === "discarded") {
        return new Text(theme.fg("warning", "Discarded"), 0, 0);
      }
      const lines = Object.entries(details.answers).map(([id, value]) => {
        let shown: string;
        if (typeof value === "string") {
          shown = value;
        } else if (isMultiAnswer(value)) {
          shown = value.values.join(", ");
        } else {
          shown = value.value;
        }
        const remark =
          typeof value !== "string" && value.remarks
            ? theme.fg("muted", ` (+ remarks)`)
            : "";
        return `${theme.fg("success", "✓ ")}${theme.fg("accent", id)}: ${shown}${remark}`;
      });
      return new Text(lines.join("\n"), 0, 0);
    },
  });

  pi.registerCommand("questionnaire", {
    description:
      "Resume a pending questionnaire, or discard one (/questionnaire discard)",
    handler: async (args, ctx) => {
      const stored = listQuestionnaires();
      if (stored.length === 0) {
        ctx.ui.notify("No pending questionnaires", "info");
        return;
      }
      const discarding = args.trim().toLowerCase() === "discard";
      const labels = stored.map(
        (s) =>
          `${s.title} — ${progressOf(s)} answered — ${shortDate(s.createdAt)} — ${s.cwd}`,
      );
      const pick = await ctx.ui.select(
        discarding ? "Discard questionnaire:" : "Resume questionnaire:",
        labels,
      );
      if (pick === undefined) return;
      const chosen = stored[labels.indexOf(pick)];
      if (!chosen) return;

      if (discarding) {
        const ok = await ctx.ui.confirm(
          `Discard "${chosen.title}"?`,
          "The saved answers will be deleted",
        );
        if (ok) {
          deleteQuestionnaire(chosen.guid);
          ctx.ui.notify(`Discarded "${chosen.title}"`, "info");
        }
        return;
      }

      const state = stateFromStored(chosen);
      const outcome = await runWizard(ctx, state);

      if (outcome.status === "completed") {
        deleteQuestionnaire(chosen.guid);
        const summary = renderSummary(state.form, state.answers, state.remarks);
        pi.sendUserMessage(
          `Completed questionnaire "${chosen.title}" (resumed from ${shortDate(chosen.createdAt)}, originally started in \`${chosen.cwd}\`):\n\n${summary}`,
        );
      } else if (outcome.status === "interrupted") {
        saveQuestionnaire({
          ...chosen,
          answers: answersObject(state.answers),
          remarks: remarksObject(state.remarks),
        });
        ctx.ui.notify(
          "Progress saved — resume later with /questionnaire",
          "info",
        );
      } else {
        deleteQuestionnaire(chosen.guid);
        ctx.ui.notify(`Discarded "${chosen.title}"`, "info");
      }
    },
  });
}
