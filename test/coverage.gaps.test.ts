/**
 * The remaining surfaces: real terminal IO, a real chokidar watcher, log
 * rotation, and the thin command wrappers.
 * GOVERNED BY: §14.4, §7.1, §16.1, §20, §22.3 case 1
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { closeDatabase, openDatabase } from "../src/storage/db.js";
import { insertProject } from "../src/storage/models/projects.js";
import { insertQuestion } from "../src/storage/models/questions.js";
import { clearScanProgress, recordScanProgress } from "../src/storage/models/scanProgress.js";
import { ensureConcept } from "../src/storage/models/concepts.js";
import {
  ensureCluster,
  listClusters,
  listEligibleClusters,
  setEligible,
} from "../src/storage/models/synthesisClusters.js";
import { ProjectWatcher, type WatcherSettings } from "../src/daemon/watcher.js";
import { createLogger, MAX_LOG_BYTES } from "../src/daemon/logger.js";
import { runExport } from "../src/cli/commands/export.js";
import { runReview } from "../src/cli/commands/review.js";
import {
  graspLogDir,
  graspPidPath,
  graspReviewLockPath,
  graspSnapshotRoot,
} from "../src/util/home.js";
import { removeSnapshot, advanceSnapshot, readSnapshot } from "../src/capture/snapshot.js";
import type { ModelProvider } from "../src/generation/provider.js";
import type { ReviewIo } from "../src/review/io.js";

let home: string;
let dbFile: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "grasp-gaps-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  dbFile = path.join(home, "history.db");
});

afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe("a real chokidar watcher (§7.1, §22.3 case 1)", () => {
  it("captures a real file write end to end", async () => {
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "grasp-watch-")));
    const db = openDatabase({ file: dbFile });
    const projectId = insertProject(db, repo).id;

    const provider: ModelProvider = {
      name: "api",
      askModel: async () => ({
        text: JSON.stringify({
          skip: false,
          skip_reason: null,
          questions: [
            {
              concept_tag: "guard-clause",
              reframe: false,
              tier: "trace",
              files: ["src/a.ts"],
              teaching_card: { body: "card", deeper: null },
              question: "q",
              sample_answer: "a",
              hint: "h",
              scaffold: ["one", "two"],
            },
          ],
        }),
        usage: null,
      }),
    };

    const settings: WatcherSettings = {
      debounceMs: 80,
      maxFilesPerBatch: 25,
      minLines: 3,
      ignorePatterns: ["**/dist/**"],
      maxQuestionsPerHour: 12,
      maxDiffLines: 800,
      minDiffCount: 3,
      minMasteryTier: "predict_break",
      decayWindows: { trace: 90, predictBreak: 60, reconstruct: 45 },
    };

    let notified = 0;
    const watcher = new ProjectWatcher(db, projectId, repo, settings, {
      provider,
      onQuestions: () => void (notified += 1),
      sleep: async () => {},
      random: () => 0,
      usePolling: true,
    });
    await watcher.start();
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, "src", "a.ts"),
      "export function guard(items: string[]) {\n  if (items.length === 0) throw new Error('empty');\n  return items;\n}\n",
    );
    // awaitWriteFinish (300ms) + debounce (80ms) + generation.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await watcher.stop();

    expect(notified).toBe(1);
    expect(readSnapshot(repo, "src/a.ts")).toContain("guard");

    closeDatabase(db);
    fs.rmSync(repo, { recursive: true, force: true });
  }, 15_000);

  it("ignores a file matching ignorePatterns", async () => {
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "grasp-watch2-")));
    const db = openDatabase({ file: dbFile });
    const projectId = insertProject(db, repo).id;
    const settings: WatcherSettings = {
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
    let called = 0;
    const watcher = new ProjectWatcher(db, projectId, repo, settings, {
      provider: {
        name: "api",
        askModel: async () => {
          called += 1;
          return { text: "{}", usage: null };
        },
      },
      sleep: async () => {},
      usePolling: true,
    });
    await watcher.start();
    fs.mkdirSync(path.join(repo, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, "dist", "bundle.ts"),
      "export const a = 1;\nconst b = 2;\nconst c = 3;\n",
    );
    await new Promise((resolve) => setTimeout(resolve, 800));
    await watcher.stop();

    expect(called).toBe(0);
    closeDatabase(db);
    fs.rmSync(repo, { recursive: true, force: true });
  }, 15_000);
});

describe("log rotation (§16.1)", () => {
  it("rotates at the size limit, keeping three files", () => {
    const file = path.join(graspLogDir(), "daemon.log");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "x".repeat(MAX_LOG_BYTES + 1));

    createLogger({ file, level: "info" }).info("after rotation");

    expect(fs.existsSync(`${file}.1`)).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toContain("after rotation");
    expect(fs.readFileSync(file, "utf8").length).toBeLessThan(MAX_LOG_BYTES);
  });

  it("writes to disk under ~/.grasp/logs and survives an unwritable path", () => {
    const logger = createLogger({ file: path.join(graspLogDir(), "daemon.log") });
    logger.info("hello", { count: 1 });
    expect(fs.readFileSync(path.join(graspLogDir(), "daemon.log"), "utf8")).toContain("hello");

    // An impossible path must not throw: logging never takes the daemon down.
    const broken = createLogger({ file: "/dev/null/nope/daemon.log" });
    expect(() => broken.error("still fine")).not.toThrow();
  });
});

describe("home paths (§5.2, §5.5, §16.1, §16.5)", () => {
  it("keeps everything under ~/.grasp", () => {
    for (const target of [
      graspPidPath(),
      graspLogDir(),
      graspSnapshotRoot(),
      graspReviewLockPath(),
    ]) {
      expect(target.startsWith(path.join(home, ".grasp"))).toBe(true);
    }
  });
});

describe("model leftovers", () => {
  it("removes a snapshot and clears scan progress", () => {
    advanceSnapshot("/repo/x", "src/a.ts", "content");
    removeSnapshot("/repo/x", "src/a.ts");
    expect(readSnapshot("/repo/x", "src/a.ts")).toBeNull();

    const db = openDatabase({ file: dbFile });
    const projectId = insertProject(db, "/repo/x").id;
    recordScanProgress(db, {
      project_id: projectId,
      file_path: "src/a.ts",
      file_hash: "h",
      sections_completed: 1,
      sections_total: 1,
    });
    clearScanProgress(db, projectId);
    expect(fs.existsSync(dbFile)).toBe(true);
    closeDatabase(db);
  });

  it("lists clusters and eligible clusters", () => {
    const db = openDatabase({ file: dbFile });
    ensureConcept(db, "auth-flow");
    ensureCluster(db, "auth-flow");
    expect(listClusters(db)).toHaveLength(1);
    expect(listEligibleClusters(db)).toHaveLength(0);
    setEligible(db, "auth-flow", true);
    expect(listEligibleClusters(db)).toHaveLength(1);
    closeDatabase(db);
  });
});

describe("command wrappers", () => {
  let db: DatabaseSync;
  let projectId: number;

  beforeEach(() => {
    db = openDatabase({ file: dbFile });
    projectId = insertProject(db, "/repo/one").id;
    insertQuestion(db, {
      project_id: projectId,
      type: "trace",
      concept_tag: "debouncing",
      origin: "live",
      question_text: "q",
      sample_answer: "a",
      code_snippet: "code",
      files: ["src/a.ts"],
    });
    closeDatabase(db);
  });

  it("exports anki and raw, and writes to a file with --out", () => {
    const anki = runExport({ format: "anki", dbFile });
    expect(anki.exitCode).toBe(0);
    expect(anki.output).toContain("\t");

    const out = path.join(home, "cards.txt");
    runExport({ format: "raw", out, dbFile });
    expect(JSON.parse(fs.readFileSync(out, "utf8"))[0].question_text).toBe("q");
  });

  it("refuses --project outside a registered repo", () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "grasp-elsewhere-"));
    fs.mkdirSync(path.join(elsewhere, ".git"));
    expect(runExport({ format: "raw", project: true, cwd: elsewhere, dbFile }).exitCode).toBe(2);
    fs.rmSync(elsewhere, { recursive: true, force: true });
  });

  it("review reports an empty queue and exits 0", async () => {
    const written: string[] = [];
    const io: ReviewIo = {
      write: (text) => void written.push(text),
      prompt: async () => ({ kind: "command", command: "quit" }),
      promptAssessment: async () => null,
      close: () => {},
    };
    // Not inside a registered project, so this behaves as --all (§14.1) and the
    // one seeded question is offered, then the session quits.
    const result = await runReview({ cwd: home, dbFile, io, all: true });
    expect(result.exitCode).toBe(0);
    expect(written.join("")).toContain("1 question(s) pending");
  });

  it("review refuses a second concurrent session with exit 2 (§16.5)", async () => {
    fs.mkdirSync(path.join(home, ".grasp"), { recursive: true });
    fs.writeFileSync(
      graspReviewLockPath(),
      JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }),
    );
    const result = await runReview({ cwd: home, dbFile, all: true });
    expect(result.exitCode).toBe(2);
  });
});
