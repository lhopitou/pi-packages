/**
 * ask-user extension — persistence of interrupted questionnaires.
 *
 * Files live in `<agent dir>/questionnaires/<guid>.json` where <agent dir> is
 * ~/.pi/agent by default and $PI_CODING_AGENT_DIR when set (getAgentDir()
 * resolves both). A file is written only when the user interrupts a wizard;
 * completing or discarding deletes it.
 *
 * Version 2 stores the flat form (question list) plus a separate remarks
 * map. Version 1 files (page-based forms) are migrated transparently on
 * load: pages are flattened in order, since the wizard now paginates one
 * question per page anyway.
 */

import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
  AnswerValue,
  NormalizedQuestion,
  QuestionnaireForm,
} from "./types.ts";
import { isAnsweredValue } from "./types.ts";

export interface StoredQuestionnaire {
  version: 2;
  /** GUID; also the file name stem. Generated at interrupt time. */
  guid: string;
  title: string;
  /** ISO timestamp of the interrupt that created the file. */
  createdAt: string;
  /** Working directory of the session that was interrupted. */
  cwd: string;
  /** Full normalized form (flat question list), so the wizard can reopen it verbatim. */
  form: QuestionnaireForm;
  /** Partial answers keyed by question id. */
  answers: Record<string, AnswerValue>;
  /** Free-text remarks keyed by question id (choice questions). */
  remarks: Record<string, string>;
}

export function questionnairesDir(): string {
  return join(getAgentDir(), "questionnaires");
}

export function saveQuestionnaire(stored: StoredQuestionnaire): string {
  const dir = questionnairesDir();
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${stored.guid}.json`);
  writeFileSync(file, JSON.stringify(stored, null, 2) + "\n", "utf-8");
  return file;
}

export function deleteQuestionnaire(guid: string): void {
  try {
    rmSync(join(questionnairesDir(), `${guid}.json`));
  } catch {
    // Already gone — nothing to do.
  }
}

interface StoredBasics {
  guid: string;
  title: string;
  createdAt: string;
  cwd: string;
  answers: Record<string, AnswerValue>;
}

/** Check the fields every stored version shares, narrowing them along the way. */
function hasStoredBasics(
  value: Record<string, unknown>,
): value is StoredBasics & Record<string, unknown> {
  return (
    typeof value.guid === "string" &&
    typeof value.title === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.cwd === "string" &&
    typeof value.answers === "object" &&
    value.answers !== null
  );
}

/** Flatten a version 1 (page-based) stored form into the version 2 flat form. */
function migrateV1(value: Record<string, unknown>): StoredQuestionnaire | null {
  const form = value.form as
    { title?: unknown; pages?: Array<{ questions?: unknown }> } | undefined;
  if (!form || !Array.isArray(form.pages)) return null;
  const questions = form.pages.flatMap((page): NormalizedQuestion[] =>
    Array.isArray(page.questions)
      ? (page.questions as NormalizedQuestion[])
      : [],
  );
  return {
    version: 2,
    guid: value.guid as string,
    title: value.title as string,
    createdAt: value.createdAt as string,
    cwd: value.cwd as string,
    form: {
      title:
        typeof form.title === "string" ? form.title : (value.title as string),
      questions,
    },
    answers: value.answers as Record<string, AnswerValue>,
    remarks: {},
  };
}

/** Parse and, if needed, migrate a stored questionnaire file's contents. */
export function parseStored(value: unknown): StoredQuestionnaire | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (!hasStoredBasics(v)) return null;
  if (v.version === 2) {
    const form = v.form as QuestionnaireForm | undefined;
    if (!form || !Array.isArray(form.questions)) return null;
    const remarks =
      typeof v.remarks === "object" && v.remarks !== null
        ? (v.remarks as Record<string, string>)
        : {};
    return {
      version: 2,
      guid: v.guid,
      title: v.title,
      createdAt: v.createdAt,
      cwd: v.cwd,
      form,
      answers: v.answers,
      remarks,
    };
  }
  if (v.version === 1) {
    return migrateV1(v);
  }
  return null;
}

/** All pending questionnaires, newest first. Corrupt files are skipped. */
export function listQuestionnaires(): StoredQuestionnaire[] {
  const dir = questionnairesDir();
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: StoredQuestionnaire[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed: unknown = JSON.parse(
        readFileSync(join(dir, name), "utf-8"),
      );
      const stored = parseStored(parsed);
      if (stored) out.push(stored);
    } catch {
      // Skip unreadable/corrupt files.
    }
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return out;
}

/** "3/5" — answered questions out of total. Remarks never count as answers. */
export function progressOf(stored: StoredQuestionnaire): string {
  const total = stored.form.questions.length;
  let answered = 0;
  for (const question of stored.form.questions) {
    if (isAnsweredValue(stored.answers[question.id])) {
      answered++;
    }
  }
  return `${answered}/${total}`;
}
