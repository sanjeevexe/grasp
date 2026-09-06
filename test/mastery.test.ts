/**
 * Decay, tier transitions, and the apply seam.  GOVERNED BY: §10.3, §11.2, §22.2
 *
 * §22.2 names these as required cases. The transitions are the second of the
 * four verify-deliberately items: they operate on the EFFECTIVE tier and write
 * the STORED one.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { closeDatabase, openDatabase } from "../src/storage/db.js";
import { insertProject } from "../src/storage/models/projects.js";
import { getConcept, setTier } from "../src/storage/models/concepts.js";
import { getQuestion, insertQuestion } from "../src/storage/models/questions.js";
import {
  getEffectiveTier,
  oneTierDown,
  oneTierUp,
  type DecayWindows,
} from "../src/mastery/decay.js";
import { applySelfAssessment } from "../src/mastery/tierLogic.js";
import { applyAnsweredQuestion } from "../src/mastery/apply.js";
import type { AnsweredQuestion } from "../src/review/reviewSession.js";
import type { SelfAssessment, Tier } from "../src/types/index.js";

const WINDOWS: DecayWindows = { trace: 90, predictBreak: 60, reconstruct: 45 };
const NOW = new Date("2026-06-01T00:00:00.000Z");

function daysBefore(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

describe("decay (§11.2)", () => {
  it.each([
    ["trace", 90],
    ["predict_break", 60],
    ["reconstruct", 45],
  ] as const)("%s decays only strictly past its %i-day window", (tier, window) => {
    const at = (days: number) =>
      getEffectiveTier({ tier, last_demonstrated_at: daysBefore(days) }, WINDOWS, NOW);

    expect(at(1)).toBe(tier); // fresh
    expect(at(window)).toBe(tier); // boundary-exact must NOT decay (`>` not `>=`)
    expect(at(window + 1)).toBe(oneTierDown(tier));
    expect(at(window * 10)).toBe(oneTierDown(tier)); // exactly one tier, never more
  });

  it("drops exactly one tier however long it has been (§11.2)", () => {
    expect(
      getEffectiveTier(
        { tier: "reconstruct", last_demonstrated_at: daysBefore(3650) },
        WINDOWS,
        NOW,
      ),
    ).toBe("predict_break");
  });

  it("a null window disables decay for that tier", () => {
    const windows: DecayWindows = { ...WINDOWS, reconstruct: null };
    expect(
      getEffectiveTier(
        { tier: "reconstruct", last_demonstrated_at: daysBefore(9999) },
        windows,
        NOW,
      ),
    ).toBe("reconstruct");
    // ...and does not disable it for the others.
    expect(
      getEffectiveTier({ tier: "trace", last_demonstrated_at: daysBefore(9999) }, windows, NOW),
    ).toBe("none");
  });

  it("`none` cannot decay further", () => {
    expect(
      getEffectiveTier({ tier: "none", last_demonstrated_at: daysBefore(9999) }, WINDOWS, NOW),
    ).toBe("none");
  });

  it("treats a never-demonstrated concept as its stored tier, and a missing one as none", () => {
    expect(getEffectiveTier({ tier: "none", last_demonstrated_at: null }, WINDOWS, NOW)).toBe(
      "none",
    );
    expect(getEffectiveTier(undefined, WINDOWS, NOW)).toBe("none");
  });

  it("ignores an unparseable timestamp rather than decaying on garbage", () => {
    expect(
      getEffectiveTier({ tier: "trace", last_demonstrated_at: "not a date" }, WINDOWS, NOW),
    ).toBe("trace");
  });

  it("steps tiers in order and clamps at both ends", () => {
    expect(oneTierDown("none")).toBe("none");
    expect(oneTierUp("reconstruct")).toBe("reconstruct");
    expect(oneTierUp("none")).toBe("trace");
    expect(oneTierDown("trace")).toBe("none");
  });
});

describe("tier transitions (§10.3) — all 12 cases", () => {
  const tiers: Tier[] = ["none", "trace", "predict_break", "reconstruct"];
  const expected: Record<SelfAssessment, Record<Tier, Tier>> = {
    nailed_it: {
      none: "trace",
      trace: "predict_break",
      predict_break: "reconstruct",
      reconstruct: "reconstruct",
    },
    mostly_there: {
      none: "none",
      trace: "trace",
      predict_break: "predict_break",
      reconstruct: "reconstruct",
    },
    way_off: { none: "none", trace: "none", predict_break: "trace", reconstruct: "predict_break" },
  };

  for (const assessment of Object.keys(expected) as SelfAssessment[]) {
    for (const tier of tiers) {
      it(`${assessment} at ${tier} → ${expected[assessment][tier]}`, () => {
        expect(applySelfAssessment(tier, assessment, NOW).tier).toBe(expected[assessment][tier]);
      });
    }
  }

  it("nailed_it at reconstruct does not overflow", () => {
    expect(applySelfAssessment("reconstruct", "nailed_it", NOW).tier).toBe("reconstruct");
  });

  it("way_off at trace lands on none, re-arming the teaching card", () => {
    const result = applySelfAssessment("trace", "way_off", NOW);
    expect(result.tier).toBe("none");
    expect(result.autoShowExplanation).toBe(true);
  });

  it("all three reset the decay clock — engagement counts even when it goes badly", () => {
    for (const assessment of ["nailed_it", "mostly_there", "way_off"] as SelfAssessment[]) {
      expect(applySelfAssessment("trace", assessment, NOW).lastDemonstratedAt).toBe(
        NOW.toISOString(),
      );
    }
  });

  it("only way_off auto-shows the explanation", () => {
    expect(applySelfAssessment("trace", "nailed_it", NOW).autoShowExplanation).toBe(false);
    expect(applySelfAssessment("trace", "mostly_there", NOW).autoShowExplanation).toBe(false);
  });
});

describe("transitions apply to EFFECTIVE, not stored, tier (§10.3)", () => {
  let db: DatabaseSync;
  let dir: string;
  let projectId: number;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "grasp-mastery-"));
    db = openDatabase({ file: path.join(dir, "history.db") });
    projectId = insertProject(db, "/repo/one").id;
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const settings = {
    minDiffCount: 3,
    minMasteryTier: "predict_break" as Tier,
    decayWindows: WINDOWS,
  };

  function answeredFor(
    id: number,
    assessment: SelfAssessment | null,
    skipped = false,
  ): AnsweredQuestion {
    return {
      question: getQuestion(db, id)!,
      assessment,
      assistance: "none",
      answer: skipped ? null : "an answer",
      skipped,
    };
  }

  function seed(tag: string, type: "trace" | "synthesis" = "trace"): number {
    return insertQuestion(db, {
      project_id: projectId,
      type,
      concept_tag: tag,
      origin: type === "synthesis" ? "synthesis" : "live",
      question_text: "q",
      sample_answer: "a",
      files: ["src/a.ts"],
    });
  }

  it("THE CASE: decayed reconstruct + nailed_it returns to reconstruct, not beyond", () => {
    // Stored reconstruct, demonstrated 46 days ago → effective predict_break.
    setTier(db, "auth-flow", "reconstruct", daysBefore(46));
    const id = seed("auth-flow");

    const result = applyAnsweredQuestion(db, answeredFor(id, "nailed_it"), settings, NOW);

    expect(result.before).toBe("reconstruct");
    expect(result.effective).toBe("predict_break"); // decayed
    expect(result.after).toBe("reconstruct"); // demonstration UNDID the decay
    expect(getConcept(db, "auth-flow")?.tier).toBe("reconstruct");
  });

  it("mostly_there on a decayed concept holds the DECAYED tier, not the stored one", () => {
    setTier(db, "auth-flow", "reconstruct", daysBefore(46));
    const id = seed("auth-flow");
    applyAnsweredQuestion(db, answeredFor(id, "mostly_there"), settings, NOW);
    expect(getConcept(db, "auth-flow")?.tier).toBe("predict_break");
  });

  it("way_off on a decayed concept drops from the decayed tier, compounding once only", () => {
    setTier(db, "auth-flow", "reconstruct", daysBefore(46));
    const id = seed("auth-flow");
    applyAnsweredQuestion(db, answeredFor(id, "way_off"), settings, NOW);
    expect(getConcept(db, "auth-flow")?.tier).toBe("trace");
  });

  it("a skip changes nothing: not the tier, not the clock (§10.3)", () => {
    const demonstratedAt = daysBefore(10);
    setTier(db, "auth-flow", "trace", demonstratedAt);
    const before = JSON.stringify(getConcept(db, "auth-flow"));

    const id = seed("auth-flow");
    const result = applyAnsweredQuestion(db, answeredFor(id, null, true), settings, NOW);

    expect(result.after).toBeNull();
    expect(JSON.stringify(getConcept(db, "auth-flow"))).toBe(before);
  });

  it("assistance_level never affects a transition (§10.4)", () => {
    setTier(db, "auth-flow", "trace", daysBefore(1));
    const id = seed("auth-flow");
    const scaffolded: AnsweredQuestion = {
      ...answeredFor(id, "nailed_it"),
      assistance: "scaffolded",
    };
    applyAnsweredQuestion(db, scaffolded, settings, NOW);
    // Identical to the cold-answer outcome.
    expect(getConcept(db, "auth-flow")?.tier).toBe("predict_break");
  });

  it("an untagged question changes nothing", () => {
    const id = insertQuestion(db, {
      project_id: projectId,
      type: "trace",
      concept_tag: null,
      origin: "live",
      question_text: "q",
      sample_answer: "a",
      files: ["src/a.ts"],
    });
    expect(applyAnsweredQuestion(db, answeredFor(id, "nailed_it"), settings, NOW).after).toBeNull();
  });
});
