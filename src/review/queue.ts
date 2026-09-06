/**
 * Queue ordering, staleness, and scoping.  GOVERNED BY: §14.1, §14.2, §14.3
 *
 * Staleness is computed at READ time (§14.3, principle 4): nothing marks
 * questions expired on a schedule, because a job that runs whether or not the
 * user is working is exactly what §2.4 rules out.
 */
import type { QuestionRow } from "../storage/models/questions.js";

export interface QueueOptions {
  /** `config.questionStaleDays`; null disables staleness entirely (§14.3). */
  staleDays: number | null;
  /** Injected so tests can freeze time (§22.1). */
  now?: Date;
  /** `--all` also surfaces expired questions (§14.3). */
  includeExpired?: boolean;
}

export function isExpired(
  question: QuestionRow,
  staleDays: number | null,
  now = new Date(),
): boolean {
  if (staleDays === null) return false;
  const created = Date.parse(question.created_at);
  if (Number.isNaN(created)) return false;
  const ageDays = (now.getTime() - created) / 86_400_000;
  return ageDays > staleDays;
}

/**
 * §14.2 — newest first, synthesis last, and within a timestamp bucket the lower
 * authorship confidence sorts later: likely-human-written changes are the least
 * valuable to quiz on (§7.6).
 */
export function orderQueue(questions: QuestionRow[], options: QueueOptions): QuestionRow[] {
  const now = options.now ?? new Date();
  const visible = questions.filter(
    (q) =>
      q.status === "pending" && (options.includeExpired || !isExpired(q, options.staleDays, now)),
  );

  return [...visible].sort((a, b) => {
    const aSynthesis = a.type === "synthesis" ? 1 : 0;
    const bSynthesis = b.type === "synthesis" ? 1 : 0;
    if (aSynthesis !== bSynthesis) return aSynthesis - bSynthesis;

    const byRecency = Date.parse(b.created_at) - Date.parse(a.created_at);
    if (byRecency !== 0) return byRecency;

    // Same instant: higher confidence (more likely AI-written) first.
    const aConfidence = a.author_confidence ?? 1;
    const bConfidence = b.author_confidence ?? 1;
    if (aConfidence !== bConfidence) return bConfidence - aConfidence;

    return b.id - a.id;
  });
}

export function partitionExpired(
  questions: QuestionRow[],
  staleDays: number | null,
  now = new Date(),
): { live: QuestionRow[]; expired: QuestionRow[] } {
  const live: QuestionRow[] = [];
  const expired: QuestionRow[] = [];
  for (const question of questions) {
    (isExpired(question, staleDays, now) ? expired : live).push(question);
  }
  return { live, expired };
}
