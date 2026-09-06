/** `questions` + `question_files` CRUD.  GOVERNED BY: §19, §14.2, §14.3, §13.3
 *
 * `question_files` is a join table, not a serialized array, because the hard
 * gate queries it against staged filenames on every commit (§13.3) and it must
 * be indexable.
 *
 * `user_answer` is retained for `grasp history` and is NEVER evaluated (§2.1).
 */
import type { DatabaseSync } from "node:sqlite";
import { execute, insertReturningId, nowIso, queryAll, queryOne, withTransaction } from "../db.js";
import { ensureConcept } from "./concepts.js";
import type {
  AssistanceLevel,
  QuestionOrigin,
  QuestionStatus,
  QuestionType,
  SelfAssessment,
} from "../../types/index.js";

export interface QuestionRow {
  id: number;
  project_id: number;
  type: QuestionType;
  concept_tag: string | null;
  origin: QuestionOrigin;
  batch_id: string | null;
  diff_hash: string | null;
  file_hash: string | null;
  question_text: string;
  sample_answer: string;
  teaching_card_text: string | null;
  teaching_card_deeper: string | null;
  hint: string | null;
  scaffold_json: string | null;
  code_snippet: string | null;
  author_confidence: number | null;
  status: QuestionStatus;
  self_assessment: SelfAssessment | null;
  assistance_level: AssistanceLevel;
  user_answer: string | null;
  created_at: string;
  answered_at: string | null;
}

export interface NewQuestion {
  project_id: number;
  type: QuestionType;
  concept_tag: string | null;
  origin: QuestionOrigin;
  batch_id?: string | null;
  diff_hash?: string | null;
  file_hash?: string | null;
  question_text: string;
  sample_answer: string;
  teaching_card_text?: string | null;
  teaching_card_deeper?: string | null;
  hint?: string | null;
  scaffold?: string[] | null;
  code_snippet?: string | null;
  author_confidence?: number | null;
  /** POSIX-style, relative to the project root (§16.4). */
  files: string[];
}

/** One question plus its file attributions, written atomically (§5.4). */
export function insertQuestion(db: DatabaseSync, question: NewQuestion): number {
  return withTransaction(db, () => {
    // questions.concept_tag has an FK to concepts(tag), and a tag is usually
    // brand new when its first question lands. Creating it here keeps the row
    // and its concept a single atomic write; mastery starts at `none` (§11.1).
    if (question.concept_tag) ensureConcept(db, question.concept_tag);
    const id = insertReturningId(
      db,
      `INSERT INTO questions (
         project_id, type, concept_tag, origin, batch_id, diff_hash, file_hash,
         question_text, sample_answer, teaching_card_text, teaching_card_deeper,
         hint, scaffold_json, code_snippet, author_confidence, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      question.project_id,
      question.type,
      question.concept_tag,
      question.origin,
      question.batch_id ?? null,
      question.diff_hash ?? null,
      question.file_hash ?? null,
      question.question_text,
      question.sample_answer,
      question.teaching_card_text ?? null,
      question.teaching_card_deeper ?? null,
      question.hint ?? null,
      question.scaffold ? JSON.stringify(question.scaffold) : null,
      question.code_snippet ?? null,
      question.author_confidence ?? null,
      nowIso(),
    );
    for (const file of question.files) {
      execute(
        db,
        "INSERT OR IGNORE INTO question_files (question_id, file_path) VALUES (?, ?)",
        id,
        file,
      );
    }
    return id;
  });
}

export function getQuestion(db: DatabaseSync, id: number): QuestionRow | undefined {
  return queryOne<QuestionRow>(db, "SELECT * FROM questions WHERE id = ?", id);
}

export function getQuestionFiles(db: DatabaseSync, questionId: number): string[] {
  return queryAll<{ file_path: string }>(
    db,
    "SELECT file_path FROM question_files WHERE question_id = ? ORDER BY file_path",
    questionId,
  ).map((row) => row.file_path);
}

export function parseScaffold(row: QuestionRow): string[] {
  if (!row.scaffold_json) return [];
  try {
    const parsed: unknown = JSON.parse(row.scaffold_json);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
  } catch {
    // A corrupt scaffold must not break the review session (§2.5, never a dead end).
    return [];
  }
}

/** §7.5 / §12.2 dedup: the same diff or file section never produces two questions. */
export function questionExistsForHash(
  db: DatabaseSync,
  projectId: number,
  column: "diff_hash" | "file_hash",
  hash: string,
): boolean {
  const row = queryOne<{ id: number }>(
    db,
    `SELECT id FROM questions WHERE project_id = ? AND ${column} = ? LIMIT 1`,
    projectId,
    hash,
  );
  return row !== undefined;
}

export function listPendingQuestions(db: DatabaseSync, projectId?: number): QuestionRow[] {
  return projectId === undefined
    ? queryAll<QuestionRow>(
        db,
        "SELECT * FROM questions WHERE status = 'pending' ORDER BY created_at DESC, id DESC",
      )
    : queryAll<QuestionRow>(
        db,
        "SELECT * FROM questions WHERE status = 'pending' AND project_id = ? ORDER BY created_at DESC, id DESC",
        projectId,
      );
}

export function listQuestionsByTag(db: DatabaseSync, tag: string): QuestionRow[] {
  return queryAll<QuestionRow>(
    db,
    "SELECT * FROM questions WHERE concept_tag = ? ORDER BY created_at DESC, id DESC",
    tag,
  );
}

/**
 * §11.6 condition 1 — derived with a COUNT, never a stored counter, which drifts
 * out of sync on partial writes.
 */
export function countQuestionsForTag(db: DatabaseSync, tag: string): number {
  const row = queryOne<{ n: number }>(
    db,
    "SELECT COUNT(*) AS n FROM questions WHERE concept_tag = ? AND type != 'synthesis'",
    tag,
  );
  return row?.n ?? 0;
}

/** §8.1 — the hourly cap counts `created_at` over a rolling 60 minutes, all projects. */
export function countQuestionsSince(db: DatabaseSync, sinceIso: string): number {
  const row = queryOne<{ n: number }>(
    db,
    "SELECT COUNT(*) AS n FROM questions WHERE created_at > ?",
    sinceIso,
  );
  return row?.n ?? 0;
}

export interface AnswerUpdate {
  status: QuestionStatus;
  self_assessment: SelfAssessment | null;
  assistance_level: AssistanceLevel;
  user_answer: string | null;
}

/** §14.4 — a completed answer must never be lost to a Ctrl-C, so this is its own write. */
export function recordAnswer(db: DatabaseSync, id: number, update: AnswerUpdate): void {
  execute(
    db,
    `UPDATE questions
        SET status = ?, self_assessment = ?, assistance_level = ?, user_answer = ?, answered_at = ?
      WHERE id = ?`,
    update.status,
    update.self_assessment,
    update.assistance_level,
    update.user_answer,
    update.status === "pending" ? null : nowIso(),
    id,
  );
}

/** §13.3 — questions attached to any of these files. Paths must already be normalized. */
export function findQuestionsForFiles(
  db: DatabaseSync,
  projectId: number,
  files: string[],
): QuestionRow[] {
  if (files.length === 0) return [];
  const placeholders = files.map(() => "?").join(", ");
  return queryAll<QuestionRow>(
    db,
    `SELECT DISTINCT q.* FROM questions q
       JOIN question_files f ON f.question_id = q.id
      WHERE q.project_id = ? AND q.status = 'pending' AND f.file_path IN (${placeholders})
      ORDER BY q.created_at DESC`,
    projectId,
    ...files,
  );
}

export function listAllQuestions(db: DatabaseSync): QuestionRow[] {
  return queryAll<QuestionRow>(db, "SELECT * FROM questions ORDER BY created_at DESC, id DESC");
}

export function deleteAllQuestions(db: DatabaseSync): void {
  execute(db, "DELETE FROM questions");
}
