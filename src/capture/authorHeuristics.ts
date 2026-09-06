/**
 * Authorship heuristic — a SOFT SIGNAL ONLY.  GOVERNED BY: §7.6
 *
 * MUST NEVER HARD-SUPPRESS A QUESTION. The output is an ordering hint for the
 * review queue (§14.2) and nothing else.
 *
 * The failure modes are asymmetric, so the heuristic is too: quizzing a human on
 * their own code is a mild annoyance, while silently skipping real AI-authored
 * code defeats the entire tool. Everything below biases toward "assume AI".
 */

export interface WriteEvent {
  path: string;
  /** ms since epoch. */
  at: number;
  bytes: number;
}

/** Above this, a burst of writes reads as machine-generated (§7.6). */
export const BURST_WINDOW_MS = 2000;
export const BURST_BYTES = 400;

/**
 * 0..1, higher meaning more likely AI-written. The floor is deliberately well
 * above zero: an unknown-provenance change must never sort to the bottom of the
 * queue, because that is indistinguishable from dropping it.
 */
export function estimateAuthorConfidence(events: WriteEvent[]): number {
  if (events.length === 0) return 0.8;

  const sorted = [...events].sort((a, b) => a.at - b.at);
  const span = sorted[sorted.length - 1].at - sorted[0].at;
  const totalBytes = sorted.reduce((sum, event) => sum + event.bytes, 0);
  const files = new Set(sorted.map((event) => event.path)).size;

  // A lot of content, arriving nearly at once, across several files: the shape
  // of a tool writing, not a person typing.
  const burst = span <= BURST_WINDOW_MS && totalBytes >= BURST_BYTES;
  if (burst) return files > 1 ? 0.95 : 0.9;

  // Steady typing over a long span with small increments looks human — but only
  // the ORDERING changes, never whether the question exists.
  const perSecond = span > 0 ? totalBytes / (span / 1000) : totalBytes;
  if (span > 30_000 && perSecond < 20) return 0.5;

  return 0.75;
}
