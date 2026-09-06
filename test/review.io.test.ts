/**
 * The review keyboard, driven through real pipes.  GOVERNED BY: §14.4, §10.4
 *
 * These exist because the scripted-IO tests cannot see this layer at all, and
 * that blind spot shipped three bugs: the self-assessment resolving as a quit,
 * line mode swallowing every keybind, and a command key firing from the first
 * character of an ordinary answer.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { closeDatabase, openDatabase } from "../src/storage/db.js";
import { insertProject } from "../src/storage/models/projects.js";
import {
  getQuestion,
  insertQuestion,
  listPendingQuestions,
} from "../src/storage/models/questions.js";
import { createTerminalIo, type ReviewInput } from "../src/review/io.js";
import { DEFAULT_REVIEW_KEYS, formatBinding } from "../src/review/keys.js";
import { runReviewSession } from "../src/review/reviewSession.js";

const ESC = String.fromCharCode(27);
const CR = String.fromCharCode(13);
const ctrl = (letter: string): string =>
  String.fromCharCode(letter.toUpperCase().charCodeAt(0) - 64);

interface Harness {
  io: ReturnType<typeof createTerminalIo>;
  send(keys: string): void;
  output(): string;
  end(): void;
}

/** A pipe that claims to be a TTY, which is how readline behaves live. */
function harness(keys?: Record<string, string>): Harness {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {} });
  const output = new PassThrough();
  const chunks: string[] = [];
  output.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
  return {
    io: createTerminalIo({
      input: input as never,
      output: output as never,
      keys: keys as never,
    }),
    send: (keys) => void input.write(keys),
    output: () => chunks.join(""),
    end: () => input.end(),
  };
}

/** Resolves the prompt, or reports that it is still waiting. */
async function settle(promise: Promise<ReviewInput>, ms = 400): Promise<ReviewInput | "waiting"> {
  return Promise.race([
    promise,
    new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), ms)),
  ]);
}

describe("Ctrl+letter commands fire immediately, with no Enter (§14.4)", () => {
  it.each([
    ["t", "hint"],
    ["e", "explain"],
    ["r", "deeper"],
    ["k", "breakdown"],
    ["n", "skip"],
    ["c", "quit"],
  ])("Ctrl+%s fires %s on the keypress alone", async (letter, command) => {
    const h = harness();
    const promise = h.io.prompt();
    h.send(ctrl(letter));
    await expect(settle(promise)).resolves.toEqual({ kind: "command", command });
  });

  it("fires mid-answer too — there is no empty-buffer rule any more", async () => {
    const h = harness();
    const promise = h.io.prompt();
    h.send("half an answer" + ctrl("k"));
    await expect(settle(promise)).resolves.toEqual({ kind: "command", command: "breakdown" });
  });
});

describe("submitting (§14.4)", () => {
  it("a single Enter submits — no blank-line convention", async () => {
    const h = harness();
    const promise = h.io.prompt();
    h.send("once" + CR);
    await expect(settle(promise)).resolves.toEqual({ kind: "answer", text: "once" });
  });

  it("Enter on an empty line does nothing", async () => {
    const h = harness();
    const promise = h.io.prompt();
    h.send(CR + CR);
    await expect(settle(promise, 150)).resolves.toBe("waiting");
  });

  it("Alt+Enter inserts a newline, so multi-line answers still work", async () => {
    const h = harness();
    const promise = h.io.prompt();
    h.send("first line" + ESC + CR + "second line" + CR);
    await expect(settle(promise)).resolves.toEqual({
      kind: "answer",
      text: "first line\nsecond line",
    });
  });

  it("backspace edits the buffer", async () => {
    const h = harness();
    const promise = h.io.prompt();
    h.send("tyop" + String.fromCharCode(127) + String.fromCharCode(127) + "po" + CR);
    await expect(settle(promise)).resolves.toEqual({ kind: "answer", text: "typo" });
  });

  it("echoes what is typed so the user can see their answer", async () => {
    const h = harness();
    const promise = h.io.prompt();
    h.send("visible" + CR);
    await settle(promise);
    expect(h.output()).toContain("visible");
  });
});

describe("reserved keys are never bound (§14.4)", () => {
  it.each([
    ["Ctrl+S — XON/XOFF; bound to skip it would freeze the terminal", ctrl("s")],
    ["Ctrl+Q — XON/XOFF", ctrl("q")],
    ["Ctrl+Z — suspend", ctrl("z")],
    ["Ctrl+B — tmux's default prefix, swallowed before we see it", ctrl("b")],
    ["Ctrl+A — GNU screen's default prefix", ctrl("a")],
  ])("%s is inert", async (_label, key) => {
    const h = harness();
    const promise = h.io.prompt();
    h.send(key);
    await expect(settle(promise, 150)).resolves.toBe("waiting");
  });

  it("does not insert a control character into the answer either", async () => {
    const h = harness();
    const promise = h.io.prompt();
    h.send(ctrl("s") + ctrl("z") + ctrl("b") + "clean" + CR);
    await expect(settle(promise)).resolves.toEqual({ kind: "answer", text: "clean" });
  });

  it("Ctrl+H, Ctrl+I, Ctrl+J and Ctrl+M are Backspace, Tab, Enter and Return", async () => {
    // Not a policy choice: a terminal cannot distinguish them, so binding one
    // would also fire on the ordinary key. Ctrl+H edits rather than hinting.
    const h = harness();
    const promise = h.io.prompt();
    h.send("ab" + ctrl("h") + CR);
    await expect(settle(promise)).resolves.toEqual({ kind: "answer", text: "a" });

    // Ctrl+M is indistinguishable from Enter, so it submits.
    const second = harness();
    const secondPromise = second.io.prompt();
    second.send("done" + ctrl("m"));
    await expect(settle(secondPromise)).resolves.toEqual({ kind: "answer", text: "done" });
  });

  it("Ctrl+C is the documented quit (§14.4)", async () => {
    const h = harness();
    const promise = h.io.prompt();
    h.send(ctrl("c"));
    await expect(settle(promise)).resolves.toEqual({ kind: "command", command: "quit" });
  });

  it("Ctrl+D on an empty line ends the session, but edits text otherwise", async () => {
    const empty = harness();
    const first = empty.io.prompt();
    empty.send(ctrl("d"));
    await expect(settle(first)).resolves.toEqual({ kind: "command", command: "quit" });

    const typed = harness();
    const second = typed.io.prompt();
    typed.send("text" + ctrl("d"));
    await expect(settle(second, 150)).resolves.toBe("waiting");
  });

  it("treats a closed stream as a quit, losing nothing", async () => {
    const h = harness();
    const promise = h.io.prompt();
    h.end();
    await expect(settle(promise)).resolves.toEqual({ kind: "command", command: "quit" });
  });
});

describe("self-assessment keys (§10.3)", () => {
  it.each([
    ["1", "nailed_it"],
    ["2", "mostly_there"],
    ["3", "way_off"],
  ])("%s records %s on the keypress alone", async (key, expected) => {
    const h = harness();
    const promise = h.io.promptAssessment();
    h.send(key);
    await expect(promise).resolves.toBe(expected);
  });

  it("re-prompts on anything else rather than taking it as an answer", async () => {
    const h = harness();
    const promise = h.io.promptAssessment();
    h.send("7");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.output()).toMatch(/Enter 1, 2, or 3/);
    h.send("2");
    await expect(promise).resolves.toBe("mostly_there");
  });

  it("returns null when the user quits at the prompt", async () => {
    const h = harness();
    const promise = h.io.promptAssessment();
    h.send(ctrl("c"));
    await expect(promise).resolves.toBeNull();
  });
});

describe("the key hint line (§14.4)", () => {
  it("spells the modifier out for every command", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "grasp-hints-"));
    process.env.HOME = home;
    const db = openDatabase({ file: path.join(home, "history.db") });
    const projectId = insertProject(db, "/repo/hints").id;
    insertQuestion(db, {
      project_id: projectId,
      type: "trace",
      concept_tag: "c",
      origin: "live",
      question_text: "q",
      sample_answer: "a",
      hint: "h",
      teaching_card_deeper: "more",
      teaching_card_text: "card",
      scaffold: ["one", "two"],
      files: ["src/a.ts"],
    });

    const h = harness();
    const session = runReviewSession(listPendingQuestions(db, projectId), { db, io: h.io });
    setTimeout(() => h.send(ctrl("c")), 30);
    await session;

    const printed = h.output();
    for (const binding of [
      "Ctrl+T hint",
      "Ctrl+E explain",
      "Ctrl+R deeper",
      "Ctrl+K break it down",
      "Ctrl+N skip",
      "Ctrl+C quit",
    ]) {
      expect(printed).toContain(binding);
    }
    // Nothing is left to memory, and no bare-letter form survives.
    expect(printed).not.toMatch(/\[e\] explain|\[s\] skip|\[q\] quit/);
    expect(printed).toContain("Alt+Enter");

    closeDatabase(db);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe("a session driven by real keystrokes", () => {
  let db: DatabaseSync;
  let home: string;
  let projectId: number;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "grasp-keys-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    db = openDatabase({ file: path.join(home, "history.db") });
    projectId = insertProject(db, "/repo/one").id;
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(home, { recursive: true, force: true });
  });

  function seedThree(): number[] {
    return (["reconstruct", "predict_break", "trace"] as const).map((type) =>
      insertQuestion(db, {
        project_id: projectId,
        type,
        concept_tag: `concept-${type}`,
        origin: "live",
        question_text: `${type} question`,
        sample_answer: "the sample answer",
        hint: "the one hint",
        teaching_card_text: "the concept card",
        scaffold: ["step one", "step two"],
        code_snippet: "const x = 1;",
        files: ["src/a.ts"],
      }),
    );
  }

  it("QUITTING WITHOUT ANSWERING LEAVES THE QUEUE UNTOUCHED (§14.4)", async () => {
    const ids = seedThree();
    const before = listPendingQuestions(db, projectId).map((q) => q.id);

    const h = harness();
    const session = runReviewSession(listPendingQuestions(db, projectId), { db, io: h.io });
    // Open the first question, look at it, and leave.
    setTimeout(() => h.send(ctrl("c")), 20);
    const result = await session;

    expect(result.quit).toBe(true);
    expect(result.answered).toHaveLength(0);
    // Nothing was consumed: same questions, same statuses.
    expect(listPendingQuestions(db, projectId).map((q) => q.id)).toEqual(before);
    for (const id of ids) expect(getQuestion(db, id)!.status).toBe("pending");
  });

  it("leaves the queue untouched when the stream just closes", async () => {
    const ids = seedThree();
    const h = harness();
    const session = runReviewSession(listPendingQuestions(db, projectId), { db, io: h.io });
    setTimeout(() => h.end(), 20);
    await session;
    for (const id of ids) expect(getQuestion(db, id)!.status).toBe("pending");
  });

  it("leaves the question pending when the user quits at the assessment prompt", async () => {
    const ids = seedThree();
    const h = harness();
    const session = runReviewSession(listPendingQuestions(db, projectId), { db, io: h.io });
    // Answer, read the sample answer, then leave without self-assessing.
    setTimeout(() => h.send("my answer" + CR), 20);
    setTimeout(() => h.send(ctrl("c")), 120);
    const result = await session;

    expect(result.quit).toBe(true);
    // §10.3 — no self-assessment means no record and no progression.
    for (const id of ids) expect(getQuestion(db, id)!.status).toBe("pending");
  });

  it("an answer that begins with a command letter is not a skip", async () => {
    const ids = seedThree();
    const h = harness();
    const session = runReviewSession(listPendingQuestions(db, projectId), { db, io: h.io });
    // Bare letters are text, so this is an answer and not a skip (§14.4).
    setTimeout(() => h.send("skip the cache entirely" + CR), 20);
    setTimeout(() => h.send("2"), 140);
    setTimeout(() => h.send(ctrl("c")), 260);
    await session;

    const answered = getQuestion(db, ids[2])!; // newest first: the trace question
    expect(answered.status).toBe("answered");
    expect(answered.user_answer).toBe("skip the cache entirely");
  });

  it("the hint key escalates instead of reprinting (§10.4)", async () => {
    seedThree();
    const h = harness();
    const session = runReviewSession(listPendingQuestions(db, projectId), { db, io: h.io });
    setTimeout(() => h.send(ctrl("t")), 20);
    setTimeout(() => h.send(ctrl("t")), 120);
    setTimeout(() => h.send(ctrl("t")), 220);
    setTimeout(() => h.send(ctrl("c")), 320);
    await session;

    const printed = h.output();
    // The hint appears once, not once per press.
    expect(printed.match(/the one hint/g) ?? []).toHaveLength(1);
    // The second press moved on to the concept card instead.
    expect(printed).toContain("the concept card");
    expect(printed).toMatch(/that is the whole hint/);
    expect(printed).toContain("Ctrl+K");
  });
});

describe("bindings are configurable (§14.4, §18.1)", () => {
  it("fires a rebound key and ignores the default it replaced", async () => {
    const keys = { ...DEFAULT_REVIEW_KEYS, hint: "ctrl+y" };
    const h = harness(keys);
    const rebound = h.io.prompt();
    h.send(ctrl("y"));
    await expect(settle(rebound)).resolves.toEqual({ kind: "command", command: "hint" });

    const stale = harness(keys);
    const ignored = stale.io.prompt();
    stale.send(ctrl("t"));
    await expect(settle(ignored, 150)).resolves.toBe("waiting");
  });

  it("Ctrl+C quits even if the bindings are nonsense — no way to get stuck", async () => {
    // A map that binds nothing usable at all.
    const keys = { ...DEFAULT_REVIEW_KEYS, quit: "ctrl+y" };
    const h = harness(keys);
    const promise = h.io.prompt();
    h.send(ctrl("c"));
    await expect(settle(promise)).resolves.toEqual({ kind: "command", command: "quit" });
  });

  it("labels the key hint line from the live bindings, not from the defaults", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "grasp-rebind-"));
    process.env.HOME = home;
    const db = openDatabase({ file: path.join(home, "history.db") });
    const projectId = insertProject(db, "/repo/rebind").id;
    insertQuestion(db, {
      project_id: projectId,
      type: "trace",
      concept_tag: "c",
      origin: "live",
      question_text: "q",
      sample_answer: "a",
      hint: "h",
      scaffold: ["one", "two"],
      files: ["src/a.ts"],
    });

    const keys = { ...DEFAULT_REVIEW_KEYS, hint: "ctrl+y", skip: "ctrl+p" };
    const h = harness(keys);
    const session = runReviewSession(listPendingQuestions(db, projectId), { db, io: h.io, keys });
    setTimeout(() => h.send(ctrl("c")), 30);
    await session;

    expect(h.output()).toContain("Ctrl+Y hint");
    expect(h.output()).toContain("Ctrl+P skip");
    expect(h.output()).not.toContain("Ctrl+T hint");

    closeDatabase(db);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe("an unbound action is shown as such, not hidden (§14.4)", () => {
  it("labels it (unbound) and does not fire on its old default", async () => {
    const keys = { ...DEFAULT_REVIEW_KEYS, breakdown: "" };
    const h = harness(keys);
    const promise = h.io.prompt();
    h.send(ctrl("k"));
    await expect(settle(promise, 150)).resolves.toBe("waiting");
    expect(formatBinding("")).toBe("(unbound)");
  });
});
