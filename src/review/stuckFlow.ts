/**
 * The stuck flow.  GOVERNED BY: §10.4, §2.5
 *
 * Escalates hint → one retry → auto-explanation → break it down, and the user
 * can bail to skip at any point (§2.5: never a dead end).
 *
 * `assistance_level` records the FURTHEST rung reached. It is SIGNAL, NOT SCORE
 * (§10.4): a "nailed it" that needed full scaffolding is a materially different
 * data point from a cold one, but it MUST NOT change a tier transition. Nothing
 * in this module touches mastery.
 */
import type { AssistanceLevel } from "../types/index.js";

/** Ordering for "furthest reached". */
const RANK: Record<AssistanceLevel, number> = {
  none: 0,
  hint: 1,
  retry: 2,
  scaffolded: 3,
};

export function furthest(a: AssistanceLevel, b: AssistanceLevel): AssistanceLevel {
  return RANK[a] >= RANK[b] ? a : b;
}

export interface StuckState {
  level: AssistanceLevel;
  hintShown: boolean;
  /** §10.4 step 2: exactly one retry after the hint. */
  retryUsed: boolean;
  cardShown: boolean;
  scaffoldShown: boolean;
}

export function initialStuckState(): StuckState {
  return {
    level: "none",
    hintShown: false,
    retryUsed: false,
    cardShown: false,
    scaffoldShown: false,
  };
}

export function showHint(state: StuckState): StuckState {
  return { ...state, hintShown: true, level: furthest(state.level, "hint") };
}

/** A second attempt after the hint is the "retry" rung. */
export function recordRetry(state: StuckState): StuckState {
  return { ...state, retryUsed: true, level: furthest(state.level, "retry") };
}

/**
 * §10.4 step 3 — the teaching card surfaces automatically for a stuck user
 * regardless of mastery. Being stuck at mastery 2 is direct evidence that the
 * skip-by-default assumption is wrong for them right now. Showing the card is
 * not itself an escalation rung, so the level is unchanged.
 */
export function showCard(state: StuckState): StuckState {
  return { ...state, cardShown: true };
}

export function showScaffold(state: StuckState): StuckState {
  return { ...state, scaffoldShown: true, level: furthest(state.level, "scaffolded") };
}

/**
 * Should the teaching card appear automatically now? True once the user has
 * taken the hint and spent their retry and is still asking for help (§10.4).
 */
export function shouldAutoExplain(state: StuckState): boolean {
  return state.hintShown && state.retryUsed && !state.cardShown;
}
