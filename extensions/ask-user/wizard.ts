/**
 * ask-user extension — the interactive questionnaire wizard.
 *
 * The form's flat question list is paginated 1:1: each blocking
 * ctx.ui.custom() screen renders one question. Choice questions
 * (single/multi) also carry a free-text remarks editor. The shared
 * WizardState survives close/reopen cycles, so an interrupt decision
 * ("keep answering") can reopen the wizard exactly where it was.
 *
 * Keys:
 *   ↑/↓       move the option cursor (↓ past the last option opens remarks)
 *   ←/→       previous/next page
 *   Enter     select (single) / toggle (multi) / open editor (text)
 *   Tab       next page; Tab on the last page submits
 *   Shift+Tab previous page
 *   r         open the remarks editor (choice questions)
 *   Esc       editor open: close it without saving; otherwise: interrupt (Resume later / Discard)
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  type EditorTheme,
  Key,
  matchesKey,
  type TUI,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type {
  AnswerValue,
  NormalizedQuestion,
  QuestionnaireForm,
} from "./types.ts";
import { isAnswered } from "./types.ts";

export interface WizardState {
  form: QuestionnaireForm;
  answers: Map<string, AnswerValue>;
  /** Free-text remarks keyed by question id (choice questions). */
  remarks: Map<string, string>;
  /** Index of the page — one page per question. */
  page: number;
  /** Option cursor within the current single/multi question. */
  cursor: number;
  /** Which part of the current page has editor focus. */
  focus: "options" | "remarks";
  /** Whether the inline editor is open (text answer or remarks). */
  editing: boolean;
  /** Transient submit-validation message; cleared on next navigation. */
  warning: string | null;
}

export type WizardOutcome = {
  status: "completed" | "interrupted" | "discarded";
  answers: Map<string, AnswerValue>;
};

function currentQuestion(state: WizardState): NormalizedQuestion | undefined {
  return state.form.questions[state.page];
}

function resetCursor(state: WizardState): void {
  state.cursor = 0;
  state.focus = "options";
  state.editing = false;
}

/** Position the wizard at the first unanswered question (or the last page if all are answered). */
export function positionAtFirstUnanswered(state: WizardState): void {
  for (const [index, question] of state.form.questions.entries()) {
    if (!isAnswered(question, state.answers)) {
      state.page = index;
      resetCursor(state);
      return;
    }
  }
  state.page = state.form.questions.length - 1;
  resetCursor(state);
}

function missingRequired(state: WizardState): NormalizedQuestion[] {
  return state.form.questions.filter(
    (question) => question.required && !isAnswered(question, state.answers),
  );
}

function trySubmit(
  state: WizardState,
  done: (result: { kind: "completed" }) => void,
): void {
  const missing = missingRequired(state);
  if (missing.length > 0) {
    state.warning = `Required: ${missing.map((q) => q.prompt).join(" • ")}`;
    state.page = Math.max(
      0,
      state.form.questions.findIndex((q) => q.id === missing[0].id),
    );
    resetCursor(state);
    return;
  }
  done({ kind: "completed" });
}

function advance(
  state: WizardState,
  done: (result: { kind: "completed" }) => void,
): void {
  if (state.page < state.form.questions.length - 1) {
    state.page++;
    resetCursor(state);
  } else {
    trySubmit(state, done);
  }
}

function retreat(state: WizardState): void {
  if (state.page > 0) {
    state.page--;
    resetCursor(state);
  }
}

function answerPreview(
  state: WizardState,
  question: NormalizedQuestion,
): string | null {
  const value = state.answers.get(question.id);
  if (value === undefined) return null;
  if (question.type === "single") {
    const option = question.options.find((o) => o.value === value);
    return option?.label ?? String(value);
  }
  if (Array.isArray(value)) {
    return value
      .map((v) => question.options.find((o) => o.value === v)?.label ?? v)
      .join(", ");
  }
  return value;
}

// ─── The blocking wizard loop ───────────────────────────────────────────────

/**
 * Run the wizard until the user completes, interrupts, or discards it.
 * An interrupt first offers "Resume later / Discard"; cancelling that choice
 * reopens the wizard with all state intact.
 */
export async function runWizard(
  ctx: ExtensionContext,
  state: WizardState,
): Promise<WizardOutcome> {
  for (;;) {
    const result = await ctx.ui.custom<{ kind: "completed" | "interrupted" }>(
      (tui, theme, _keybindings, done) =>
        createWizardComponent(tui, theme, state, done),
    );
    if (result?.kind === "completed") {
      return { status: "completed", answers: state.answers };
    }
    const choice = await ctx.ui.select(`Interrupt "${state.form.title}"`, [
      "Resume later",
      "Discard",
    ]);
    if (choice === undefined) {
      continue; // Keep answering: reopen with state intact.
    }
    return {
      status: choice === "Discard" ? "discarded" : "interrupted",
      answers: state.answers,
    };
  }
}

// ─── TUI component ──────────────────────────────────────────────────────────

function createWizardComponent(
  tui: TUI,
  theme: Theme,
  state: WizardState,
  done: (result: { kind: "completed" | "interrupted" }) => void,
) {
  let cachedLines: string[] | undefined;

  const editorTheme: EditorTheme = {
    borderColor: (s) => theme.fg("accent", s),
    selectList: {
      selectedPrefix: (t) => theme.fg("accent", t),
      selectedText: (t) => theme.fg("accent", t),
      description: (t) => theme.fg("muted", t),
      scrollInfo: (t) => theme.fg("dim", t),
      noMatch: (t) => theme.fg("warning", t),
    },
  };
  const editor = new Editor(tui, editorTheme);

  function refresh(): void {
    cachedLines = undefined;
    tui.requestRender();
  }

  editor.onSubmit = (value: string) => {
    const question = currentQuestion(state);
    if (!question) return;
    const trimmed = value.trim();
    editor.setText("");
    state.editing = false;
    state.focus = "options";
    if (question.type === "text") {
      if (trimmed) {
        state.answers.set(question.id, trimmed);
      }
      if (trimmed) {
        advance(state, done);
      }
    } else {
      // Remarks editor: an empty remark clears it.
      if (trimmed) state.remarks.set(question.id, trimmed);
      else state.remarks.delete(question.id);
    }
    refresh();
  };

  function openAnswerEditor(question: NormalizedQuestion): void {
    const existing = state.answers.get(question.id);
    editor.setText(
      typeof existing === "string" && !Array.isArray(existing) ? existing : "",
    );
    state.editing = true;
    refresh();
  }

  function openRemarksEditor(question: NormalizedQuestion): void {
    editor.setText(state.remarks.get(question.id) ?? "");
    state.editing = true;
    state.focus = "remarks";
    refresh();
  }

  function activate(question: NormalizedQuestion): void {
    if (question.type === "text") {
      openAnswerEditor(question);
      return;
    }
    const option = question.options[state.cursor];
    if (!option) return;
    if (question.type === "single") {
      // No auto-advance: the user may still want to add remarks.
      state.answers.set(question.id, option.value);
    } else {
      const current = state.answers.get(question.id);
      const values = Array.isArray(current) ? [...current] : [];
      const at = values.indexOf(option.value);
      if (at >= 0) values.splice(at, 1);
      else values.push(option.value);
      if (values.length === 0) state.answers.delete(question.id);
      else state.answers.set(question.id, values);
    }
    refresh();
  }

  function handleInput(data: string): void {
    if (state.editing) {
      if (matchesKey(data, Key.escape)) {
        editor.setText("");
        state.editing = false;
        state.focus = "options";
        refresh();
        return;
      }
      editor.handleInput(data);
      refresh();
      return;
    }

    const question = currentQuestion(state);
    if (!question) return;
    const options = question.options.length;

    if (matchesKey(data, Key.tab)) {
      state.warning = null;
      advance(state, done);
      refresh();
      return;
    }
    if (matchesKey(data, Key.shift("tab"))) {
      state.warning = null;
      retreat(state);
      refresh();
      return;
    }
    if (matchesKey(data, Key.right)) {
      state.warning = null;
      if (state.page < state.form.questions.length - 1) {
        state.page++;
        resetCursor(state);
      }
      refresh();
      return;
    }
    if (matchesKey(data, Key.left)) {
      state.warning = null;
      if (state.page > 0) {
        state.page--;
        resetCursor(state);
      }
      refresh();
      return;
    }
    if (matchesKey(data, Key.up)) {
      state.warning = null;
      if (state.cursor > 0) state.cursor--;
      refresh();
      return;
    }
    if (matchesKey(data, Key.down)) {
      state.warning = null;
      if (question.type !== "text") {
        if (state.cursor < options - 1) state.cursor++;
        else openRemarksEditor(question);
      }
      refresh();
      return;
    }
    if (question.type !== "text" && matchesKey(data, "r")) {
      state.warning = null;
      openRemarksEditor(question);
      return;
    }
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
      state.warning = null;
      activate(question);
      return;
    }
    if (matchesKey(data, Key.escape)) {
      done({ kind: "interrupted" });
    }
  }

  function render(width: number): string[] {
    if (cachedLines) return cachedLines;

    const renderWidth = Math.max(1, width);
    const lines: string[] = [];
    const form = state.form;
    const question = currentQuestion(state);
    if (!question) return lines;

    function addWrapped(text: string): void {
      lines.push(...wrapTextWithAnsi(text, renderWidth));
    }

    function addWrappedWithPrefix(prefix: string, text: string): void {
      const prefixWidth = visibleWidth(prefix);
      if (prefixWidth >= renderWidth) {
        addWrapped(prefix + text);
        return;
      }
      const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
      const continuation = " ".repeat(prefixWidth);
      for (let i = 0; i < wrapped.length; i++) {
        lines.push(`${i === 0 ? prefix : continuation}${wrapped[i]}`);
      }
    }

    lines.push(theme.fg("accent", "─".repeat(renderWidth)));
    addWrappedWithPrefix(" ", theme.fg("accent", theme.bold(form.title)));

    const pageLabel = `Question ${state.page + 1}/${form.questions.length}`;
    const dots = form.questions
      .map((q, i) => {
        const done_ = isAnswered(q, state.answers);
        const active = i === state.page;
        const dot = done_ ? "●" : "○";
        return active
          ? theme.fg("accent", theme.bold(dot))
          : theme.fg("muted", dot);
      })
      .join(" ");
    addWrappedWithPrefix(" ", `${theme.fg("muted", pageLabel)}   ${dots}`);

    if (state.warning) {
      addWrappedWithPrefix(" ", theme.fg("warning", `⚠ ${state.warning}`));
    }
    lines.push("");

    const answered = isAnswered(question, state.answers);
    const marker =
      question.required && !answered ? theme.fg("warning", " *") : "";
    const promptPrefix = state.editing ? "  " : theme.fg("accent", "> ");
    const promptColor = state.editing ? "text" : "accent";
    addWrappedWithPrefix(
      promptPrefix,
      theme.fg(
        promptColor,
        theme.bold(`${state.page + 1}. ${question.prompt}`),
      ) + marker,
    );
    lines.push("");

    if (question.type === "single" || question.type === "multi") {
      const cursorVisible = !state.editing;
      for (const [oi, option] of question.options.entries()) {
        const selected =
          question.type === "single"
            ? state.answers.get(question.id) === option.value
            : Array.isArray(state.answers.get(question.id)) &&
              (state.answers.get(question.id) as string[]).includes(
                option.value,
              );
        const onCursor = cursorVisible && oi === state.cursor;
        const prefix = onCursor ? theme.fg("accent", "> ") : "  ";
        const box =
          question.type === "single"
            ? selected
              ? "● "
              : "○ "
            : selected
              ? "[x] "
              : "[ ] ";
        const color = onCursor || selected ? "accent" : "text";
        addWrappedWithPrefix(prefix, theme.fg(color, `${box}${option.label}`));
        if (option.description) {
          addWrappedWithPrefix("     ", theme.fg("muted", option.description));
        }
      }
      lines.push("");
      if (state.editing && state.focus === "remarks") {
        for (const line of editor.render(Math.max(1, renderWidth - 6))) {
          lines.push(`     ${line}`);
        }
      } else {
        const remark = state.remarks.get(question.id);
        if (remark) {
          addWrappedWithPrefix(
            "  ",
            theme.fg("success", `✎ Remarks: ${remark.replace(/\n/g, " ⏎ ")}`),
          );
        } else {
          addWrappedWithPrefix(
            "  ",
            theme.fg("muted", "(r or ↓ to add remarks)"),
          );
        }
      }
    } else {
      const preview = answerPreview(state, question);
      if (preview !== null) {
        addWrappedWithPrefix("     ", theme.fg("success", `✓ ${preview}`));
      }
      if (state.editing) {
        for (const line of editor.render(Math.max(1, renderWidth - 6))) {
          lines.push(`     ${line}`);
        }
      } else {
        addWrappedWithPrefix(
          "     ",
          theme.fg(
            "muted",
            preview === null ? "(Enter to answer)" : "(Enter to revise)",
          ),
        );
      }
    }

    const pageAction =
      state.page < form.questions.length - 1 ? "Tab next page" : "Tab submit";
    const hints =
      question.type === "text"
        ? `Enter answer • ${pageAction} • Esc interrupt`
        : `↑↓ options • Enter ${question.type === "single" ? "select" : "toggle"} • r remarks • ${pageAction} • Esc interrupt`;
    addWrappedWithPrefix(" ", theme.fg("dim", hints));
    lines.push(theme.fg("accent", "─".repeat(renderWidth)));

    cachedLines = lines;
    return lines;
  }

  return {
    render,
    invalidate: () => {
      cachedLines = undefined;
    },
    handleInput,
  };
}
