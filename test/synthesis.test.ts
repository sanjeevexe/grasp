/**
 * Synthesis eligibility, re-surfacing, and scoring isolation.
 * GOVERNED BY: §11.5–§11.8, §22.2
 *
 * §11.7's isolation is the third verify-deliberately item: a synthesis outcome
 * must never move concept mastery.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { closeDatabase, openDatabase } from "../src/storage/db.js";
import { insertProject } from "../src/storage/models/projects.js";
import { ensureConcept, getConcept, setTier } from "../src/storage/models/concepts.js";
import { getQuestion, insertQuestion } from "../src/storage/models/questions.js";
import { ensureCluster, getCluster } from "../src/storage/models/synthesisClusters.js";
import {
  evaluateEligibility,
  onNewQuestionForTag,
  recordOutcome,
  refreshEligibility,
  statusForAssessment,
  type SynthesisSettings,
} from "../src/synthesis/trigger.js";
import { applyAnsweredQuestion } from "../src/mastery/apply.js";
import type { AnsweredQuestion } from "../src/review/reviewSession.js";

const NOW = new Date("2026-06-01T00:00:00.000Z");
const SETTINGS: SynthesisSettings = {
  minDiffCount: 3,
  minMasteryTier: "predict_break",
  decayWindows: { trace: 90, predictBreak: 60, reconstruct: 45 },
};

let db: DatabaseSync;
let dir: string;
let projectId: number;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "grasp-synthesis-"));
  db = openDatabase({ file: path.join(dir, "history.db") });
  projectId = insertProject(db, "/repo/one").id;
});

afterEach(() => {
  closeDatabase(db);
  fs.rmSync(dir, { recursive: true, force: true });
});

function seedQuestions(
  tag: string,
  count: number,
  type: "trace" | "synthesis" = "trace",
): number[] {
  return Array.from({ length: count }, () =>
    insertQuestion(db, {
      project_id: projectId,
      type,
      concept_tag: tag,
      origin: type === "synthesis" ? "synthesis" : "live",
      question_text: "q",
      sample_answer: "a",
      files: ["src/a.ts"],
    }),
  );
}

describe("eligibility requires BOTH conditions (§11.6)", () => {
  it("count met, mastery not → NOT eligible", () => {
    seedQuestions("auth-flow", 3);
    setTier(db, "auth-flow", "trace", NOW.toISOString());
    const result = evaluateEligibility(db, "auth-flow", SETTINGS, NOW);
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("mastery");
  });

  it("mastery met, count not → NOT eligible", () => {
    seedQuestions("auth-flow", 2);
    setTier(db, "auth-flow", "reconstruct", NOW.toISOString());
    const result = evaluateEligibility(db, "auth-flow", SETTINGS, NOW);
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("count");
  });

  it("both met → eligible", () => {
    seedQuestions("auth-flow", 3);
    setTier(db, "auth-flow", "predict_break", NOW.toISOString());
    expect(evaluateEligibility(db, "auth-flow", SETTINGS, NOW).eligible).toBe(true);
  });

  it("uses the EFFECTIVE tier, so a decayed concept loses eligibility (§11.2)", () => {
    seedQuestions("auth-flow", 3);
    // Stored reconstruct, 46 days ago → effective predict_break: still eligible.
    setTier(
      db,
      "auth-flow",
      "reconstruct",
      new Date(NOW.getTime() - 46 * 86_400_000).toISOString(),
    );
    expect(evaluateEligibility(db, "auth-flow", SETTINGS, NOW).eligible).toBe(true);

    // Stored predict_break, 61 days ago → effective trace: no longer eligible.
    setTier(
      db,
      "auth-flow",
      "predict_break",
      new Date(NOW.getTime() - 61 * 86_400_000).toISOString(),
    );
    const decayed = evaluateEligibility(db, "auth-flow", SETTINGS, NOW);
    expect(decayed.effectiveTier).toBe("trace");
    expect(decayed.eligible).toBe(false);
  });

  it("derives the count from a query, not a counter (§11.6)", () => {
    setTier(db, "auth-flow", "predict_break", NOW.toISOString());
    const ids = seedQuestions("auth-flow", 3);
    expect(evaluateEligibility(db, "auth-flow", SETTINGS, NOW).eligible).toBe(true);

    // Delete one: eligibility tracks immediately, with nothing to invalidate.
    db.prepare("DELETE FROM questions WHERE id = ?").run(ids[0]);
    const after = evaluateEligibility(db, "auth-flow", SETTINGS, NOW);
    expect(after.questionCount).toBe(2);
    expect(after.eligible).toBe(false);
  });

  it("excludes synthesis questions from the count (§11.6)", () => {
    setTier(db, "auth-flow", "predict_break", NOW.toISOString());
    seedQuestions("auth-flow", 2);
    seedQuestions("auth-flow", 5, "synthesis");
    expect(evaluateEligibility(db, "auth-flow", SETTINGS, NOW).questionCount).toBe(2);
  });

  it("a tag with no questions is never eligible", () => {
    ensureConcept(db, "auth-flow");
    setTier(db, "auth-flow", "reconstruct", NOW.toISOString());
    expect(evaluateEligibility(db, "auth-flow", SETTINGS, NOW).reason).toBe("no_questions");
  });
});

describe("re-surfacing (§11.8)", () => {
  function makeEligible(tag: string, count = 3): void {
    seedQuestions(tag, count);
    setTier(db, tag, "predict_break", NOW.toISOString());
  }

  it("struggled re-surfaces when a NEW question lands under the tag, not before", () => {
    makeEligible("auth-flow");
    recordOutcome(db, "auth-flow", "way_off", 3);
    expect(getCluster(db, "auth-flow")?.status).toBe("struggled");
    expect(getCluster(db, "auth-flow")?.eligible).toBe(0);

    // Time passing alone changes nothing — no timer, no reminder.
    refreshEligibility(db, "auth-flow", SETTINGS, new Date(NOW.getTime() + 30 * 86_400_000));
    expect(getCluster(db, "auth-flow")?.eligible).toBe(0);

    // A new question under the tag re-arms it.
    seedQuestions("auth-flow", 1);
    onNewQuestionForTag(db, "auth-flow", SETTINGS, NOW);
    expect(getCluster(db, "auth-flow")?.eligible).toBe(1);
  });

  it("passed stays closed until the cluster grows by another minDiffCount", () => {
    makeEligible("auth-flow");
    recordOutcome(db, "auth-flow", "nailed_it", 3);
    expect(getCluster(db, "auth-flow")?.status).toBe("passed");

    // +2 beyond the checkpoint: still closed.
    seedQuestions("auth-flow", 2);
    onNewQuestionForTag(db, "auth-flow", SETTINGS, NOW);
    expect(evaluateEligibility(db, "auth-flow", SETTINGS, NOW).reason).toBe("passed_and_not_grown");

    // +3: a fresh checkpoint against the now-larger system.
    seedQuestions("auth-flow", 1);
    expect(evaluateEligibility(db, "auth-flow", SETTINGS, NOW).eligible).toBe(true);
  });

  it("maps assessments to outcomes per §11.7", () => {
    expect(statusForAssessment("nailed_it")).toBe("passed");
    expect(statusForAssessment("mostly_there")).toBe("struggled");
    expect(statusForAssessment("way_off")).toBe("struggled");
  });
});

describe("scored separately, always (§11.7)", () => {
  it("a synthesis outcome leaves the concept row byte-identical", () => {
    seedQuestions("auth-flow", 3);
    setTier(db, "auth-flow", "predict_break", NOW.toISOString());
    ensureCluster(db, "auth-flow");
    const before = JSON.stringify(getConcept(db, "auth-flow"));

    recordOutcome(db, "auth-flow", "nailed_it", 3);

    expect(JSON.stringify(getConcept(db, "auth-flow"))).toBe(before);
  });

  it("answering a synthesis question does not move mastery, even nailed_it", () => {
    seedQuestions("auth-flow", 3);
    setTier(db, "auth-flow", "predict_break", NOW.toISOString());
    const before = JSON.stringify(getConcept(db, "auth-flow"));

    const [synthesisId] = seedQuestions("auth-flow", 1, "synthesis");
    const answered: AnsweredQuestion = {
      question: getQuestion(db, synthesisId)!,
      assessment: "nailed_it",
      assistance: "none",
      answer: "connected them",
      skipped: false,
    };
    const result = applyAnsweredQuestion(db, answered, SETTINGS, NOW);

    expect(result.synthesisRecorded).toBe(true);
    expect(result.after).toBeNull();
    expect(JSON.stringify(getConcept(db, "auth-flow"))).toBe(before);
    expect(getCluster(db, "auth-flow")?.status).toBe("passed");
  });

  it("a concept answer does not write synthesis status", () => {
    seedQuestions("auth-flow", 3);
    setTier(db, "auth-flow", "predict_break", NOW.toISOString());
    ensureCluster(db, "auth-flow");
    const [id] = seedQuestions("auth-flow", 1);

    applyAnsweredQuestion(
      db,
      {
        question: getQuestion(db, id)!,
        assessment: "way_off",
        assistance: "none",
        answer: "x",
        skipped: false,
      },
      SETTINGS,
      NOW,
    );

    expect(getCluster(db, "auth-flow")?.status).toBe("not_yet_attempted");
  });

  it("clusters by tag, never by timing or file adjacency (§11.5)", () => {
    setTier(db, "auth-flow", "predict_break", NOW.toISOString());
    setTier(db, "debouncing", "predict_break", NOW.toISOString());
    seedQuestions("auth-flow", 3);
    seedQuestions("debouncing", 1);

    expect(evaluateEligibility(db, "auth-flow", SETTINGS, NOW).eligible).toBe(true);
    // Same instant, same file — different tag, so a separate cluster entirely.
    expect(evaluateEligibility(db, "debouncing", SETTINGS, NOW).eligible).toBe(false);
  });
});

describe("refreshEligibility (§11.6)", () => {
  it("does not litter the table with clusters for ineligible tags", () => {
    seedQuestions("auth-flow", 1);
    refreshEligibility(db, "auth-flow", SETTINGS, NOW);
    expect(getCluster(db, "auth-flow")).toBeUndefined();
  });

  it("persists the flag once a tag becomes eligible", () => {
    seedQuestions("auth-flow", 3);
    setTier(db, "auth-flow", "reconstruct", NOW.toISOString());
    refreshEligibility(db, "auth-flow", SETTINGS, NOW);
    expect(getCluster(db, "auth-flow")?.eligible).toBe(1);
  });

  it("clears the flag when a tag stops being eligible", () => {
    seedQuestions("auth-flow", 3);
    setTier(db, "auth-flow", "reconstruct", NOW.toISOString());
    refreshEligibility(db, "auth-flow", SETTINGS, NOW);

    setTier(db, "auth-flow", "trace", NOW.toISOString());
    refreshEligibility(db, "auth-flow", SETTINGS, NOW);
    expect(getCluster(db, "auth-flow")?.eligible).toBe(0);
  });
});
