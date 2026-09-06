/**
 * The answering flow.  GOVERNED BY: §14.4, §10.2, §10.3, §10.4, §2.1
 *
 * Teaching card (if applicable) → question → answer → [stuck escalations on
 * demand] → sample answer → self-assessment.
 *
 * GRASP NEVER GRADES (§2.1). Nothing here inspects the user's answer. It is
 * stored verbatim for `grasp history` and compared by the user against the
 * sample answer, never by the program.
 *
 * RECONSTRUCT HIDES THE CODE (§10.1, §14.4): `code_snippet` is withheld until
 * the user has answered or skipped. That is the whole point of the tier.
 */
import chalk from "chalk";
import type { DatabaseSync } from "node:sqlite";
import { parseScaffold, recordAnswer, type QuestionRow } from "../storage/models/questions.js";
import { getConcept } from "../storage/models/concepts.js";
import type { AssistanceLevel, SelfAssessment, Tier } from "../types/index.js";
import { COMMAND_LABELS, type ReviewIo } from "./io.js";
import { DEFAULT_REVIEW_KEYS, formatBinding, type ReviewAction } from "./keys.js";
import {
  initialStuckState,
  recordRetry,
  shouldAutoExplain,
  showCard,
  showHint,
  showScaffold,
  type StuckState,
} from "./stuckFlow.js";

export interface AnsweredQuestion {
  question: QuestionRow;
  assessment: SelfAssessment | null;
  assistance: AssistanceLevel;
  answer: string | null;
  skipped: boolean;
}

export interface SessionResult {
  answered: AnsweredQuestion[];
  /** True when the user quit early; the rest stay pending (§14.4). */
  quit: boolean;
}

export interface SessionDeps {
  db: DatabaseSync;
  io: ReviewIo;
  /** Resolved `config.review.keys`, so the hint line matches the live bindings. */
  keys?: Record<ReviewAction, string>;
  /**
   * Applied after each answer. Stage 5 wires mastery here; kept as a hook so
   * §11.7's separation is enforced by construction — the session never touches
   * `concepts` or `synthesis_clusters` itself.
   */
  onAnswered?: (result: AnsweredQuestion) => void;
  /** Effective (post-decay) tier for a tag; stage 5 supplies the real one. */
  effectiveTier?: (tag: string) => Tier;
}

const RULE = chalk.dim("─".repeat(76));

function renderTeachingCard(io: ReviewIo, question: QuestionRow, deeper: boolean): void {
  if (!question.teaching_card_text) return;
  // §10.2: visually distinct from the question, so it reads as context rather
  // than as part of the test.
  io.write(`\n${chalk.green("┃")} ${chalk.green.bold("CONCEPT")}\n`);
  for (const line of question.teaching_card_text.split("\n")) {
    io.write(`${chalk.green("┃")} ${chalk.green(line)}\n`);
  }
  if (deeper && question.teaching_card_deeper) {
    for (const line of question.teaching_card_deeper.split("\n")) {
      io.write(`${chalk.green("┃")} ${chalk.green.dim(line)}\n`);
    }
  }
}

function renderCode(io: ReviewIo, question: QuestionRow): void {
  if (!question.code_snippet) return;
  io.write(`\n${chalk.dim(question.code_snippet)}\n`);
}

function renderQuestion(io: ReviewIo, question: QuestionRow, index: number, total: number): void {
  io.write(`\n${RULE}\n`);
  const tag = question.concept_tag ? chalk.cyan(question.concept_tag) : chalk.dim("(untagged)");
  io.write(`${chalk.dim(`[${index + 1}/${total}]`)} ${chalk.bold(question.type)}  ${tag}\n`);
  io.write(`\n${chalk.bold.white(question.question_text)}\n`);
}

function renderKeys(
  io: ReviewIo,
  question: QuestionRow,
  bindings: Record<ReviewAction, string>,
): void {
  // §14.4 — spell the modifier out, so nothing has to be remembered, and read it
  // from the resolved bindings so a rebound key is never mislabelled.
  const hints = COMMAND_LABELS.filter(
    (entry) => entry.command !== "deeper" || question.teaching_card_deeper,
  ).map((entry) => `${formatBinding(bindings[entry.command])} ${entry.label}`);
  io.write(
    chalk.dim(
      `\n${hints.join("   ")}\n` +
        // The commands fire on the keypress; Enter belongs to the answer.
        `Type your answer and press Enter. Alt+Enter for a new line.\n> `,
    ),
  );
}

/**
 * §10.2 — the card is shown up front only when effective mastery is `none`.
 * Above that it is skipped by default but stays reachable with `[e]`; the door
 * is never locked.
 */
function shouldShowCardUpFront(question: QuestionRow, tier: Tier): boolean {
  return Boolean(question.teaching_card_text) && tier === "none";
}

export async function runReviewSession(
  questions: QuestionRow[],
  deps: SessionDeps,
): Promise<SessionResult> {
  const { db, io } = deps;
  const bindings = deps.keys ?? DEFAULT_REVIEW_KEYS;
  const answered: AnsweredQuestion[] = [];

  for (const [index, question] of questions.entries()) {
    const tier = question.concept_tag
      ? (deps.effectiveTier?.(question.concept_tag) ??
        getConcept(db, question.concept_tag)?.tier ??
        "none")
      : "none";

    let state: StuckState = initialStuckState();
    const hidesCode = question.type === "reconstruct";

    renderQuestion(io, question, index, questions.length);
    if (shouldShowCardUpFront(question, tier)) {
      renderTeachingCard(io, question, false);
      state = showCard(state);
    }
    // Reconstruct withholds the code until the attempt is over (§14.4).
    if (!hidesCode) renderCode(io, question);
    else
      io.write(chalk.dim("\n(the code is hidden for this one — describe your approach first)\n"));

    let answer: string | null = null;
    let skipped = false;
    let quit = false;

    // Loop until the user answers, skips, or quits: every path out is one of
    // those three, so there is never a dead end (§2.5).
    for (;;) {
      renderKeys(io, question, bindings);
      const input = await io.prompt();

      if (input.kind === "answer") {
        if (answer !== null) state = recordRetry(state);
        answer = input.text;
        break;
      }

      switch (input.command) {
        case "hint":
          // §10.4 escalates; it does not repeat. A second Esc moves to the next
          // rung rather than reprinting a hint the user has already read.
          if (!state.hintShown) {
            state = showHint(state);
            io.write(`\n${chalk.magenta("HINT")}  ${chalk.magenta(question.hint ?? "(none)")}\n`);
          } else if (question.teaching_card_text && !state.cardShown) {
            renderTeachingCard(io, question, false);
            state = showCard(state);
          } else {
            io.write(chalk.dim("\n(that is the whole hint — Ctrl+K breaks the question down)\n"));
          }
          break;
        case "explain":
          if (question.teaching_card_text) {
            renderTeachingCard(io, question, false);
            state = showCard(state);
          } else {
            io.write(chalk.dim("\n(no concept card for this question)\n"));
          }
          break;
        case "deeper":
          if (question.teaching_card_deeper) {
            renderTeachingCard(io, question, true);
            state = showCard(state);
          } else {
            io.write(chalk.dim("\n(no deeper explanation for this question)\n"));
          }
          break;
        case "breakdown": {
          const scaffold = parseScaffold(question);
          if (scaffold.length === 0) {
            io.write(chalk.dim("\n(no breakdown available)\n"));
            break;
          }
          // §10.4 step 3: a stuck user gets the card automatically, whatever
          // their mastery says.
          if (shouldAutoExplain(state) && question.teaching_card_text) {
            renderTeachingCard(io, question, false);
            state = showCard(state);
          }
          state = showScaffold(state);
          io.write(`\n${chalk.blue("BREAK IT DOWN")}\n`);
          // Ungraded and untracked — pure scaffolding, not extra assessment.
          scaffold.forEach((step, i) => io.write(chalk.blue(`  ${i + 1}. ${step}\n`)));
          break;
        }
        case "skip":
          skipped = true;
          break;
        case "quit":
          quit = true;
          break;
      }
      if (skipped || quit) break;
    }

    if (quit) {
      // Everything already answered is persisted; the rest stay pending (§14.4).
      return { answered, quit: true };
    }

    if (skipped) {
      // §10.3 — an explicit skip changes NOTHING: no tier change, no clock reset.
      recordAnswer(db, question.id, {
        status: "skipped",
        self_assessment: null,
        assistance_level: state.level,
        user_answer: null,
      });
      const result: AnsweredQuestion = {
        question,
        assessment: null,
        assistance: state.level,
        answer: null,
        skipped: true,
      };
      answered.push(result);
      deps.onAnswered?.(result);
      io.write(chalk.dim("\nSkipped.\n"));
      continue;
    }

    // The attempt is over: the code and the sample answer can appear.
    if (hidesCode) renderCode(io, question);
    io.write(`\n${chalk.yellow.bold("SAMPLE ANSWER")}\n${chalk.yellow(question.sample_answer)}\n`);
    io.write(chalk.dim("\nThis is a comparison, not a marking scheme — you judge your own.\n"));

    const assessment = await io.promptAssessment();
    if (assessment === null) {
      // Quit at the assessment prompt: the answer is kept, the question stays
      // pending, and nothing is lost.
      return { answered, quit: true };
    }

    // §10.3 way_off auto-shows the explanation, overriding the mastery skip.
    if (assessment === "way_off" && question.teaching_card_text && !state.cardShown) {
      renderTeachingCard(io, question, false);
      state = showCard(state);
    }

    recordAnswer(db, question.id, {
      status: "answered",
      self_assessment: assessment,
      assistance_level: state.level,
      user_answer: answer,
    });
    const result: AnsweredQuestion = {
      question,
      assessment,
      assistance: state.level,
      answer,
      skipped: false,
    };
    answered.push(result);
    deps.onAnswered?.(result);
  }

  return { answered, quit: false };
}
