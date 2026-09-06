/**
 * Section splitting, resumability, hash-diffed re-scans, and the cap.
 * GOVERNED BY: §12.2, §8.4, §22.3 cases 8, 9, 10
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { closeDatabase, openDatabase } from "../src/storage/db.js";
import { insertProject } from "../src/storage/models/projects.js";
import { listPendingQuestions } from "../src/storage/models/questions.js";
import { listScanProgress } from "../src/storage/models/scanProgress.js";
import { runScan, type ScanSettings } from "../src/scan/scanRunner.js";
import {
  HARD_SPLIT_OVERLAP,
  MAX_SECTION_LINES,
  describeSection,
  splitIntoSections,
  topLevelBoundaries,
} from "../src/scan/sections.js";
import type { ModelProvider } from "../src/generation/provider.js";

let home: string;
let repo: string;
let db: DatabaseSync;
let projectId: number;

const SETTINGS: ScanSettings = {
  minLines: 3,
  ignorePatterns: ["**/dist/**"],
  maxQuestionsPerHour: 1000,
  maxDiffLines: 800,
  minDiffCount: 3,
  minMasteryTier: "predict_break",
  decayWindows: { trace: 90, predictBreak: 60, reconstruct: 45 },
  scanQuestionsCap: 15,
};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "grasp-scan-home-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "grasp-scan-repo-")));
  db = openDatabase({ file: path.join(home, "history.db") });
  projectId = insertProject(db, repo).id;
});

afterEach(() => {
  closeDatabase(db);
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

function writeFile(relative: string, content: string): void {
  fs.mkdirSync(path.join(repo, path.dirname(relative)), { recursive: true });
  fs.writeFileSync(path.join(repo, relative), content);
}

function question(tag: string, file: string): string {
  return JSON.stringify({
    skip: false,
    skip_reason: null,
    questions: [
      {
        concept_tag: tag,
        reframe: false,
        tier: "trace",
        files: [file],
        teaching_card: { body: "A card.", deeper: null },
        question: "What does this do?",
        sample_answer: "This.",
        hint: "Look here.",
        scaffold: ["one", "two"],
      },
    ],
  });
}

/**
 * Answers with a question attributed to whichever file the prompt is actually
 * about. A stub that always names one path would be rejected by the pipeline's
 * file-attribution guard, which is correct behavior and not what these tests
 * are exercising.
 */
function provider(reply: (callIndex: number) => string): ModelProvider & { calls: number } {
  const stub = {
    name: "api" as const,
    calls: 0,
    askModel: async (prompt: string) => {
      const promptedFile = /FILES[^\n]*\n\s+(\S+)/.exec(prompt)?.[1];
      const text = reply(stub.calls).replace(
        /"files":\["[^"]*"\]/,
        `"files":["${promptedFile ?? ""}"]`,
      );
      stub.calls += 1;
      return { text, usage: null };
    },
  };
  return stub;
}

const noSleep = { sleep: async () => {}, random: () => 0 };

describe("section splitting (§12.2)", () => {
  it("leaves a file under 400 lines as one section", () => {
    const sections = splitIntoSections("const a = 1;\n".repeat(50), "src/a.ts");
    expect(sections).toHaveLength(1);
    expect(describeSection(sections[0])).toBeNull();
  });

  it("splits a long file at top-level declaration boundaries (§22.3 case 10)", () => {
    // 10 functions of ~120 lines each: boundaries exist and must be used.
    const fn = (i: number) =>
      `export function fn${i}() {\n${Array.from({ length: 118 }, (_, j) => `  const x${i}_${j} = ${j};`).join("\n")}\n}\n`;
    const source = Array.from({ length: 10 }, (_, i) => fn(i)).join("\n");
    const sections = splitIntoSections(source, "src/big.ts");

    expect(sections.length).toBeGreaterThan(1);
    expect(sections.every((section) => section.onBoundary)).toBe(true);
    // No section starts mid-function: each begins at a declaration or a blank.
    for (const section of sections.slice(1)) {
      const firstLine = section.content.split("\n").find((line) => line.trim().length > 0) ?? "";
      expect(firstLine).toMatch(/^export function fn\d+\(\)/);
    }
  });

  it("falls back to a hard split with overlap when the file does not parse (§22.3 case 10)", () => {
    // A generated/minified bundle that the parser cannot make sense of: no
    // declaration boundaries are available, so the split must be positional.
    const source = `const bundle = {${Array.from({ length: 1000 }, (_, i) => `a${i}:1,`).join("\n")}`;
    const sections = splitIntoSections(source, "src/min.js", MAX_SECTION_LINES);

    expect(sections.length).toBeGreaterThan(1);
    expect(sections.every((section) => !section.onBoundary)).toBe(true);
    // Consecutive sections overlap by exactly the specified context.
    expect(sections[0].endLine - sections[1].startLine + 1).toBe(HARD_SPLIT_OVERLAP);
  });

  it("returns null boundaries for an unparseable or non-JS file", () => {
    expect(topLevelBoundaries("def thing():\n  pass\n", "main.py")).toBeNull();
    expect(topLevelBoundaries("function broken( {", "src/a.ts")).toBeNull();
  });

  it("labels a section for the prompt", () => {
    const sections = splitIntoSections("x\n".repeat(1000), "src/min.js");
    expect(describeSection(sections[0])).toMatch(/section 1 of \d+, lines 1-400/);
  });
});

describe("scan behavior (§12.2)", () => {
  it("walks tracked files and creates questions", async () => {
    writeFile("src/a.ts", "export const a = 1;\n");
    writeFile("src/b.ts", "export const b = 2;\n");
    const stub = provider(() => question("naming", "src/a.ts"));

    const result = await runScan(db, { projectId, projectPath: repo }, SETTINGS, {
      provider: stub,
      ...noSleep,
    });

    expect(result.filesScanned).toBe(2);
    expect(result.questionsCreated).toBe(2);
    expect(listPendingQuestions(db, projectId)).toHaveLength(2);
  });

  it("does NOT apply the line-count threshold — small files may matter (§12.2)", async () => {
    // One line: the live filter would reject this, scan must not.
    writeFile("src/tiny.ts", "export const answer = 42;\n");
    const stub = provider(() => question("naming", "src/tiny.ts"));

    const result = await runScan(db, { projectId, projectPath: repo }, SETTINGS, {
      provider: stub,
      ...noSleep,
    });
    expect(result.questionsCreated).toBe(1);
  });

  it("respects ignorePatterns as the cheap first pass", async () => {
    writeFile("src/a.ts", "export const a = 1;\n");
    writeFile("dist/bundle.ts", "export const bundled = 1;\n");
    const stub = provider(() => question("naming", "src/a.ts"));

    const result = await runScan(db, { projectId, projectPath: repo }, SETTINGS, {
      provider: stub,
      ...noSleep,
    });
    expect(result.filesConsidered).toBe(1);
    expect(stub.calls).toBe(1);
  });

  it("generates nothing on a re-run with no edits (§22.3 case 9)", async () => {
    writeFile("src/a.ts", "export const a = 1;\n");
    const first = provider(() => question("naming", "src/a.ts"));
    await runScan(db, { projectId, projectPath: repo }, SETTINGS, { provider: first, ...noSleep });
    expect(first.calls).toBe(1);

    const second = provider(() => question("naming", "src/a.ts"));
    const result = await runScan(db, { projectId, projectPath: repo }, SETTINGS, {
      provider: second,
      ...noSleep,
    });

    expect(second.calls).toBe(0);
    expect(result.filesSkippedUnchanged).toBe(1);
    expect(result.questionsCreated).toBe(0);
  });

  it("re-triggers on a genuinely edited file (§12.2)", async () => {
    writeFile("src/a.ts", "export const a = 1;\n");
    const first = provider(() => question("naming", "src/a.ts"));
    await runScan(db, { projectId, projectPath: repo }, SETTINGS, { provider: first, ...noSleep });

    writeFile("src/a.ts", "export const a = 2; // changed\n");
    const second = provider(() => question("naming", "src/a.ts"));
    await runScan(db, { projectId, projectPath: repo }, SETTINGS, { provider: second, ...noSleep });

    expect(second.calls).toBe(1);
  });

  it("resumes where it left off rather than re-asking (§22.3 case 8)", async () => {
    for (let i = 0; i < 6; i++) writeFile(`src/file${i}.ts`, `export const v${i} = ${i};\n`);

    // Cap at 3: the run stops partway through.
    const first = provider(() => question("naming", "src/file0.ts"));
    const capped = await runScan(
      db,
      { projectId, projectPath: repo },
      { ...SETTINGS, scanQuestionsCap: 3 },
      { provider: first, ...noSleep },
    );
    expect(capped.cappedOut).toBe(true);
    expect(first.calls).toBe(3);
    expect(listScanProgress(db, projectId)).toHaveLength(3);

    // Re-run: the first three are unchanged and are not asked about again.
    const second = provider(() => question("naming", "src/file3.ts"));
    const resumed = await runScan(
      db,
      { projectId, projectPath: repo },
      { ...SETTINGS, scanQuestionsCap: 3 },
      { provider: second, ...noSleep },
    );
    expect(resumed.filesSkippedUnchanged).toBe(3);
    expect(second.calls).toBe(3);
  });

  it("stops at the cap, and --full bypasses it (§8.4)", async () => {
    for (let i = 0; i < 5; i++) writeFile(`src/file${i}.ts`, `export const v${i} = ${i};\n`);

    const capped = provider(() => question("naming", "src/file0.ts"));
    const result = await runScan(
      db,
      { projectId, projectPath: repo },
      { ...SETTINGS, scanQuestionsCap: 2 },
      { provider: capped, ...noSleep },
    );
    expect(result.questionsCreated).toBe(2);
    expect(result.cappedOut).toBe(true);

    const full = provider(() => question("naming", "src/file0.ts"));
    const uncapped = await runScan(
      db,
      { projectId, projectPath: repo, full: true },
      { ...SETTINGS, scanQuestionsCap: 2 },
      { provider: full, ...noSleep },
    );
    expect(uncapped.cappedOut).toBe(false);
    expect(uncapped.questionsCreated).toBeGreaterThan(2);
  });

  it("records progress only for sections that reached a terminal state (§8.3)", async () => {
    writeFile("src/a.ts", "export const a = 1;\n");
    // Malformed twice: the pipeline fails and must not mark the file done.
    const failing = provider(() => "not json");
    await runScan(db, { projectId, projectPath: repo }, SETTINGS, {
      provider: failing,
      ...noSleep,
    });

    expect(listScanProgress(db, projectId)).toHaveLength(0);

    // The next run therefore still sees the file.
    const succeeding = provider(() => question("naming", "src/a.ts"));
    await runScan(db, { projectId, projectPath: repo }, SETTINGS, {
      provider: succeeding,
      ...noSleep,
    });
    expect(succeeding.calls).toBe(1);
  });

  it("prints live progress so a long run never looks hung (§12.2)", async () => {
    writeFile("src/a.ts", "export const a = 1;\n");
    const lines: string[] = [];
    await runScan(
      db,
      { projectId, projectPath: repo, onProgress: (line) => lines.push(line) },
      SETTINGS,
      { provider: provider(() => question("naming", "src/a.ts")), ...noSleep },
    );
    expect(lines[0]).toMatch(/\[0\/15\] src\/a\.ts/);
  });
});
