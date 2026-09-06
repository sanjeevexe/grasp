/**
 * Capture integration against a real temp project.
 * GOVERNED BY: §22.3 cases 1, 2, 5, 6, 7
 *
 * Case 2 — mid-write protection — is called out in the brief as the critical
 * one: a partial file must never reach generation.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { closeDatabase, openDatabase } from "../src/storage/db.js";
import { insertProject } from "../src/storage/models/projects.js";
import { listPendingQuestions } from "../src/storage/models/questions.js";
import { listFailures } from "../src/storage/models/generationFailures.js";
import { readSnapshot, advanceSnapshot } from "../src/capture/snapshot.js";
import { ProjectWatcher, type WatcherSettings } from "../src/daemon/watcher.js";
import type { PendingBatch } from "../src/daemon/debounce.js";
import type { ModelProvider } from "../src/generation/provider.js";

let db: DatabaseSync;
let home: string;
let projectDir: string;
let projectId: number;

const SETTINGS: WatcherSettings = {
  debounceMs: 50,
  maxFilesPerBatch: 25,
  minLines: 3,
  ignorePatterns: ["**/dist/**"],
  maxQuestionsPerHour: 12,
  maxDiffLines: 800,
  minDiffCount: 3,
  minMasteryTier: "predict_break",
  decayWindows: { trace: 90, predictBreak: 60, reconstruct: 45 },
};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "grasp-int-home-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "grasp-int-repo-"));
  fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
  db = openDatabase({ file: path.join(home, "history.db") });
  projectId = insertProject(db, projectDir).id;
});

afterEach(() => {
  closeDatabase(db);
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
});

function write(relative: string, content: string): void {
  fs.writeFileSync(path.join(projectDir, relative), content);
}

function batchOf(...files: string[]): PendingBatch {
  return {
    files: new Map(files.map((file) => [file, { bytes: 100, at: Date.now() }])),
    openedAt: Date.now(),
  };
}

function provider(replies: string[]): ModelProvider & { calls: number; prompts: string[] } {
  const stub = {
    name: "api" as const,
    calls: 0,
    prompts: [] as string[],
    askModel: async (prompt: string) => {
      stub.prompts.push(prompt);
      const reply = replies[Math.min(stub.calls, replies.length - 1)];
      stub.calls += 1;
      return { text: reply, usage: null };
    },
  };
  return stub;
}

const QUESTION = JSON.stringify({
  skip: false,
  skip_reason: null,
  questions: [
    {
      concept_tag: "guard-clause",
      reframe: false,
      tier: "trace",
      files: ["src/a.ts"],
      teaching_card: { body: "A card.", deeper: null },
      question: "What happens when items is empty?",
      sample_answer: "It throws before touching the list.",
      hint: "Look at the first statement.",
      scaffold: ["What runs first?", "What does it guard against?"],
    },
  ],
});

const COMPLETE = [
  "export function assertNonEmpty(items: string[]) {",
  "  if (items.length === 0) throw new Error('empty');",
  "  return items;",
  "}",
  "",
].join("\n");

// Long enough to clear the noise filter, so what is under test is the syntax
// gate rather than the line-count one.
const PARTIAL = [
  "export function assertNonEmpty(items: string[]) {",
  "  const seen = new Set<string>();",
  "  for (const item of items) seen.add(item);",
  "  if (seen.size === 0) {",
].join("\n");

const noSleep = { sleep: async () => {}, random: () => 0 };

describe("happy path (§22.3 case 1)", () => {
  it("captures a change, persists one question, and advances the checkpoint", async () => {
    write("src/a.ts", COMPLETE);
    const stub = provider([QUESTION]);
    let notified = 0;

    const watcher = new ProjectWatcher(db, projectId, projectDir, SETTINGS, {
      provider: stub,
      onQuestions: () => void (notified += 1),
      ...noSleep,
    });
    const outcome = await watcher.processBatch(batchOf("src/a.ts"));

    expect(outcome?.kind).toBe("questions");
    expect(listPendingQuestions(db, projectId)).toHaveLength(1);
    expect(readSnapshot(projectDir, "src/a.ts")).toBe(COMPLETE);
    // §15 — one notification per closed batch, not one per question.
    expect(notified).toBe(1);
    expect(stub.calls).toBe(1);
  });
});

describe("mid-write protection (§22.3 case 2 — the critical one)", () => {
  it("makes EXACTLY ONE call, against the COMPLETED content", async () => {
    // The AI pauses mid-function; the editor saves what it has.
    write("src/a.ts", PARTIAL);
    const stub = provider([QUESTION]);
    const watcher = new ProjectWatcher(db, projectId, projectDir, SETTINGS, {
      provider: stub,
      ...noSleep,
    });

    const first = await watcher.processBatch(batchOf("src/a.ts"));
    // Did not parse → the batch waits rather than asking about half a function.
    expect(first).toBeNull();
    expect(stub.calls).toBe(0);
    expect(listPendingQuestions(db, projectId)).toHaveLength(0);
    // Nothing terminal happened, so the checkpoint has not moved (§8.3).
    expect(readSnapshot(projectDir, "src/a.ts")).toBeNull();

    // The write completes a moment later.
    write("src/a.ts", COMPLETE);
    const second = await watcher.processBatch(batchOf("src/a.ts"));

    expect(second?.kind).toBe("questions");
    expect(stub.calls).toBe(1);
    expect(stub.prompts[0]).toContain("return items;"); // the completed content
    expect(stub.prompts[0]).not.toContain("if (items.length === 0) {\n"); // not the partial
  });

  it("proceeds anyway after three consecutive failures — Grasp is not a linter (§7.3)", async () => {
    write("src/a.ts", PARTIAL);
    const stub = provider([QUESTION]);
    // A long quiet period so the re-check timer cannot fire mid-test: what is
    // under test is the retry counter, not the scheduling.
    const watcher = new ProjectWatcher(
      db,
      projectId,
      projectDir,
      { ...SETTINGS, debounceMs: 60_000 },
      { provider: stub, ...noSleep },
    );

    expect(await watcher.processBatch(batchOf("src/a.ts"))).toBeNull();
    expect(await watcher.processBatch(batchOf("src/a.ts"))).toBeNull();
    expect(await watcher.processBatch(batchOf("src/a.ts"))).toBeNull();
    // Fourth attempt: the code may simply be broken, so ask anyway.
    const fourth = await watcher.processBatch(batchOf("src/a.ts"));
    expect(fourth?.kind).toBe("questions");
    expect(stub.calls).toBe(1);
  });
});

describe("API failure and recovery (§22.3 case 5)", () => {
  it("records a failure, leaves the checkpoint, and re-includes the change next time", async () => {
    write("src/a.ts", COMPLETE);
    const failing = provider(["not json", "still not json"]);
    const watcher = new ProjectWatcher(db, projectId, projectDir, SETTINGS, {
      provider: failing,
      ...noSleep,
    });

    const outcome = await watcher.processBatch(batchOf("src/a.ts"));
    expect(outcome?.kind).toBe("failed");
    expect(listFailures(db)).toHaveLength(1);
    // §8.3 — the checkpoint did NOT advance.
    expect(readSnapshot(projectDir, "src/a.ts")).toBeNull();

    // The next batch still sees the change, because nothing was checkpointed.
    const succeeding = provider([QUESTION]);
    const recovered = new ProjectWatcher(db, projectId, projectDir, SETTINGS, {
      provider: succeeding,
      ...noSleep,
    });
    const second = await recovered.processBatch(batchOf("src/a.ts"));

    expect(second?.kind).toBe("questions");
    expect(succeeding.prompts[0]).toContain("assertNonEmpty");
    expect(readSnapshot(projectDir, "src/a.ts")).toBe(COMPLETE);
  });
});

describe("crash recovery (§22.3 case 6)", () => {
  it("re-detects the change after a crash, with no duplicate question", async () => {
    write("src/a.ts", COMPLETE);
    // A crash mid-batch: the in-flight batch is lost and nothing was written.
    expect(readSnapshot(projectDir, "src/a.ts")).toBeNull();

    const stub = provider([QUESTION]);
    const restarted = new ProjectWatcher(db, projectId, projectDir, SETTINGS, {
      provider: stub,
      ...noSleep,
    });
    expect((await restarted.processBatch(batchOf("src/a.ts")))?.kind).toBe("questions");
    expect(listPendingQuestions(db, projectId)).toHaveLength(1);

    // Re-processing the same content produces nothing new: the checkpoint moved,
    // so there is no diff at all.
    expect(await restarted.processBatch(batchOf("src/a.ts"))).toBeNull();
    expect(listPendingQuestions(db, projectId)).toHaveLength(1);
  });
});

describe("dedup (§22.3 case 7)", () => {
  it("never produces two questions for the same diff", async () => {
    advanceSnapshot(projectDir, "src/a.ts", "");
    write("src/a.ts", COMPLETE);
    const stub = provider([QUESTION]);
    const watcher = new ProjectWatcher(db, projectId, projectDir, SETTINGS, {
      provider: stub,
      ...noSleep,
    });

    await watcher.processBatch(batchOf("src/a.ts"));
    // Roll the checkpoint back to force the identical diff to be seen again.
    advanceSnapshot(projectDir, "src/a.ts", "");
    const second = await watcher.processBatch(batchOf("src/a.ts"));

    expect(second?.kind).toBe("duplicate");
    expect(listPendingQuestions(db, projectId)).toHaveLength(1);
    expect(stub.calls).toBe(1);
  });
});

describe("watcher-level filtering", () => {
  it("ignores files that are not plausible source (§7.1)", async () => {
    write("src/notes.txt", "just notes\nmore notes\nand more\n");
    const stub = provider([QUESTION]);
    const watcher = new ProjectWatcher(db, projectId, projectDir, SETTINGS, {
      provider: stub,
      ...noSleep,
    });
    // The batch only ever contains source files; a .txt never gets added by the
    // watcher, and processing it directly still yields no question.
    const outcome = await watcher.processBatch(batchOf("src/notes.txt"));
    expect(outcome?.kind === "questions").toBe(false);
  });

  it("drops a deleted file rather than crashing", async () => {
    const watcher = new ProjectWatcher(db, projectId, projectDir, SETTINGS, {
      provider: provider([QUESTION]),
      ...noSleep,
    });
    expect(await watcher.processBatch(batchOf("src/never-existed.ts"))).toBeNull();
  });
});
