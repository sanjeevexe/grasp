import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { buildExportCsv } from "../src/export";
import { insertEvent, openStore } from "../src/store";

/**
 * Coverage for the reliability rework's extension of `grasp export` (built
 * in Prompt 2) to include `grasp scan`-sourced rows and a `source` column —
 * see DECISIONS.md's `grasp scan` entries. `--raw` needed no code changes
 * at all (it's `SELECT *`, so new columns show up automatically) — this
 * file focuses on the default and `--anki` shapes, which did.
 */

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grasp-test-export-db-"));
  return path.join(dir, "history.db");
}

function seedOneDiffQuestion(db: ReturnType<typeof openStore>): void {
  insertEvent(
    db,
    {
      timestamp: "2026-01-01T00:00:00.000Z",
      repo: "/tmp/repo",
      sessionId: "cc-session",
      diffHash: "abc",
      diffSummary: "1 file changed",
      questionConcept: "What is a mutex?",
      questionInstance: "Why did this diff use one?",
      questionType: "both",
      generationSource: "headless-claude-p",
      missReason: null,
      answerConcept: "a lock",
      answerInstance: "for exclusion",
      skipped: false,
      skipReason: null,
      costUsd: 0.001,
      diffFiles: [],
      sampleAnswerConcept: "A mutual-exclusion lock.",
      sampleAnswerInstance: "Because only one goroutine may touch it.",
      conceptExplanation: "explanation",
    },
    [{ tag: "mutex-vs-channel", answered: true }]
  );
}

function seedOneScanQuestion(db: ReturnType<typeof openStore>): void {
  insertEvent(
    db,
    {
      timestamp: "2026-01-02T00:00:00.000Z",
      repo: "/tmp/repo",
      sessionId: "scan-xyz",
      diffHash: null,
      diffSummary: "src/example.ts",
      questionConcept: "What is recursion?",
      questionInstance: "Where does this file use it?",
      questionType: "both",
      generationSource: "headless-claude-p",
      missReason: null,
      answerConcept: null,
      answerInstance: null,
      skipped: false,
      skipReason: null,
      costUsd: 0.001,
      diffFiles: null,
      sampleAnswerConcept: "A function calling itself.",
      sampleAnswerInstance: "In the tree-walk helper.",
      conceptExplanation: "explanation",
      source: "scan",
      scanExcerptStartLine: 3,
      scanExcerptEndLine: 5,
      scanExcerptLines: ["a", "b", "c"],
    },
    [{ tag: "recursion", answered: false }]
  );
}

test("buildExportCsv (default shape): includes a source column and both diff- and scan-sourced rows", () => {
  const db = openStore(tempDbPath());
  seedOneDiffQuestion(db);
  seedOneScanQuestion(db);

  const { csv, rowCount } = buildExportCsv(db, "default");
  assert.equal(rowCount, 2);
  const lines = csv.trim().split("\r\n");
  assert.match(lines[0], /(^|,)source(,|$)/, "header must include a source column");
  assert.ok(lines.some((l) => l.includes("diff")), "must include a diff-sourced row");
  assert.ok(lines.some((l) => l.includes("scan")), "must include a scan-sourced row");
  db.close();
});

test("buildExportCsv (--anki shape): source is folded into the Tags field, not a new column — 3 columns stays exactly 3", () => {
  const db = openStore(tempDbPath());
  seedOneDiffQuestion(db);
  seedOneScanQuestion(db);

  const { csv, rowCount } = buildExportCsv(db, "anki");
  assert.equal(rowCount, 2, "both concept questions (diff and scan) must be included");
  const lines = csv.trim().split("\r\n");
  assert.deepEqual(lines[0].split(","), ["Front", "Back", "Tags"], "the anki shape's 3-column Front/Back/Tags contract must not change");
  assert.ok(lines.some((l) => l.includes("source:diff")), "the diff row's Tags field must include a source:diff tag");
  assert.ok(lines.some((l) => l.includes("source:scan")), "the scan row's Tags field must include a source:scan tag");
  db.close();
});

test("buildExportCsv (--raw shape): scan-specific columns (source, scan_excerpt_*) pass through automatically", () => {
  const db = openStore(tempDbPath());
  seedOneScanQuestion(db);

  const { csv } = buildExportCsv(db, "raw");
  const header = csv.split("\r\n")[0];
  assert.match(header, /(^|,)source(,|$)/);
  assert.match(header, /scan_excerpt_start_line/);
  assert.match(header, /scan_excerpt_end_line/);
  assert.match(header, /scan_excerpt_lines_json/);
  db.close();
});
