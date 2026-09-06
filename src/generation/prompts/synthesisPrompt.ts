/**
 * Synthesis checkpoint prompt.  GOVERNED BY: §9.5, §11.4
 *
 * Input: the BUNDLE of prior diffs under one concept tag (not a single batch).
 * Output: EXACTLY ONE integration question.
 *   { "question": "...", "sample_answer": "...", "hint": "..." }
 *
 * NO teaching card, NO tier, NO concept tagging — a synthesis checkpoint tests
 * whether the user can CONNECT pieces they've already individually demonstrated
 * understanding of. It is scored separately and MUST NEVER touch concept
 * mastery (§11.7).
 *
 * Same composed-template shape as systemPrompt.ts: rules in the system half,
 * the bundle in the user half.
 */
import type { SynthesisGenerationInput } from "../../types/index.js";

export const SYNTHESIS_ROLE = `You write a single integration question for a developer who has already answered
questions about several separate pieces of code that share one concept, and has
demonstrated they understand those pieces individually.

Per-piece questions test whether someone followed each part. Rebuilding a
feature takes something else: holding the parts together and knowing how they
reach each other. That is the only thing this question measures.

You never grade an answer. The developer reads your question, answers it, reads
your sample answer, and rates themselves. Nothing you write is a rubric.`;

export const SYNTHESIS_QUESTION_RULES = `THE QUESTION

  - It MUST span at least two of the pieces below. A question answerable from
    one piece alone is not a synthesis checkpoint — it is an ordinary question
    and it wastes the capstone.
  - Aim at the seams: how one piece reaches the next, what invariant survives
    across them, what order they must run in, where state or errors cross a
    boundary, what the whole path does end to end.
  - Ask the developer to walk it, or to reason about what happens to the WHOLE
    system when one piece changes, fails, or is removed.
  - It has to be answerable from what is shown, without guessing at code that
    is not here.
  - Do not repeat a question that was already asked about a piece. Those are
    listed with each piece so you can steer clear of them.
  - One question. Not two joined by "and". Not a list of parts (a), (b), (c).`;

export const SYNTHESIS_ANSWER_RULES = `SAMPLE ANSWER AND HINT

sample_answer: what a developer who could rebuild this feature would say, in
three to six sentences of plain prose. Trace the actual path through the pieces
and say why it is arranged this way. It is shown after the attempt, as something
to compare against — never a grading key.

hint: one or two sentences pointing at which two pieces to hold together, or
which boundary matters, without stating the answer.`;

export const SYNTHESIS_OUTPUT_CONTRACT = `OUTPUT

Return one JSON object and nothing else. No prose before or after it, no
comments. A \`\`\`json fence around the object is fine.

{
  "question": "...",
  "sample_answer": "...",
  "hint": "..."
}

Every string is plain prose — no markdown headings, no bullet characters, no
code fences inside them. Inline \`backticks\` around identifiers are fine.`;

export const SYNTHESIS_PROMPT_SECTIONS: readonly string[] = [
  SYNTHESIS_ROLE,
  SYNTHESIS_QUESTION_RULES,
  SYNTHESIS_ANSWER_RULES,
  SYNTHESIS_OUTPUT_CONTRACT,
];

export function buildSynthesisSystemPrompt(
  sections: readonly string[] = SYNTHESIS_PROMPT_SECTIONS,
): string {
  return sections.join("\n\n---\n\n");
}

export function buildSynthesisUserMessage(input: SynthesisGenerationInput): string {
  const pieces = input.bundle
    .map((item, i) => {
      const header = `PIECE ${i + 1} — ${item.files.join(", ")}`;
      const asked = item.question ? `\nalready asked: ${item.question}` : "";
      return `${header}${asked}\n\`\`\`\n${item.code}\n\`\`\``;
    })
    .join("\n\n");

  return [
    `CONCEPT: ${input.tag}`,
    `The developer has already demonstrated understanding of each piece below individually.`,
    pieces,
  ].join("\n\n");
}
