/**
 * Anki plaintext export.  GOVERNED BY: §20
 *
 * Tab-separated front/back. ALL statuses are included — an unanswered question
 * with a sample answer is still a valid flashcard — and teaching cards are
 * excluded, because they are not quiz material.
 */
import type { QuestionRow } from "../storage/models/questions.js";

/** §20 — tabs become spaces and newlines become <br>, per Anki's format. */
export function escapeAnkiField(value: string): string {
  return value.replace(/\t/g, " ").replace(/\r?\n/g, "<br>");
}

/**
 * §20 — `trace` and `predict_break` are phrased against specific code behavior
 * and are meaningless without it, so the snippet is embedded in the front.
 * `reconstruct` and `synthesis` are self-contained by design and export as-is —
 * embedding the code in a reconstruct card would defeat the tier.
 */
export function renderAnkiCard(question: QuestionRow): string {
  const needsCode = question.type === "trace" || question.type === "predict_break";
  const front =
    needsCode && question.code_snippet
      ? `${question.question_text}<br><br>${question.code_snippet}`
      : question.question_text;
  return `${escapeAnkiField(front)}\t${escapeAnkiField(question.sample_answer)}`;
}

export function renderAnkiExport(questions: QuestionRow[]): string {
  return `${questions.map(renderAnkiCard).join("\n")}\n`;
}
