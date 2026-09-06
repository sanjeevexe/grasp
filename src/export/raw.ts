/**
 * Raw JSON export.  GOVERNED BY: §20
 *
 * A dump of `questions` plus joined file paths — the debugging and portability
 * escape hatch. Optionally filtered by project, tag, or date range.
 */
import type { DatabaseSync } from "node:sqlite";
import { getQuestionFiles, listAllQuestions, parseScaffold } from "../storage/models/questions.js";
import type { QuestionRow } from "../storage/models/questions.js";

export interface ExportFilters {
  projectId?: number;
  tag?: string;
  since?: string;
  until?: string;
}

export function selectQuestions(db: DatabaseSync, filters: ExportFilters = {}): QuestionRow[] {
  return listAllQuestions(db).filter((question) => {
    if (filters.projectId !== undefined && question.project_id !== filters.projectId) return false;
    if (filters.tag !== undefined && question.concept_tag !== filters.tag) return false;
    if (filters.since !== undefined && question.created_at < filters.since) return false;
    if (filters.until !== undefined && question.created_at > filters.until) return false;
    return true;
  });
}

export function renderRawExport(db: DatabaseSync, questions: QuestionRow[]): string {
  const payload = questions.map((question) => ({
    ...question,
    scaffold: parseScaffold(question),
    files: getQuestionFiles(db, question.id),
  }));
  return `${JSON.stringify(payload, null, 2)}\n`;
}
