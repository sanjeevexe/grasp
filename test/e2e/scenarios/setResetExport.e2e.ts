import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { scenario } from "../lib/scenario";
import { initScratchRepo, isolatedHome, graspEnv, commitFile, CLI_PATH } from "../lib/env";
import { runGraspCli } from "../lib/cli";
import { runGraspPty, waitFor, sendText, Key } from "../lib/ptyDriver";
import { openHomeDb } from "../lib/db";
import { insertEvent, getHistoryRowCounts } from "../../../src/store";
import { parseCsv } from "../lib/csv";

/**
 * `grasp set`/`grasp reset`/`grasp export` — every subcommand, local and
 * `--global`, config-file preservation of unrelated keys, `reset history`'s
 * interactive y/N confirmation driven for real via piped (non-TTY, but
 * still readline-driven — see cli.ts's own doc comment) stdin, and all
 * three export shapes producing valid, correctly-quoted CSVs.
 */

export const setResetExportScenarios = [
  scenario("set: mode/gate/questions-cap/scan-cap all write only their own key, local and --global, preserving unrelated keys", async () => {
    const repo = initScratchRepo();
    commitFile(repo, "README.md", "# scratch\n");
    const home = isolatedHome();
    const env = graspEnv(home);

    // Hand-edit an unrelated key into .grasp.json first.
    const repoConfigPath = path.join(repo, ".grasp.json");
    fs.writeFileSync(repoConfigPath, JSON.stringify({ ignorePatterns: ["vendor/"] }, null, 2), "utf-8");

    const setModeResult = runGraspCli(["set", "mode", "--hard"], { cwd: repo, env });
    assert.equal(setModeResult.status, 0, `stderr=${setModeResult.stderr}`);
    let repoConfig = JSON.parse(fs.readFileSync(repoConfigPath, "utf-8"));
    assert.equal(repoConfig.difficultyMode, "hard");
    assert.deepEqual(repoConfig.ignorePatterns, ["vendor/"], "an unrelated pre-existing key must survive `grasp set mode`");

    const setCapResult = runGraspCli(["set", "questions-cap", "4"], { cwd: repo, env });
    assert.equal(setCapResult.status, 0);
    repoConfig = JSON.parse(fs.readFileSync(repoConfigPath, "utf-8"));
    assert.equal(repoConfig.questionsPerSessionCap, 4);
    assert.equal(repoConfig.difficultyMode, "hard", "an earlier grasp set must survive a later, different grasp set");

    const setScanCapResult = runGraspCli(["set", "scan-cap", "3"], { cwd: repo, env });
    assert.equal(setScanCapResult.status, 0);
    repoConfig = JSON.parse(fs.readFileSync(repoConfigPath, "utf-8"));
    assert.equal(repoConfig.scanQuestionsCap, 3);

    // --global writes to ~/.grasp/config.json, independent of the repo file.
    const globalConfigPath = path.join(home, ".grasp", "config.json");
    // Hand-edit an unrelated key into the global config too.
    const existingGlobal = JSON.parse(fs.readFileSync(globalConfigPath, "utf-8"));
    fs.writeFileSync(globalConfigPath, JSON.stringify({ ...existingGlobal, ignorePatterns: ["global-vendor/"] }, null, 2), "utf-8");

    const setGateGlobal = runGraspCli(["set", "gate", "hard", "--global"], { cwd: repo, env });
    assert.equal(setGateGlobal.status, 0, `stderr=${setGateGlobal.stderr}`);
    const globalConfig = JSON.parse(fs.readFileSync(globalConfigPath, "utf-8"));
    assert.equal(globalConfig.gateMode, "hard");
    assert.deepEqual(globalConfig.ignorePatterns, ["global-vendor/"], "an unrelated key must survive a --global set too");

    // Invalid values are rejected with a usage message, never silently written.
    const beforeBad = fs.readFileSync(repoConfigPath, "utf-8");
    for (const bad of ["0", "-1", "abc"]) {
      const badResult = runGraspCli(["set", "questions-cap", bad], { cwd: repo, env });
      assert.notEqual(badResult.status, 0, `questions-cap ${bad} must be rejected`);
      assert.match(badResult.stderr, /Usage: grasp set questions-cap/);
    }
    for (const bad of ["0", "-1", "abc"]) {
      const badResult = runGraspCli(["set", "scan-cap", bad], { cwd: repo, env });
      assert.notEqual(badResult.status, 0, `scan-cap ${bad} must be rejected`);
      assert.match(badResult.stderr, /Usage: grasp set scan-cap/);
    }
    assert.equal(fs.readFileSync(repoConfigPath, "utf-8"), beforeBad, "a rejected value must never touch the config file");
  }),

  scenario("reset: `reset config` deletes the local file, `reset config --global` overwrites defaults", async () => {
    const repo = initScratchRepo();
    commitFile(repo, "README.md", "# scratch\n");
    const home = isolatedHome();
    const env = graspEnv(home);

    runGraspCli(["set", "mode", "--easy"], { cwd: repo, env });
    const repoConfigPath = path.join(repo, ".grasp.json");
    assert.ok(fs.existsSync(repoConfigPath));

    const resetLocal = runGraspCli(["reset", "config"], { cwd: repo, env });
    assert.equal(resetLocal.status, 0, `stderr=${resetLocal.stderr}`);
    assert.ok(!fs.existsSync(repoConfigPath), "`grasp reset config` (local) must DELETE .grasp.json, not leave an empty file");

    runGraspCli(["set", "gate", "hard", "--global"], { cwd: repo, env });
    const globalConfigPath = path.join(home, ".grasp", "config.json");
    const beforeReset = JSON.parse(fs.readFileSync(globalConfigPath, "utf-8"));
    assert.equal(beforeReset.gateMode, "hard");

    const resetGlobal = runGraspCli(["reset", "config", "--global"], { cwd: repo, env });
    assert.equal(resetGlobal.status, 0);
    const afterReset = JSON.parse(fs.readFileSync(globalConfigPath, "utf-8"));
    assert.equal(afterReset.gateMode, "soft", "`--global` must overwrite back to real defaults");
    assert.equal(afterReset.scanQuestionsCap, 15);
  }),

  scenario("reset: `reset history` asks for real y/N confirmation via piped stdin — N deletes nothing, --yes bypasses and deletes", async () => {
    const repo = initScratchRepo();
    commitFile(repo, "README.md", "# scratch\n");
    const home = isolatedHome();
    const env = graspEnv(home);

    // Ensure ~/.grasp exists (some prior command must run first, or reset
    // history's own openDb() creates it fresh with nothing to delete).
    runGraspCli(["--version"], { cwd: repo, env });

    const db = openHomeDb(home);
    insertEvent(db, {
      timestamp: new Date().toISOString(),
      repo,
      sessionId: "e2e-reset-history-session",
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
    }, [{ tag: "e2e-reset-tag", answered: false }]);
    db.close();

    const before = openHomeDb(home);
    const beforeCounts = getHistoryRowCounts(before);
    before.close();
    assert.ok(beforeCounts.events >= 1);

    const declineResult = runGraspCli(["reset", "history"], { cwd: repo, env, input: "N\n" });
    assert.equal(declineResult.status, 0, `stderr=${declineResult.stderr}`);
    assert.match(declineResult.stdout, /Aborted — no history was deleted\./);
    assert.match(declineResult.stdout, new RegExp(`${beforeCounts.events} event row`), "the confirmation prompt must show the real row counts about to be deleted");

    const afterDecline = openHomeDb(home);
    const afterDeclineCounts = getHistoryRowCounts(afterDecline);
    afterDecline.close();
    assert.deepEqual(afterDeclineCounts, beforeCounts, "declining must leave every row untouched");

    // Same decline, but this time driven through a genuine real pty session
    // (not just piped stdin) — the task's own explicit ask for "driven for
    // real via pty," not only the --yes bypass. readline (what `reset
    // history` actually uses) behaves identically over piped vs. real-TTY
    // stdin for line-based input, unlike ink's raw-mode reads (see
    // lib/cli.ts's own doc comment) — this pty run exists specifically to
    // remove any doubt about that, not because piped input was insufficient.
    const ptyDecline = await runGraspPty(CLI_PATH, ["reset", "history"], [waitFor("Continue? [y/N]"), sendText(Key.ENTER)], { cwd: repo, env, cols: 120, rows: 20 });
    assert.equal(ptyDecline.code, 0, `pty driver failed: ${ptyDecline.stderr}`);
    assert.match(ptyDecline.screen, /Aborted — no history was deleted\./, "a bare Enter (empty answer, defaults to N) over a real pty must decline, same as piped 'N'");
    const afterPtyDecline = openHomeDb(home);
    const afterPtyDeclineCounts = getHistoryRowCounts(afterPtyDecline);
    afterPtyDecline.close();
    assert.deepEqual(afterPtyDeclineCounts, beforeCounts, "a real pty-driven decline must also leave every row untouched");

    const yesResult = runGraspCli(["reset", "history", "--yes"], { cwd: repo, env });
    assert.equal(yesResult.status, 0, `stderr=${yesResult.stderr}`);
    assert.match(yesResult.stdout, /Deleted \d+ event row/);

    const afterYes = openHomeDb(home);
    const afterYesCounts = getHistoryRowCounts(afterYes);
    afterYes.close();
    assert.equal(afterYesCounts.events, 0);
    assert.equal(afterYesCounts.conceptTags, 0);
  }),

  scenario("export: default/--anki/--raw all produce valid, correctly-quoted CSVs with a real source column/tag", async () => {
    const repo = initScratchRepo();
    commitFile(repo, "README.md", "# scratch\n");
    const home = isolatedHome();
    const env = graspEnv(home);
    runGraspCli(["--version"], { cwd: repo, env });

    const db = openHomeDb(home);
    // Deliberately tricky content: an embedded comma, an embedded double
    // quote, and an embedded newline — the exact three things RFC 4180
    // quoting exists for.
    insertEvent(
      db,
      {
        timestamp: "2026-01-01T00:00:00.000Z",
        repo,
        sessionId: "e2e-export-session",
        diffHash: "abc",
        diffSummary: "1 file changed",
        questionConcept: 'What is a "mutex", exactly?',
        questionInstance: "Given that,\nwhy was one used here, and not a channel, semaphore, or lock?",
        questionType: "both",
        generationSource: "e2e-seed",
        missReason: null,
        answerConcept: "a lock, sort of",
        answerInstance: 'because "exclusion", commas, and newlines\nall need to round-trip',
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
    insertEvent(
      db,
      {
        timestamp: "2026-01-02T00:00:00.000Z",
        repo,
        sessionId: "e2e-export-scan-session",
        diffHash: null,
        diffSummary: "src/example.ts",
        questionConcept: "What is recursion?",
        questionInstance: "Where does this file use it?",
        questionType: "both",
        generationSource: "e2e-seed",
        missReason: null,
        answerConcept: null,
        answerInstance: null,
        skipped: true,
        skipReason: null,
        costUsd: 0.001,
        diffFiles: null,
        sampleAnswerConcept: "A function calling itself.",
        sampleAnswerInstance: "In the tree-walk helper.",
        conceptExplanation: "explanation",
        source: "scan",
      },
      [{ tag: "recursion", answered: false }]
    );
    db.close();

    const defaultResult = runGraspCli(["export"], { cwd: repo, env });
    assert.equal(defaultResult.status, 0, `stderr=${defaultResult.stderr}`);
    const defaultMatch = defaultResult.stdout.match(/Wrote (\d+) row\(s\) to (.+\.csv)/);
    assert.ok(defaultMatch, "grasp export must report a written file path");
    assert.ok(!defaultResult.stdout.includes("Import into Anki"), "the default shape must not mention Anki import");
    const defaultPath = defaultMatch![2].trim();
    const defaultRows = parseCsv(fs.readFileSync(defaultPath, "utf-8"));
    assert.equal(defaultRows[0][0], "concept_tags");
    assert.ok(defaultRows[0].includes("source"), "default shape header must include a source column");
    const sourceCol = defaultRows[0].indexOf("source");
    const sources = defaultRows.slice(1).map((r) => r[sourceCol]);
    assert.ok(sources.includes("diff") && sources.includes("scan"), "must include both a diff-sourced and a scan-sourced row");
    const trickyRow = defaultRows.slice(1).find((r) => r.some((cell) => cell.includes("mutex")));
    assert.ok(trickyRow, "the tricky-content row must round-trip and be findable");
    assert.ok(
      trickyRow!.some((cell) => cell.includes('"mutex"')),
      "an embedded double quote must survive the CSV round-trip"
    );
    assert.ok(
      trickyRow!.some((cell) => cell.includes("\n")),
      "an embedded newline must survive the CSV round-trip"
    );

    // Two runs must never collide/overwrite — each export is its own timestamped file.
    const secondDefault = runGraspCli(["export"], { cwd: repo, env });
    const secondMatch = secondDefault.stdout.match(/Wrote \d+ row\(s\) to (.+\.csv)/);
    assert.ok(secondMatch);
    assert.notEqual(secondMatch![1].trim(), defaultPath, "two export runs must produce two different files, not overwrite one");

    const ankiResult = runGraspCli(["export", "--anki"], { cwd: repo, env });
    assert.equal(ankiResult.status, 0);
    assert.match(ankiResult.stdout, /Import into Anki via File > Import/, "the --anki shape's output must specifically mention Anki import");
    const ankiMatch = ankiResult.stdout.match(/Wrote \d+ row\(s\) to (.+\.csv)/);
    const ankiRows = parseCsv(fs.readFileSync(ankiMatch![1].trim(), "utf-8"));
    assert.deepEqual(ankiRows[0], ["Front", "Back", "Tags"], "the anki shape must stay exactly 3 columns");
    assert.ok(ankiRows.slice(1).some((r) => r[2].includes("source:diff")));
    assert.ok(ankiRows.slice(1).some((r) => r[2].includes("source:scan")));

    const rawResult = runGraspCli(["export", "--raw"], { cwd: repo, env });
    assert.equal(rawResult.status, 0);
    assert.ok(!rawResult.stdout.includes("Import into Anki"), "the --raw shape must not mention Anki import either");
    const rawMatch = rawResult.stdout.match(/Wrote \d+ row\(s\) to (.+\.csv)/);
    const rawRows = parseCsv(fs.readFileSync(rawMatch![1].trim(), "utf-8"));
    assert.ok(rawRows[0].includes("source"), "raw shape must expose every raw column, including source");
    assert.ok(rawRows[0].includes("scan_excerpt_start_line"));

    // Both/neither at once is rejected.
    const badFlags = runGraspCli(["export", "--anki", "--raw"], { cwd: repo, env });
    assert.notEqual(badFlags.status, 0);
    assert.match(badFlags.stderr, /pick at most one/);
  }),
];
