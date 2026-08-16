import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { scenario } from "../lib/scenario";
import { initScratchRepo, isolatedHome, graspEnv, commitFile, writeFile, CLI_PATH } from "../lib/env";
import { runGraspPty, waitFor, sendText, sleepStep, Key } from "../lib/ptyDriver";
import { fireFullTurn } from "../lib/hooks";
import { openHomeDb } from "../lib/db";

/**
 * A basic, deliberately SHALLOW question-quality check, per the task
 * brief's own explicit scope limit: structural sanity only (non-empty, no
 * leftover template placeholders, the concept question shows no code, the
 * instance question's cited excerpt actually exists in the real file at the
 * stated lines) — never a judgment of whether a question is pedagogically
 * good, well-targeted, or genuinely useful. That judgment stays a human
 * call per TESTING_GUIDE.md §2, and is explicitly out of scope here.
 *
 * Runs against the mock `claude` fixture by default (like every other
 * scenario in a normal harness run — see lib/env.ts's `claudeMode`), so
 * these checks are necessarily checking the HARNESS's/Grasp's OWN handling
 * of a judge response's structure (parsing, persistence, citation
 * validation), not real model output quality — that's the honest limit of
 * what a mocked run can check. Set `GRASP_E2E_CLAUDE_MODE=real` (with a
 * real, authenticated `claude` on PATH) to run these same structural checks
 * against genuine model output.
 */

const TEMPLATE_PLACEHOLDER_PATTERNS = [/\{\{.*?\}\}/, /<TODO/i, /\[insert/i, /\bTBD\b/, /\bLOREM\b/i];

function hasNoTemplatePlaceholders(text: string): boolean {
  return !TEMPLATE_PLACEHOLDER_PATTERNS.some((re) => re.test(text));
}

/** Crude but effective-enough "does this look like it contains actual source code" heuristic for a concept question, which must stand apart from any specific code per brief §3.2. */
function looksLikeCode(text: string): boolean {
  return /[{};]\s*$/.test(text.trim()) || /^\s*(function|const|let|var|class|import|export)\b/m.test(text) || text.includes("```");
}

export const questionQualityScenarios = [
  scenario("question quality: a live diff question is structurally sane (non-empty, no placeholders, concept question shows no code)", async () => {
    const repo = initScratchRepo();
    commitFile(repo, "quality.ts", "export function original() {\n  return 1;\n}\n");
    const home = isolatedHome();
    const sessionId = "e2e-quality-session";

    const { stop } = fireFullTurn(repo, graspEnv(home, { mode: "normal" }), sessionId, "p1", () => {
      writeFile(
        repo,
        "quality.ts",
        "export function original() {\n  return 1;\n}\n\nexport function addedFn() {\n  return 2;\n}\n\nexport function addedFnExtra() {\n  return 3;\n}\n"
      );
    });
    assert.equal(stop.status, 0);
    assert.ok(stop.output, "the real turn must produce a real question");

    const db = openHomeDb(home);
    const row = db.prepare(`SELECT question_concept, question_instance FROM events WHERE session_id = ? AND question_type IS NOT NULL`).get(sessionId) as any;
    db.close();
    assert.ok(row, "a real question row must exist");

    assert.ok(row.question_concept && row.question_concept.trim().length > 0, "the concept question must be non-empty");
    assert.ok(row.question_instance && row.question_instance.trim().length > 0, "the instance question must be non-empty");
    assert.ok(hasNoTemplatePlaceholders(row.question_concept), "the concept question must have no leftover template placeholders");
    assert.ok(hasNoTemplatePlaceholders(row.question_instance), "the instance question must have no leftover template placeholders");
    assert.ok(!looksLikeCode(row.question_concept), "the concept question must stand apart from any specific code, per brief §3.2");
  }),

  scenario("question quality: a scan question's cited excerpt actually exists in the real file at the stated lines", async () => {
    const repo = initScratchRepo();
    const content = [
      "export function alpha() {",
      "  return 1;",
      "}",
      "",
      "export function beta() {",
      "  return 2;",
      "}",
      "",
      "export function gamma() {",
      "  return 3;",
      "}",
      "",
    ].join("\n");
    commitFile(repo, "excerpt.ts", content);
    const home = isolatedHome();

    const result = await runGraspPty(
      CLI_PATH,
      ["scan"],
      [
        waitFor("Concept question:"),
        sendText("concept answer"),
        sleepStep(0.3),
        sendText(Key.ENTER),
        waitFor("Press any key to continue"),
        sendText(Key.ENTER),
        waitFor("Instance question:"),
        sendText("instance answer"),
        sleepStep(0.3),
        sendText(Key.ENTER),
        waitFor("Press any key to continue"),
        sendText(Key.ENTER),
      ],
      { cwd: repo, env: graspEnv(home, { mode: "normal" }), cols: 120, rows: 45 }
    );
    assert.equal(result.code, 0, `pty driver failed: ${result.stderr}`);

    const db = openHomeDb(home);
    const row = db.prepare(`SELECT question_concept, question_instance, scan_excerpt_start_line, scan_excerpt_end_line, scan_excerpt_lines_json FROM events WHERE source = 'scan'`).get() as any;
    db.close();
    assert.ok(row, "a real scan question row must exist");
    assert.ok(hasNoTemplatePlaceholders(row.question_concept), "no leftover template placeholders in the concept question");
    assert.ok(hasNoTemplatePlaceholders(row.question_instance), "no leftover template placeholders in the instance question");
    assert.ok(!looksLikeCode(row.question_concept), "a scan concept question must also show no code");

    assert.ok(row.scan_excerpt_start_line !== null, "an instance question about scanned code must cite a real line range");
    const realLines = fs.readFileSync(path.join(repo, "excerpt.ts"), "utf-8").split("\n");
    // splitFileLines-equivalent: a trailing newline means the last split
    // element is an empty non-line, matching src/scanChunking.ts's own logic.
    if (realLines[realLines.length - 1] === "") realLines.pop();
    const citedLines: string[] = JSON.parse(row.scan_excerpt_lines_json);
    for (let i = 0; i < citedLines.length; i++) {
      const absoluteLineNo = row.scan_excerpt_start_line + i;
      assert.equal(
        citedLines[i],
        realLines[absoluteLineNo - 1],
        `cited excerpt line ${i} must match the real file's actual content at absolute line ${absoluteLineNo}`
      );
    }
  }),
];
