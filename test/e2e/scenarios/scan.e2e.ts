import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { scenario } from "../lib/scenario";
import { initScratchRepo, isolatedHome, graspEnv, commitFile, writeFile, mkTempDir, sleep, CLI_PATH } from "../lib/env";
import { runGraspCli } from "../lib/cli";
import { runGraspPty, waitFor, sendText, sleepStep, Key, PtyStep } from "../lib/ptyDriver";
import { openHomeDb, dbPathFor } from "../lib/db";
import { execFileSync } from "child_process";
import Database from "better-sqlite3";
import { MAX_SCAN_CHUNK_LINES, splitFileLines } from "../../../src/scanChunking";
import { insertEvent } from "../../../src/store";

/**
 * `grasp scan` — standalone operation, the batch-then-present model,
 * chunking across a large file (multiple runs producing multiple real
 * questions, correct absolute line citations for non-first chunks),
 * round-robin spread across directories, the oversized-ceiling skip with
 * its visible message (this is the exact off-by-one bug TEST_LOG.md's
 * prior pass found and commit a4c43f8 fixed — this scenario re-verifies it
 * for real, live, through the actual CLI), hash-based re-scan, the post-run
 * summary, `--full`'s warning-not-gate behavior, the cross-source hint, and
 * the "nothing left to scan" message.
 */

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function linesFile(count: number, label = "line"): string {
  const lines = Array.from({ length: count }, (_, i) => `// ${label} ${i + 1} — unique marker LN${i + 1}`);
  return lines.join("\n") + "\n";
}

/**
 * `conceptTag` defaults to unset, which makes the mock always report the
 * same fixed tag ("test-concept-0" — see test/fixtures/mock-claude/claude)
 * — fine for a single `grasp scan` invocation covering several NEW
 * questions in one batch (generation always completes before any
 * answering happens, so memoization can never kick in mid-batch), but a
 * scenario that calls `grasp scan` MULTIPLE separate times and expects a
 * real "Concept question:" every time must pass a distinct `conceptTag`
 * per call — otherwise the first call's real answer legitimately (and
 * correctly, per brief §3.2) marks that tag mastered, and every later call
 * correctly skips straight to instance-only. That's real, working
 * memoization, not a bug — see crossCutting.e2e.ts for a dedicated test of
 * that behavior; this file is about scan mechanics, so most scenarios here
 * sidestep it with a fresh tag per run instead.
 */
function scanPty(home: string, repo: string, steps: PtyStep[], args: string[] = ["scan"], conceptTag?: string) {
  return runGraspPty(CLI_PATH, args, steps, { cwd: repo, env: graspEnv(home, { mode: "normal", cost: "0.001", conceptTag }), cols: 120, rows: 45 });
}

/** Answers ONE full concept+instance question via the shared review/scan UI. */
function answerOneQuestion(concept: string, instance: string): PtyStep[] {
  return [
    waitFor("Concept question:"),
    sendText(concept),
    sleepStep(0.3),
    sendText(Key.ENTER),
    waitFor("Press any key to continue"),
    sendText(Key.ENTER),
    waitFor("Instance question:"),
    sendText(instance),
    sleepStep(0.3),
    sendText(Key.ENTER),
    waitFor("Press any key to continue"),
    sendText(Key.ENTER),
  ];
}

export const scanScenarios = [
  scenario("scan: fully standalone (no live session), and generates the whole batch before presenting any of it", async () => {
    const repo = initScratchRepo();
    commitFile(repo, "a.ts", "export function a() {\n  return 1;\n}\n");
    commitFile(repo, "b.ts", "export function b() {\n  return 2;\n}\n");
    const home = isolatedHome();

    // Fire the pty run but DON'T await it yet — the whole point of this
    // check is to inspect the DB WHILE the interactive review is still in
    // progress (only the first of two questions has been ANSWERED so far),
    // to prove both were already GENERATED up front as one batch, not one-
    // at-a-time as the user progresses.
    const ptyPromise = scanPty(home, repo, [
      waitFor("Scanning up to"),
      ...answerOneQuestion("concept answer 1", "instance answer 1"),
      ...answerOneQuestion("concept answer 2", "instance answer 2"),
    ]);

    // Give both mock generation calls (near-instant, no network) generous
    // time to complete, well before a human could finish typing/submitting
    // the first answer.
    await sleep(3000);
    const midRunDb = new Database(dbPathFor(home), { readonly: true, fileMustExist: true });
    const midRunCount = (midRunDb.prepare(`SELECT COUNT(*) AS n FROM events WHERE question_type IS NOT NULL AND source = 'scan'`).get() as { n: number }).n;
    midRunDb.close();
    assert.equal(midRunCount, 2, "both files' questions must already be generated and persisted before the user finishes answering either one — batch-then-present, not incremental");

    const result = await ptyPromise;
    assert.equal(result.code, 0, `pty driver failed: ${result.stderr}`);

    const db = openHomeDb(home);
    const rows = db.prepare(`SELECT diff_summary, answer_concept, answer_instance FROM events WHERE source = 'scan' ORDER BY id ASC`).all() as any[];
    db.close();
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.answer_concept && r.answer_instance), "both questions must have been answered for real by the end of the run");
  }),

  scenario("scan: chunking a large file produces multiple real questions with correct absolute citations, interleaved with other directories", async () => {
    const repo = initScratchRepo();
    const bigLineCount = 2 * MAX_SCAN_CHUNK_LINES + 100; // 3 chunks: full, full, partial
    // Deliberately at the repo ROOT (round-robin group key "."), which
    // sorts alphabetically before any named subdirectory (see
    // src/scan.ts's orderFilesRoundRobin: group keys are sorted, and "."
    // sorts before any letter) — this guarantees the big file's FIRST chunk
    // is visited before docs/lib in pass 1, so its second chunk can only
    // happen in pass 2, with docs/lib's own questions genuinely landing in
    // between. If the big file's directory sorted AFTER docs/lib instead,
    // both small files would fully resolve within pass 1 before the big
    // file even got its first chunk, leaving nothing left to interleave
    // between chunks 1 and 2 — a real trap this scenario deliberately
    // avoids, matching the equivalent unit-level fixture naming in
    // test/scanWalk.test.ts ("big/file.ts" sorting before "small1"/"small2").
    commitFile(repo, "bigfile.ts", linesFile(bigLineCount, "big"));
    commitFile(repo, "docs/small.ts", "export function docsHelper() {\n  return 1;\n}\n");
    commitFile(repo, "lib/small.ts", "export function libHelper() {\n  return 2;\n}\n");
    const home = isolatedHome();

    const steps: PtyStep[] = [waitFor("Scanning up to")];
    for (let i = 0; i < 5; i++) {
      steps.push(...answerOneQuestion(`concept answer ${i}`, `instance answer ${i}`));
    }
    const result = await scanPty(home, repo, steps);
    assert.equal(result.code, 0, `pty driver failed: ${result.stderr}`);

    const db = openHomeDb(home);
    const rows = db.prepare(`SELECT id, diff_summary, scan_excerpt_start_line, scan_excerpt_lines_json FROM events WHERE source = 'scan' ORDER BY id ASC`).all() as any[];
    db.close();
    assert.equal(rows.length, 5, "3 chunks of the big file + 1 question each from the two small files = 5 real questions");

    const bigfileRows = rows.filter((r) => r.diff_summary === "bigfile.ts");
    assert.equal(bigfileRows.length, 3, "the big file must produce exactly 3 chunk-scoped questions, not one-shot-per-file");

    // Interleaving: at least one OTHER file's question must land, by
    // insertion order, strictly between bigfile's first and second chunk —
    // i.e. the big file's own sections are never processed back-to-back
    // before anything else gets a turn.
    const bigfileIds = bigfileRows.map((r) => r.id).sort((a, b) => a - b);
    const betweenFirstAndSecond = rows.filter((r) => r.id > bigfileIds[0] && r.id < bigfileIds[1] && r.diff_summary !== "bigfile.ts");
    assert.ok(betweenFirstAndSecond.length > 0, "another file's question must be interleaved between the big file's first and second chunk");

    // More than one top-level directory touched (a root-level file's own
    // "directory" is itself, distinct from docs/ and lib/).
    const topDirs = new Set(rows.map((r) => (r.diff_summary.includes("/") ? r.diff_summary.split("/")[0] : ".")));
    assert.ok(topDirs.size > 1, `expected more than one top-level directory touched, got: ${[...topDirs].join(", ")}`);
    assert.ok(topDirs.has("docs") && topDirs.has("lib"), "both docs/ and lib/ must have been touched, not just the root-level big file");

    // Correct absolute citations for NON-FIRST chunks — the exact off-by-one
    // bug class TEST_LOG.md's prior pass found (commit a4c43f8 fixed it for
    // the ceiling/message case; this independently re-verifies chunk
    // boundary math end to end through the real CLI).
    const realContent = fs.readFileSync(path.join(repo, "bigfile.ts"), "utf-8");
    const realLines = splitFileLines(realContent);
    const sortedBigfile = bigfileRows.slice().sort((a, b) => a.id - b.id);
    const expectedStarts = [1, MAX_SCAN_CHUNK_LINES + 1, 2 * MAX_SCAN_CHUNK_LINES + 1];
    sortedBigfile.forEach((row, i) => {
      assert.equal(row.scan_excerpt_start_line, expectedStarts[i], `chunk ${i}'s cited start line must be the file's real absolute line ${expectedStarts[i]}`);
      const citedLines: string[] = JSON.parse(row.scan_excerpt_lines_json);
      assert.ok(citedLines.length > 0, "a cited excerpt must not be empty");
      assert.equal(
        citedLines[0],
        realLines[row.scan_excerpt_start_line - 1],
        `chunk ${i}'s cited excerpt text must match the real file's content at that exact absolute line`
      );
    });
  }),

  scenario("scan: resumes chunk-by-chunk across MULTIPLE separate runs, not from the beginning, then reports nothing left", async () => {
    const repo = initScratchRepo();
    const bigLineCount = 2 * MAX_SCAN_CHUNK_LINES + 50;
    commitFile(repo, "onlyfile.ts", linesFile(bigLineCount, "resume"));
    const home = isolatedHome();
    const env = graspEnv(home);
    const capResult = runGraspCli(["set", "scan-cap", "1"], { cwd: repo, env });
    assert.equal(capResult.status, 0);

    const expectedStarts = [1, MAX_SCAN_CHUNK_LINES + 1, 2 * MAX_SCAN_CHUNK_LINES + 1];
    for (let run = 0; run < 3; run++) {
      // A distinct concept tag per run — each of these 3 separate `grasp
      // scan` invocations must present a real concept question, and the
      // PREVIOUS run's real answer would otherwise legitimately (correctly)
      // suppress a repeated fixed tag via memoization (see scanPty's own
      // doc comment above).
      const result = await scanPty(
        home,
        repo,
        [...answerOneQuestion(`resume answer concept ${run}`, `resume answer instance ${run}`)],
        ["scan"],
        `e2e-resume-tag-${run}`
      );
      assert.equal(result.code, 0, `run ${run}: pty driver failed: ${result.stderr}`);

      const db = openHomeDb(home);
      const rows = db.prepare(`SELECT scan_excerpt_start_line FROM events WHERE source = 'scan' ORDER BY id ASC`).all() as any[];
      db.close();
      assert.equal(rows.length, run + 1, `after run ${run + 1}, exactly ${run + 1} chunk question(s) should exist total`);
      assert.equal(
        rows[run].scan_excerpt_start_line,
        expectedStarts[run],
        `run ${run + 1} must resume from the NEXT unscanned chunk (absolute line ${expectedStarts[run]}), not restart from the beginning`
      );
    }

    // A 4th run has nothing left for this file. `grasp scan` requires a real
    // TTY even for this static a message (see src/scan.ts's own isTTY
    // guard), so this goes through the pty driver too, not a plain CLI call.
    const ptyFinal = await scanPty(home, repo, [waitFor("Nothing left to scan")]);
    assert.equal(ptyFinal.code, 0, `expected 'nothing left to scan' after full resumption: ${ptyFinal.stderr}`);
  }),

  scenario("scan: an oversized file (over the processing ceiling) is skipped with the correct, non-off-by-one line count", async () => {
    const repo = initScratchRepo();
    // 20,500 real lines, trailing newline — the EXACT repro shape TEST_LOG.md's
    // prior pass used to find the off-by-one bug commit a4c43f8 fixed
    // (fileLines.length used to report 20,501, one more than the real count).
    commitFile(repo, "vendor_dump.js", linesFile(20_500, "vendor"));
    const home = isolatedHome();

    // No mock claude needed on PATH for this — an oversized file must never
    // reach a judge call at all.
    const result = await scanPty(home, repo, [waitFor("processing ceiling")]);
    assert.equal(result.code, 0, `pty driver failed: ${result.stderr}`);
    assert.match(
      result.screen,
      /Skipped vendor_dump\.js — 20500 lines, over the 20000-line processing ceiling\./,
      "the skip message must report the file's REAL line count (20500), not an off-by-one-inflated one (20501)"
    );

    const db = openHomeDb(home);
    const eventCount = (db.prepare(`SELECT COUNT(*) AS n FROM events`).get() as { n: number }).n;
    db.close();
    assert.equal(eventCount, 0, "an oversized file must never reach a judge call");
  }),

  scenario("scan: hash-based re-scan — a meaningful hand-edit re-triggers a question, a trivial one doesn't", async () => {
    const repo = initScratchRepo();
    commitFile(repo, "edited.ts", "export function original() {\n  return 1;\n}\n");
    const home = isolatedHome();

    const firstRun = await scanPty(home, repo, [...answerOneQuestion("first concept", "first instance")], ["scan"], "e2e-rescan-tag-1");
    assert.equal(firstRun.code, 0, `pty driver failed: ${firstRun.stderr}`);

    const afterFirst = await scanPty(home, repo, [waitFor("Nothing left to scan")]);
    assert.equal(afterFirst.code, 0, "the file must report fully covered immediately after being answered");

    // A purely trivial (whitespace-only) hand-edit must be silently absorbed.
    writeFile(repo, "edited.ts", "export function original() {\n  return 1;\n}\n\n\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "whitespace only"]);
    const afterTrivial = await scanPty(home, repo, [waitFor("Nothing left to scan")]);
    assert.equal(afterTrivial.code, 0, "a whitespace-only edit must never re-trigger a question");

    const dbAfterTrivial = openHomeDb(home);
    const countAfterTrivial = (dbAfterTrivial.prepare(`SELECT COUNT(*) AS n FROM events WHERE source = 'scan'`).get() as { n: number }).n;
    dbAfterTrivial.close();
    assert.equal(countAfterTrivial, 1, "a trivial edit must not add a new scan question");

    // A genuinely meaningful hand-edit (real new logic) must re-trigger a fresh question.
    writeFile(
      repo,
      "edited.ts",
      "export function original() {\n  return 1;\n}\n\nexport function addedByHand() {\n  return 42;\n}\n\nexport function addedByHandExtra() {\n  return 43;\n}\n"
    );
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "real edit"]);
    const afterMeaningful = await scanPty(home, repo, [...answerOneQuestion("second concept", "second instance")], ["scan"], "e2e-rescan-tag-2");
    assert.equal(afterMeaningful.code, 0, `pty driver failed: ${afterMeaningful.stderr}`);

    const dbAfterMeaningful = openHomeDb(home);
    const countAfterMeaningful = (dbAfterMeaningful.prepare(`SELECT COUNT(*) AS n FROM events WHERE source = 'scan'`).get() as { n: number }).n;
    dbAfterMeaningful.close();
    assert.equal(countAfterMeaningful, 2, "a genuine hand-edit must produce a real NEW scan question");
  }),

  scenario("scan: run summary appears only when something new was processed, with its cost kept on a separate line", async () => {
    const repo = initScratchRepo();
    commitFile(repo, "sumfile.ts", "export function original() {\n  return 1;\n}\n");
    const home = isolatedHome();

    const result = await scanPty(home, repo, [...answerOneQuestion("summary concept", "summary instance"), waitFor("spent generating this run's summary")]);
    assert.equal(result.code, 0, `pty driver failed: ${result.stderr}`);
    assert.match(result.screen, /spent generating comprehension questions this scan\./, "the question-generation cost line must appear");
    assert.match(result.screen, /spent generating this run's summary\./, "the summary's own cost must be a visibly separate line");

    const again = await scanPty(home, repo, [waitFor("Nothing left to scan")]);
    assert.equal(again.code, 0, `pty driver failed: ${again.stderr}`);
    assert.ok(!again.screen.includes("spent generating this run's summary"), "a run with nothing new to process must never attempt (or show a cost for) a summary");
  }),

  scenario("scan --full: bypasses the question cap with a warning, never a y/N confirmation gate", async () => {
    const repo = initScratchRepo();
    commitFile(repo, "full1.ts", "export function one() {\n  return 1;\n}\n");
    commitFile(repo, "full2.ts", "export function two() {\n  return 2;\n}\n");
    const home = isolatedHome();
    const env = graspEnv(home);
    const capResult = runGraspCli(["set", "scan-cap", "1"], { cwd: repo, env });
    assert.equal(capResult.status, 0);

    const steps: PtyStep[] = [waitFor("--full bypasses the question cap"), ...answerOneQuestion("full concept 1", "full instance 1"), ...answerOneQuestion("full concept 2", "full instance 2")];
    const result = await scanPty(home, repo, steps, ["scan", "--full"]);
    assert.equal(result.code, 0, `--full must proceed straight to questions with no confirmation gate: ${result.stderr}`);
    assert.ok(!result.screen.includes("[y/N]"), "--full must never show a y/N confirmation gate");

    const db = openHomeDb(home);
    const count = (db.prepare(`SELECT COUNT(*) AS n FROM events WHERE source = 'scan'`).get() as { n: number }).n;
    db.close();
    assert.equal(count, 2, "--full must process both files despite a scanQuestionsCap of 1");
  }),

  scenario("scan: cross-source hint points at `grasp review`; untracked files are never included", async () => {
    const repo = initScratchRepo();
    commitFile(repo, "tracked.ts", "export function tracked() {\n  return 1;\n}\n");
    // A genuinely untracked file — never `git add`ed.
    writeFile(repo, "untracked_marker_file.ts", "export function UNTRACKED_MARKER_FUNCTION() {\n  return 999;\n}\n");
    const home = isolatedHome();

    const db = openHomeDb(home);
    insertEvent(db, {
      timestamp: new Date().toISOString(),
      repo,
      sessionId: "e2e-crosshint-session",
      diffHash: "abc",
      diffSummary: "1 file changed",
      questionConcept: "concept q",
      questionInstance: "instance q",
      questionType: "both",
      generationSource: "e2e-seed",
      missReason: null,
      answerConcept: null,
      answerInstance: null,
      skipped: false,
      skipReason: null,
      costUsd: 0.001,
      diffFiles: [],
    });
    db.close();

    const result = await scanPty(home, repo, [waitFor("grasp review"), ...answerOneQuestion("crosshint concept", "crosshint instance")]);
    assert.equal(result.code, 0, `expected the cross-hint pointing at grasp review: ${result.stderr}`);
    assert.ok(!result.screen.includes("UNTRACKED_MARKER_FUNCTION"), "an untracked file must never be included in a scan");

    const dbAfter = openHomeDb(home);
    const scanRows = dbAfter.prepare(`SELECT diff_summary FROM events WHERE source = 'scan'`).all() as any[];
    dbAfter.close();
    assert.ok(
      scanRows.every((r) => r.diff_summary !== "untracked_marker_file.ts"),
      "the untracked file must never appear as a scanned file"
    );
  }),
];
