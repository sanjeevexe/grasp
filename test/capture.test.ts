/**
 * Snapshot/diff, the meaningful-diff filter, rate limiting, and the checkpoint
 * advance rule.  GOVERNED BY: §5.5, §7.5, §7.6, §8.1–§8.3, §22.2, §22.3
 *
 * §8.3 is the first of the four verify-deliberately items: advance if and only
 * if the batch reached a terminal state.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { closeDatabase, openDatabase } from "../src/storage/db.js";
import { insertProject } from "../src/storage/models/projects.js";
import { insertQuestion, listPendingQuestions } from "../src/storage/models/questions.js";
import { listFailures } from "../src/storage/models/generationFailures.js";
import { setTier } from "../src/storage/models/concepts.js";
import {
  advanceSnapshot,
  clearSnapshots,
  diffAgainstSnapshot,
  hashDiff,
  populateSnapshot,
  readSnapshot,
  snapshotDirFor,
  type FileDiff,
} from "../src/capture/snapshot.js";
import { filterDiffs, isImportReorderOnly, isWhitespaceOnly } from "../src/capture/diffFilter.js";
import { estimateAuthorConfidence } from "../src/capture/authorHeuristics.js";
import { countDiffLines, decide, questionsInLastHour } from "../src/capture/rateLimit.js";
import { runPipeline, type PipelineSettings } from "../src/daemon/pipeline.js";
import type { ModelProvider } from "../src/generation/provider.js";

const PROJECT = "/repo/one";

const SETTINGS: PipelineSettings = {
  minLines: 3,
  ignorePatterns: ["**/dist/**", "**/*.lock"],
  maxQuestionsPerHour: 12,
  maxDiffLines: 800,
  minDiffCount: 3,
  minMasteryTier: "predict_break",
  decayWindows: { trace: 90, predictBreak: 60, reconstruct: 45 },
};

let db: DatabaseSync;
let dir: string;
let projectId: number;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "grasp-capture-"));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  db = openDatabase({ file: path.join(dir, "history.db") });
  projectId = insertProject(db, PROJECT).id;
});

afterEach(() => {
  closeDatabase(db);
  fs.rmSync(dir, { recursive: true, force: true });
});

function fileDiff(over: Partial<FileDiff> = {}): FileDiff {
  return {
    path: "src/a.ts",
    diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,4 @@\n+const a = 1;\n+const b = 2;\n+const c = 3;\n",
    content: "const a = 1;\nconst b = 2;\nconst c = 3;\n",
    added: 3,
    removed: 0,
    isNew: false,
    ...over,
  };
}

function provider(replies: string[]): ModelProvider & { calls: number } {
  const stub = {
    name: "api" as const,
    calls: 0,
    askModel: async () => {
      const reply = replies[Math.min(stub.calls, replies.length - 1)];
      stub.calls += 1;
      return { text: reply, usage: null };
    },
  };
  return stub;
}

function questionPayload(tag = "debouncing", files = ["src/a.ts"]): string {
  return JSON.stringify({
    skip: false,
    skip_reason: null,
    questions: [
      {
        concept_tag: tag,
        reframe: false,
        tier: "trace",
        files,
        teaching_card: { body: "A card.", deeper: null },
        question: "What happens?",
        sample_answer: "This happens.",
        hint: "Look here.",
        scaffold: ["step one", "step two"],
      },
    ],
  });
}

const noSleep = { sleep: async () => {}, random: () => 0 };

describe("snapshot (§5.5)", () => {
  it("is independent of git — it diffs against its own copy", () => {
    advanceSnapshot(PROJECT, "src/a.ts", "one\n");
    const diff = diffAgainstSnapshot(PROJECT, "src/a.ts", "one\ntwo\n");
    expect(diff?.diff).toContain("+two");
    expect(diff?.added).toBe(1);
  });

  it("returns null when nothing changed", () => {
    advanceSnapshot(PROJECT, "src/a.ts", "same\n");
    expect(diffAgainstSnapshot(PROJECT, "src/a.ts", "same\n")).toBeNull();
  });

  it("treats an unseen file as new, diffing against empty", () => {
    const diff = diffAgainstSnapshot(PROJECT, "src/new.ts", "hello\n");
    expect(diff?.isNew).toBe(true);
    expect(diff?.diff).toContain("+hello");
  });

  it("produces a standard unified diff with file headers (§5.5)", () => {
    advanceSnapshot(PROJECT, "src/a.ts", "one\n");
    const diff = diffAgainstSnapshot(PROJECT, "src/a.ts", "two\n");
    expect(diff?.diff).toMatch(/^--- a\/src\/a\.ts/m);
    expect(diff?.diff).toMatch(/^\+\+\+ b\/src\/a\.ts/m);
    expect(diff?.diff).toMatch(/^@@/m);
  });

  it("keys the directory by a hash of the project path, not the path itself", () => {
    expect(snapshotDirFor(PROJECT)).not.toContain("repo");
    expect(snapshotDirFor(PROJECT)).not.toBe(snapshotDirFor("/repo/two"));
  });

  it("populates at init so the first captured diff is real (§6.1 step 4)", () => {
    populateSnapshot(PROJECT, [{ relativePath: "src/a.ts", content: "existing\n" }]);
    expect(readSnapshot(PROJECT, "src/a.ts")).toBe("existing\n");
    expect(diffAgainstSnapshot(PROJECT, "src/a.ts", "existing\n")).toBeNull();
  });

  it("hashes diffs stably for dedup", () => {
    expect(hashDiff("same")).toBe(hashDiff("same"));
    expect(hashDiff("same")).not.toBe(hashDiff("different"));
  });

  it("clears a project's snapshots", () => {
    advanceSnapshot(PROJECT, "src/a.ts", "x");
    clearSnapshots(PROJECT);
    expect(readSnapshot(PROJECT, "src/a.ts")).toBeNull();
  });
});

describe("meaningful-diff filter (§7.5)", () => {
  it("rejects below minLines and accepts exactly at it", () => {
    expect(filterDiffs([fileDiff({ added: 2 })], SETTINGS).kept).toHaveLength(0);
    expect(filterDiffs([fileDiff({ added: 3 })], SETTINGS).kept).toHaveLength(1);
  });

  it("rejects whitespace-only, indentation-only, and line-ending-only changes", () => {
    expect(isWhitespaceOnly("@@\n-  const a = 1;\n+    const a = 1;\n")).toBe(true);
    expect(isWhitespaceOnly("@@\n-const a = 1;\n+const a  =  1;\n")).toBe(true);
    expect(isWhitespaceOnly("@@\n-const a = 1;\n+const a = 2;\n")).toBe(false);
  });

  it("rejects an import reorder, but not a reorder plus a real change", () => {
    const reorder =
      "@@\n-import b from 'b';\n-import a from 'a';\n+import a from 'a';\n+import b from 'b';\n";
    expect(isImportReorderOnly(reorder)).toBe(true);

    const withChange = `${reorder}+const added = true;\n`;
    expect(isImportReorderOnly(withChange)).toBe(false);
  });

  it("rejects ignored paths", () => {
    const result = filterDiffs([fileDiff({ path: "dist/bundle.ts" })], SETTINGS);
    expect(result.kept).toHaveLength(0);
    expect(result.rejected[0].reason).toBe("ignored");
  });

  it("accepts a 3-line but meaningful function — it suppresses noise, not importance", () => {
    const meaningful = fileDiff({
      added: 3,
      diff: "@@\n+function assertNonEmpty(items) {\n+  if (items.length === 0) throw new Error('empty');\n+}\n",
    });
    expect(filterDiffs([meaningful], SETTINGS).kept).toHaveLength(1);
  });
});

describe("authorship heuristic (§7.6)", () => {
  it("reads a burst across several files as AI-like", () => {
    const now = Date.now();
    const confidence = estimateAuthorConfidence([
      { path: "a.ts", at: now, bytes: 900 },
      { path: "b.ts", at: now + 40, bytes: 800 },
    ]);
    expect(confidence).toBeGreaterThan(0.9);
  });

  it("reads slow incremental typing as more human", () => {
    const now = Date.now();
    const confidence = estimateAuthorConfidence([
      { path: "a.ts", at: now, bytes: 20 },
      { path: "a.ts", at: now + 60_000, bytes: 40 },
    ]);
    expect(confidence).toBeLessThan(0.75);
  });

  it("NEVER returns zero — an unknown write must not sort to the bottom (§7.6)", () => {
    expect(estimateAuthorConfidence([])).toBeGreaterThan(0.5);
    const slow = estimateAuthorConfidence([
      { path: "a.ts", at: 0, bytes: 1 },
      { path: "a.ts", at: 600_000, bytes: 1 },
    ]);
    expect(slow).toBeGreaterThan(0);
  });
});

describe("rate limit (§8.1, §8.2)", () => {
  function seedQuestions(count: number, createdAt?: string): void {
    for (let i = 0; i < count; i++) {
      const id = insertQuestion(db, {
        project_id: projectId,
        type: "trace",
        concept_tag: "debouncing",
        origin: "live",
        question_text: "q",
        sample_answer: "a",
        files: ["src/a.ts"],
      });
      if (createdAt)
        db.prepare("UPDATE questions SET created_at = ? WHERE id = ?").run(createdAt, id);
    }
  }

  it("generates while under the cap", () => {
    seedQuestions(11);
    expect(decide(db, 10, SETTINGS).generate).toBe(true);
  });

  it("defers at the cap without generating", () => {
    seedQuestions(12);
    const decision = decide(db, 10, SETTINGS);
    expect(decision.generate).toBe(false);
    expect(decision.reason).toBe("over_cap");
  });

  it("the escape valve generates anyway once the rollup passes maxDiffLines (§8.2)", () => {
    seedQuestions(12);
    const decision = decide(db, 801, SETTINGS);
    expect(decision.generate).toBe(true);
    expect(decision.reason).toBe("escape_valve");
  });

  it("uses a rolling window — 12 questions 61 minutes ago do not count", () => {
    const longAgo = new Date(Date.now() - 61 * 60 * 1000).toISOString();
    seedQuestions(12, longAgo);
    expect(questionsInLastHour(db)).toBe(0);
    expect(decide(db, 10, SETTINGS).generate).toBe(true);
  });

  it("counts only +/- lines, not diff headers", () => {
    expect(countDiffLines("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n context\n")).toBe(2);
  });
});

describe("THE CHECKPOINT ADVANCE RULE (§8.3)", () => {
  it("ADVANCES when questions are persisted", async () => {
    const outcome = await runPipeline(
      db,
      { projectId, files: [fileDiff()], origin: "live" },
      SETTINGS,
      { provider: provider([questionPayload()]), ...noSleep },
    );
    expect(outcome.kind).toBe("questions");
    expect(outcome.advanceCheckpoint).toBe(true);
    expect(listPendingQuestions(db, projectId)).toHaveLength(1);
  });

  it("ADVANCES when the model says the batch is not worth asking about", async () => {
    const outcome = await runPipeline(
      db,
      { projectId, files: [fileDiff()], origin: "live" },
      SETTINGS,
      {
        provider: provider([JSON.stringify({ skip: true, skip_reason: "dependency bump" })]),
        ...noSleep,
      },
    );
    expect(outcome.kind).toBe("skipped");
    expect(outcome.advanceCheckpoint).toBe(true);
    expect(listPendingQuestions(db, projectId)).toHaveLength(0);
  });

  it("ADVANCES when every file is filtered as noise, with no model call at all", async () => {
    const stub = provider([questionPayload()]);
    const outcome = await runPipeline(
      db,
      { projectId, files: [fileDiff({ added: 1 })], origin: "live" },
      SETTINGS,
      { provider: stub, ...noSleep },
    );
    expect(outcome.kind).toBe("filtered");
    expect(outcome.advanceCheckpoint).toBe(true);
    expect(stub.calls).toBe(0); // free local checks run before any spend (§2.6)
  });

  it("DOES NOT ADVANCE on a rate-limit deferral (§8.2)", async () => {
    for (let i = 0; i < 12; i++) {
      insertQuestion(db, {
        project_id: projectId,
        type: "trace",
        concept_tag: "debouncing",
        origin: "live",
        question_text: "q",
        sample_answer: "a",
        files: ["src/a.ts"],
      });
    }
    const stub = provider([questionPayload()]);
    const outcome = await runPipeline(
      db,
      { projectId, files: [fileDiff()], origin: "live" },
      SETTINGS,
      { provider: stub, ...noSleep },
    );
    expect(outcome.kind).toBe("deferred");
    expect(outcome.advanceCheckpoint).toBe(false);
    expect(stub.calls).toBe(0);
  });

  it("DOES NOT ADVANCE on a generation failure, and keeps a re-runnable payload", async () => {
    const outcome = await runPipeline(
      db,
      { projectId, files: [fileDiff()], origin: "live" },
      SETTINGS,
      { provider: provider(["not json", "still not json"]), ...noSleep },
    );
    expect(outcome.kind).toBe("failed");
    expect(outcome.advanceCheckpoint).toBe(false);

    const failures = listFailures(db);
    expect(failures).toHaveLength(1);
    expect(JSON.parse(failures[0].payload_json).diff).toContain("const a = 1;");
  });

  it("DOES NOT ADVANCE on an auth error", async () => {
    const failing: ModelProvider = {
      name: "claude-cli",
      askModel: async () => {
        throw Object.assign(new Error("not logged in"), { status: 401 });
      },
    };
    const outcome = await runPipeline(
      db,
      { projectId, files: [fileDiff()], origin: "live" },
      SETTINGS,
      { provider: failing, ...noSleep },
    );
    expect(outcome.advanceCheckpoint).toBe(false);
  });

  it("ADVANCES on a duplicate diff without asking twice (§19 dedup)", async () => {
    const stub = provider([questionPayload()]);
    await runPipeline(db, { projectId, files: [fileDiff()], origin: "live" }, SETTINGS, {
      provider: stub,
      ...noSleep,
    });
    const second = await runPipeline(
      db,
      { projectId, files: [fileDiff()], origin: "live" },
      SETTINGS,
      {
        provider: stub,
        ...noSleep,
      },
    );
    expect(second.kind).toBe("duplicate");
    expect(second.advanceCheckpoint).toBe(true);
    expect(stub.calls).toBe(1);
    expect(listPendingQuestions(db, projectId)).toHaveLength(1);
  });
});

describe("pipeline persistence details", () => {
  it("attributes each question to only its own files (§13.3)", async () => {
    const files = [
      fileDiff(),
      fileDiff({ path: "src/b.ts", diff: "@@\n+const b = 1;\n+const c = 2;\n+const d = 3;\n" }),
    ];
    await runPipeline(db, { projectId, files, origin: "live" }, SETTINGS, {
      provider: provider([questionPayload("debouncing", ["src/b.ts"])]),
      ...noSleep,
    });
    const [question] = listPendingQuestions(db, projectId);
    const attributed = db
      .prepare("SELECT file_path FROM question_files WHERE question_id = ?")
      .all(question.id)
      .map((row) => (row as { file_path: string }).file_path);
    expect(attributed).toEqual(["src/b.ts"]);
  });

  it("carries the authorship confidence onto the row as an ordering signal only", async () => {
    await runPipeline(
      db,
      { projectId, files: [fileDiff()], origin: "live", authorConfidence: 0.42 },
      SETTINGS,
      { provider: provider([questionPayload()]), ...noSleep },
    );
    expect(listPendingQuestions(db, projectId)[0].author_confidence).toBeCloseTo(0.42);
  });

  it("re-arms a struggled synthesis cluster when a new question lands (§11.8)", async () => {
    setTier(db, "debouncing", "predict_break", new Date().toISOString());
    for (let i = 0; i < 3; i++) {
      insertQuestion(db, {
        project_id: projectId,
        type: "trace",
        concept_tag: "debouncing",
        origin: "live",
        question_text: "q",
        sample_answer: "a",
        files: ["src/a.ts"],
      });
    }
    db.prepare(
      "INSERT INTO synthesis_clusters (tag, eligible, status, count_at_last_checkpoint) VALUES (?, 0, 'struggled', 3)",
    ).run("debouncing");

    await runPipeline(db, { projectId, files: [fileDiff()], origin: "live" }, SETTINGS, {
      provider: provider([questionPayload()]),
      ...noSleep,
    });

    const cluster = db
      .prepare("SELECT eligible FROM synthesis_clusters WHERE tag = ?")
      .get("debouncing");
    expect((cluster as { eligible: number }).eligible).toBe(1);
  });
});
