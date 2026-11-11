/**
 * ask-user extension — domain types, tool schema, and form normalization.
 *
 * The agent composes a questionnaire at tool-call time; the extension owns
 * everything interactive: the wizard UI, interrupt persistence, and the
 * user-driven resume flow (/questionnaire).
 *
 * The schema is flat: a list of questions, one question per wizard page.
 * Choice questions (single/multi) automatically offer a free-text remarks
 * field, so the user can qualify any pick.
 */

import { type Static, Type } from "typebox";

// ─── Tool schema ───────────────────────────────────────────────────────────

const OptionSchema = Type.Object({
  value: Type.String({
    description:
      "Stable machine value returned to you when this option is chosen",
  }),
  label: Type.String({ description: "Human-readable text shown to the user" }),
  description: Type.Optional(
    Type.String({ description: "Optional helper text shown under the label" }),
  ),
});

const QuestionSchema = Type.Object({
  id: Type.String({
    description:
      "Unique id for this question within the questionnaire. Answers are keyed by this id, so keep it stable and descriptive (e.g. 'database_choice').",
  }),
  prompt: Type.String({ description: "The question text shown to the user" }),
  type: Type.Union(
    [Type.Literal("single"), Type.Literal("multi"), Type.Literal("text")],
    {
      description:
        "'single': pick one option. 'multi': pick any number of options (checkboxes). 'text': free-form answer. " +
        "Every 'single'/'multi' question also gets a free-text remarks field in the wizard.",
    },
  ),
  options: Type.Optional(
    Type.Array(OptionSchema, {
      description:
        "The choices for 'single' and 'multi' questions. Ignored for 'text'.",
    }),
  ),
  required: Type.Optional(
    Type.Boolean({
      description:
        "Whether the question must be answered before submitting. Non-empty remarks also satisfy a required question (no choice needed). Default: true.",
    }),
  ),
});

export const AskUserParams = Type.Object({
  title: Type.String({
    description: "Questionnaire title shown at the top of every page",
  }),
  questions: Type.Array(QuestionSchema, {
    description:
      "Questions in order, one per page. The user navigates between them with arrow keys and can revise earlier answers before submitting.",
  }),
});

export type AskUserParams = Static<typeof AskUserParams>;

// ─── Normalized domain types (what the wizard and the store work with) ─────

export type QuestionType = "single" | "multi" | "text";

/** Wizard-side answer values: single/text → string; multi → string[] of chosen option values. */
export type AnswerValue = string | string[];

export interface NormalizedOption {
  label: string;
  value: string;
  description?: string;
}

export interface NormalizedQuestion {
  id: string;
  prompt: string;
  type: QuestionType;
  options: NormalizedOption[];
  required: boolean;
}

export interface QuestionnaireForm {
  title: string;
  questions: NormalizedQuestion[];
}

/**
 * A question is answered when its value is non-empty (multi: at least one choice).
 * Remarks never count as answers — they only satisfy the required gate (see
 * wizard.ts), not progress dots or positioning.
 */
export function isAnsweredValue(value: AnswerValue | undefined): boolean {
  if (value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  return value.trim().length > 0;
}

export function isAnswered(
  question: NormalizedQuestion,
  answers: ReadonlyMap<string, AnswerValue>,
): boolean {
  return isAnsweredValue(answers.get(question.id));
}

// ─── Agent-facing answers ──────────────────────────────────────────────────

/** A single-select answer as reported to the agent, with the user's remarks inlined. */
export interface SingleAnswer {
  value: string;
  remarks?: string;
}

/** A multi-select answer as reported to the agent, with the user's remarks inlined. */
export interface MultiAnswer {
  values: string[];
  remarks?: string;
}

export type ReportedAnswer = string | SingleAnswer | MultiAnswer;

export function isSingleAnswer(value: ReportedAnswer): value is SingleAnswer {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "value" in value
  );
}

export function isMultiAnswer(value: ReportedAnswer): value is MultiAnswer {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "values" in value
  );
}

/**
 * Merge the wizard's answer and remarks maps into the agent-facing shape:
 * single → {value, remarks?}; multi → {values, remarks?}; text → string.
 */
export function reportedAnswers(
  form: QuestionnaireForm,
  answers: ReadonlyMap<string, AnswerValue>,
  remarks: ReadonlyMap<string, string>,
): Record<string, ReportedAnswer> {
  const out: Record<string, ReportedAnswer> = {};
  for (const question of form.questions) {
    const value = answers.get(question.id);
    const remark = remarks.get(question.id);
    if (question.type === "multi") {
      const values = Array.isArray(value) ? value : [];
      out[question.id] = remark ? { values, remarks: remark } : { values };
    } else if (question.type === "single") {
      if (value === undefined || Array.isArray(value)) continue;
      out[question.id] = remark ? { value, remarks: remark } : { value };
    } else {
      if (typeof value !== "string") continue;
      out[question.id] = value;
    }
  }
  return out;
}

// ─── Normalization / validation of agent-supplied params ────────────────────

export interface NormalizeResult {
  form?: QuestionnaireForm;
  error?: string;
}

/** Validate the raw tool params and produce the normalized form the rest of the code uses. */
export function normalizeForm(params: AskUserParams): NormalizeResult {
  if (!params.questions || params.questions.length === 0) {
    return { error: "A questionnaire needs at least one question." };
  }
  const seen = new Set<string>();
  const questions: NormalizedQuestion[] = [];
  for (const [index, question] of params.questions.entries()) {
    const id = question.id?.trim();
    if (!id)
      return {
        error: `Every question needs a non-empty id (question ${index + 1}).`,
      };
    if (seen.has(id))
      return {
        error: `Duplicate question id "${id}" — ids must be unique within the questionnaire.`,
      };
    seen.add(id);
    const prompt = question.prompt?.trim();
    if (!prompt) return { error: `Question "${id}" needs a prompt.` };
    if (
      question.type !== "text" &&
      (!question.options || question.options.length === 0)
    ) {
      return {
        error: `Question "${id}" is type "${question.type}" and needs at least one option.`,
      };
    }
    const options: NormalizedOption[] = [];
    for (const option of question.options ?? []) {
      if (!option.value?.trim())
        return { error: `Question "${id}" has an option without a value.` };
      if (!option.label?.trim())
        return { error: `Question "${id}" has an option without a label.` };
      options.push({
        label: option.label,
        value: option.value,
        description: option.description,
      });
    }
    questions.push({
      id,
      prompt,
      type: question.type,
      options,
      required: question.required !== false,
    });
  }
  return {
    form: { title: params.title?.trim() || "Questionnaire", questions },
  };
}
