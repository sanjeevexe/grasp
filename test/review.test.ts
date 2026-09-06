/**
 * Review queue, stuck flow, and a scripted end-to-end session.
 * GOVERNED BY: §10.3, §10.4, §14, §16.5, §22.3 cases 11/12/14
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { closeDatabase, openDatabase } from "../src/storage/db.js";
import { insertProject } from "../src/storage/models/projects.js";
import { getQuestion, insertQuestion, type QuestionRow } from "../src/storage/models/questions.js";
import { setTier } from "../src/storage/models/concepts.js";
import { isExpired, orderQueue, partitionExpired } from "../src/review/queue.js";
import {
  furthest,
  initialStuckState,
  recordRetry,
  shouldAutoExplain,
  showCard,
  showHint,
  showScaffold,
} from "../src/review/stuckFlow.js";
import { runReviewSession } from "../src/review/reviewSession.js";
import type { ReviewInput, ReviewIo } from "../src/review/io.js";
import { acquireLock, isLockHandle } from "../src/util/lock.js";
import type { SelfAssessment } from "../src/types/index.js";

let db: DatabaseSync;
let dir: string;
let projectId: number;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "grasp-review-"));
  db = openDatabase({ file: path.join(dir, "history.db") });
  projectId = insertProject(db, "/repo/one").id;
});

afterEach(() => {
  closeDatabase(db);
  rmDir();
  vi.useRealTimers();
});

function rmDir(): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function seed(over: Partial<Parameters<typeof insertQuestion>[1]> = {}): number {
  return insertQuestion(db, {
    project_id: projectId,
    type: "trace",
    concept_tag: "debouncing",
    origin: "live",
    question_text: "How many times does setDebounced run?",
    sample_answer: "Once — each keystroke clears the previous timer.",
    hint: "Look at the cleanup.",
    scaffold: ["What does cleanup do?", "When does the effect re-run?"],
    code_snippet: "const t = setTimeout(fn, delay);",
    files: ["src/a.ts"],
    ...over,
  });
}

/** Drives a session from a fixed script, capturing everything written. */
function scriptedIo(
  inputs: ReviewInput[],
  assessments: (SelfAssessment | null)[] = [],
): ReviewIo & {
  output: string[];
  /** Everything printed before each prompt — the user's view at that moment. */
  promptSnapshots: string[];
  outputBefore(marker: string): string;
} {
  const output: string[] = [];
  const promptSnapshots: string[] = [];
  let inputIndex = 0;
  let assessmentIndex = 0;
  return {
    output,
    promptSnapshots,
    outputBefore(marker: string) {
      const joined = output.join("");
      const at = joined.indexOf(marker);
      return at === -1 ? joined : joined.slice(0, at);
    },
    write: (text) => void output.push(text),
    prompt: async () => {
      promptSnapshots.push(output.join(""));
      return inputs[inputIndex++] ?? { kind: "command", command: "quit" };
    },
    promptAssessment: async () => assessments[assessmentIndex++] ?? null,
    close: () => {},
  };
}

const answer = (text: string): ReviewInput => ({ kind: "answer", text });
const key = (
  command: ReviewInput extends { kind: "command"; command: infer C } ? C : never,
): ReviewInput => ({
  kind: "command",
  command,
});

describe("staleness (§14.3)", () => {
  const row = (createdAt: string): QuestionRow => ({ created_at: createdAt }) as QuestionRow;

  it("expires strictly past the window, not at it", () => {
    const now = new Date("2026-01-20T00:00:00.000Z");
    expect(isExpired(row("2026-01-06T00:00:00.000Z"), 14, now)).toBe(false); // exactly 14 days
    expect(isExpired(row("2026-01-05T23:00:00.000Z"), 14, now)).toBe(true);
    expect(isExpired(row("2026-01-19T00:00:00.000Z"), 14, now)).toBe(false);
  });

  it("null disables staleness entirely", () => {
    expect(isExpired(row("2020-01-01T00:00:00.000Z"), null, new Date())).toBe(false);
  });

  it("is computed at read time — nothing marks the row (§2.4)", () => {
    const id = seed();
    db.prepare("UPDATE questions SET created_at = ? WHERE id = ?").run(
      "2020-01-01T00:00:00.000Z",
      id,
    );
    const stored = getQuestion(db, id)!;
    expect(stored.status).toBe("pending"); // still pending in the database
    expect(isExpired(stored, 14)).toBe(true); // but expired when read
  });
});

describe("queue ordering (§14.2)", () => {
  function row(over: Partial<QuestionRow>): QuestionRow {
    return {
      id: 1,
      type: "trace",
      status: "pending",
      created_at: "2026-01-10T00:00:00.000Z",
      author_confidence: null,
      ...over,
    } as QuestionRow;
  }

  it("puts newest first", () => {
    const ordered = orderQueue(
      [
        row({ id: 1, created_at: "2026-01-01T00:00:00.000Z" }),
        row({ id: 2, created_at: "2026-01-09T00:00:00.000Z" }),
      ],
      { staleDays: null },
    );
    expect(ordered.map((q) => q.id)).toEqual([2, 1]);
  });

  it("puts synthesis checkpoints last however recent they are", () => {
    const ordered = orderQueue(
      [
        row({ id: 1, type: "synthesis", created_at: "2026-01-10T00:00:00.000Z" }),
        row({ id: 2, created_at: "2026-01-01T00:00:00.000Z" }),
      ],
      { staleDays: null },
    );
    expect(ordered.map((q) => q.id)).toEqual([2, 1]);
  });

  it("sorts lower authorship confidence later within a timestamp bucket (§7.6)", () => {
    const ordered = orderQueue(
      [row({ id: 1, author_confidence: 0.2 }), row({ id: 2, author_confidence: 0.9 })],
      { staleDays: null },
    );
    expect(ordered.map((q) => q.id)).toEqual([2, 1]);
  });

  it("hides expired questions by default and shows them under --all", () => {
    // Pinned: the fixture dates are fixed, so "now" must be too (§22.1).
    const now = new Date("2026-01-12T00:00:00.000Z");
    const stale = row({ id: 1, created_at: "2020-01-01T00:00:00.000Z" });
    const fresh = row({ id: 2 });
    expect(orderQueue([stale, fresh], { staleDays: 14, now }).map((q) => q.id)).toEqual([2]);
    expect(
      orderQueue([stale, fresh], { staleDays: 14, now, includeExpired: true }).map((q) => q.id),
    ).toEqual([2, 1]);
  });

  it("never surfaces answered or skipped questions", () => {
    const ordered = orderQueue(
      [row({ id: 1, status: "answered" }), row({ id: 2, status: "skipped" }), row({ id: 3 })],
      { staleDays: null },
    );
    expect(ordered.map((q) => q.id)).toEqual([3]);
  });

  it("partitions live from expired for the summary line", () => {
    const { live, expired } = partitionExpired(
      [row({ id: 1, created_at: "2020-01-01T00:00:00.000Z" }), row({ id: 2 })],
      14,
      new Date("2026-01-12T00:00:00.000Z"),
    );
    expect(live.map((q) => q.id)).toEqual([2]);
    expect(expired.map((q) => q.id)).toEqual([1]);
  });
});

describe("stuck flow (§10.4)", () => {
  it("tracks the FURTHEST rung reached, never going backwards", () => {
    let state = initialStuckState();
    expect(state.level).toBe("none");
    state = showHint(state);
    expect(state.level).toBe("hint");
    state = recordRetry(state);
    expect(state.level).toBe("retry");
    state = showScaffold(state);
    expect(state.level).toBe("scaffolded");
    // Showing the card again does not demote the recorded level.
    state = showCard(state);
    expect(state.level).toBe("scaffolded");
  });

  it("orders the rungs none < hint < retry < scaffolded", () => {
    expect(furthest("none", "hint")).toBe("hint");
    expect(furthest("scaffolded", "hint")).toBe("scaffolded");
    expect(furthest("retry", "retry")).toBe("retry");
  });

  it("auto-explains only after the hint and the retry are spent (§10.4 step 3)", () => {
    let state = initialStuckState();
    expect(shouldAutoExplain(state)).toBe(false);
    state = showHint(state);
    expect(shouldAutoExplain(state)).toBe(false);
    state = recordRetry(state);
    expect(shouldAutoExplain(state)).toBe(true);
    state = showCard(state);
    expect(shouldAutoExplain(state)).toBe(false); // not twice
  });
});

describe("scripted session (§22.3 case 11)", () => {
  it("persists the answer, assessment, assistance level, and answered_at", async () => {
    const id = seed();
    const io = scriptedIo([key("hint"), answer("my answer")], ["nailed_it"]);
    const result = await runReviewSession([getQuestion(db, id)!], { db, io });

    const row = getQuestion(db, id)!;
    expect(row.status).toBe("answered");
    expect(row.self_assessment).toBe("nailed_it");
    expect(row.user_answer).toBe("my answer");
    expect(row.answered_at).toBeTruthy();
    // Hint taken before answering: the furthest rung was "hint".
    expect(row.assistance_level).toBe("hint");
    expect(result.quit).toBe(false);
  });

  it("records `scaffolded` when the user breaks the question down", async () => {
    const id = seed();
    const io = scriptedIo([key("hint"), key("breakdown"), answer("ok")], ["mostly_there"]);
    await runReviewSession([getQuestion(db, id)!], { db, io });
    expect(getQuestion(db, id)!.assistance_level).toBe("scaffolded");
    expect(io.output.join("")).toMatch(/BREAK IT DOWN/);
  });

  it("an explicit skip changes nothing but status (§10.3)", async () => {
    const id = seed();
    const io = scriptedIo([key("skip")]);
    await runReviewSession([getQuestion(db, id)!], { db, io });

    const row = getQuestion(db, id)!;
    expect(row.status).toBe("skipped");
    expect(row.self_assessment).toBeNull();
    expect(row.user_answer).toBeNull();
  });

  it("quitting keeps earlier answers and leaves the rest pending (§14.4)", async () => {
    const first = seed();
    const second = seed();
    const io = scriptedIo([answer("done"), key("quit")], ["nailed_it"]);
    const result = await runReviewSession([getQuestion(db, first)!, getQuestion(db, second)!], {
      db,
      io,
    });

    expect(result.quit).toBe(true);
    expect(getQuestion(db, first)!.status).toBe("answered");
    expect(getQuestion(db, second)!.status).toBe("pending");
  });

  it("never inspects the answer — any text is accepted (§2.1)", async () => {
    const id = seed();
    const io = scriptedIo([answer("completely wrong nonsense")], ["nailed_it"]);
    await runReviewSession([getQuestion(db, id)!], { db, io });
    const row = getQuestion(db, id)!;
    expect(row.self_assessment).toBe("nailed_it"); // the user's word is final
    expect(row.user_answer).toBe("completely wrong nonsense");
  });

  it("way_off auto-shows the concept explanation (§10.3)", async () => {
    const id = seed({ teaching_card_text: "Debouncing delays an action." });
    setTier(db, "debouncing", "trace", new Date().toISOString());
    const io = scriptedIo([answer("no idea")], ["way_off"]);
    await runReviewSession([getQuestion(db, id)!], { db, io });
    expect(io.output.join("")).toMatch(/Debouncing delays an action/);
  });

  it("shows the card up front only at mastery none (§10.2)", async () => {
    const id = seed({ teaching_card_text: "Card body here." });
    setTier(db, "debouncing", "predict_break", new Date().toISOString());
    const io = scriptedIo([answer("x")], ["mostly_there"]);
    await runReviewSession([getQuestion(db, id)!], { db, io });
    expect(io.outputBefore("SAMPLE ANSWER")).not.toMatch(/Card body here/);
  });

  it("keeps the card reachable with [e] at any mastery (§10.2)", async () => {
    const id = seed({ teaching_card_text: "Card body here." });
    setTier(db, "debouncing", "reconstruct", new Date().toISOString());
    const io = scriptedIo([key("explain"), answer("x")], ["mostly_there"]);
    await runReviewSession([getQuestion(db, id)!], { db, io });
    expect(io.outputBefore("SAMPLE ANSWER")).toMatch(/Card body here/);
  });
});

describe("reconstruct hides the code (§22.3 case 12)", () => {
  it("does not emit code_snippet before the answer is submitted", async () => {
    const id = seed({
      type: "reconstruct",
      code_snippet: "SECRET_IMPLEMENTATION_MARKER",
      scaffold: ["design step one", "design step two"],
    });
    const io = scriptedIo([key("hint"), key("breakdown"), answer("my approach")], ["mostly_there"]);
    await runReviewSession([getQuestion(db, id)!], { db, io });

    // Everything the user could see at every point before they answered — the
    // hint and the full scaffold included — must be free of the code.
    for (const snapshot of io.promptSnapshots) {
      expect(snapshot).not.toContain("SECRET_IMPLEMENTATION_MARKER");
    }
    // ...and it appears once the attempt is over, alongside the sample answer.
    expect(io.output.join("")).toContain("SECRET_IMPLEMENTATION_MARKER");
  });

  it("still hides the code when the user skips", async () => {
    const id = seed({ type: "reconstruct", code_snippet: "SECRET_IMPLEMENTATION_MARKER" });
    const io = scriptedIo([key("skip")]);
    await runReviewSession([getQuestion(db, id)!], { db, io });
    expect(io.output.join("")).not.toContain("SECRET_IMPLEMENTATION_MARKER");
  });

  it("shows the code up front for non-reconstruct tiers", async () => {
    const id = seed({ code_snippet: "VISIBLE_CODE" });
    const io = scriptedIo([answer("x")], ["nailed_it"]);
    await runReviewSession([getQuestion(db, id)!], { db, io });
    expect(io.outputBefore("SAMPLE ANSWER")).toContain("VISIBLE_CODE");
  });
});

describe("review lock (§16.5, §22.3 case 14)", () => {
  it("refuses a second holder", () => {
    const file = path.join(dir, "review.lock");
    const first = acquireLock(file);
    expect(isLockHandle(first)).toBe(true);

    const second = acquireLock(file);
    expect(isLockHandle(second)).toBe(false);
    if (!isLockHandle(second)) expect(second.held.pid).toBe(process.pid);

    if (isLockHandle(first)) first.release();
    expect(fs.existsSync(file)).toBe(false);
  });

  it("takes over a lock older than 30 minutes", () => {
    const file = path.join(dir, "review.lock");
    fs.writeFileSync(
      file,
      JSON.stringify({
        pid: process.pid,
        acquiredAt: new Date(Date.now() - 31 * 60_000).toISOString(),
      }),
    );
    expect(isLockHandle(acquireLock(file))).toBe(true);
  });

  it("takes over a lock whose process is gone", () => {
    const file = path.join(dir, "review.lock");
    // PID 2^31-1 is not a running process on any platform we support.
    fs.writeFileSync(
      file,
      JSON.stringify({ pid: 2147483647, acquiredAt: new Date().toISOString() }),
    );
    expect(isLockHandle(acquireLock(file))).toBe(true);
  });

  it("treats a corrupt lock file as stale rather than jamming forever", () => {
    const file = path.join(dir, "review.lock");
    fs.writeFileSync(file, "not json");
    expect(isLockHandle(acquireLock(file))).toBe(true);
  });
});
