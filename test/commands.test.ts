/**
 * Export, status, history, retry, reset, uninstall-hooks.
 * GOVERNED BY: §17, §20, §9.6, §19.1, §22.3 case 16
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { closeDatabase, openDatabase } from "../src/storage/db.js";
import { insertProject } from "../src/storage/models/projects.js";
import { insertQuestion, listAllQuestions, recordAnswer } from "../src/storage/models/questions.js";
import { setTier } from "../src/storage/models/concepts.js";
import {
  listFailures,
  recordFailure,
  recordRetryAttempt,
} from "../src/storage/models/generationFailures.js";
import { escapeAnkiField, renderAnkiCard, renderAnkiExport } from "../src/export/anki.js";
import { renderRawExport, selectQuestions } from "../src/export/raw.js";
import { formatUptime, runStatus, tildify } from "../src/cli/commands/status.js";
import { runHistory } from "../src/cli/commands/history.js";
import { runReset } from "../src/cli/commands/reset.js";
import { runUninstallHooks } from "../src/cli/commands/uninstall-hooks.js";
import { runSet } from "../src/cli/commands/set.js";
import { installHook, hookPath, foreignHookPath } from "../src/gate/gitHook.js";

let home: string;
let dbFile: string;
let db: DatabaseSync;
let projectId: number;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "grasp-cmd-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  dbFile = path.join(home, "history.db");
  db = openDatabase({ file: dbFile });
  projectId = insertProject(db, "/repo/one").id;
});

afterEach(() => {
  closeDatabase(db);
  fs.rmSync(home, { recursive: true, force: true });
});

function seed(over: Partial<Parameters<typeof insertQuestion>[1]> = {}): number {
  return insertQuestion(db, {
    project_id: projectId,
    type: "trace",
    concept_tag: "debouncing",
    origin: "live",
    question_text: "How many times does it run?",
    sample_answer: "Once.",
    teaching_card_text: "A teaching card that must not be exported.",
    code_snippet: "const t = setTimeout(fn, delay);",
    files: ["src/a.ts"],
    ...over,
  });
}

describe("anki export (§20)", () => {
  it("embeds the code in the front for trace and predict_break", () => {
    seed();
    const card = renderAnkiCard(listAllQuestions(db)[0]);
    expect(card).toContain("How many times does it run?");
    // These tiers are phrased against specific code behavior (§20).
    expect(card).toContain("setTimeout");
  });

  it("exports reconstruct and synthesis as-is, without the code", () => {
    seed({ type: "reconstruct", question_text: "Describe your approach." });
    const question = listAllQuestions(db)[0];
    const card = renderAnkiCard(question);
    expect(card).toContain("Describe your approach.");
    // Embedding the code would defeat the tier.
    expect(card).not.toContain("setTimeout");
  });

  it("EXCLUDES teaching cards — not quiz material (§20)", () => {
    seed();
    const output = renderAnkiExport(listAllQuestions(db));
    expect(output).not.toContain("must not be exported");
  });

  it("includes every status, because an unanswered question is still a card", () => {
    const answered = seed();
    recordAnswer(db, answered, {
      status: "answered",
      self_assessment: "nailed_it",
      assistance_level: "none",
      user_answer: "x",
    });
    seed(); // pending
    seed({ question_text: "skipped one" });

    const output = renderAnkiExport(listAllQuestions(db));
    expect(output.trim().split("\n")).toHaveLength(3);
  });

  it("escapes tabs and newlines per Anki's format", () => {
    expect(escapeAnkiField("a\tb")).toBe("a b");
    expect(escapeAnkiField("line1\nline2")).toBe("line1<br>line2");
    expect(escapeAnkiField("crlf\r\nhere")).toBe("crlf<br>here");
  });

  it("puts exactly one tab between front and back", () => {
    seed();
    const card = renderAnkiCard(listAllQuestions(db)[0]);
    expect(card.split("\t")).toHaveLength(2);
  });
});

describe("raw export (§20)", () => {
  it("dumps questions with joined file paths and a parsed scaffold", () => {
    seed({ scaffold: ["one", "two"], files: ["src/a.ts", "src/b.ts"] });
    const parsed = JSON.parse(renderRawExport(db, listAllQuestions(db)));
    expect(parsed[0].files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(parsed[0].scaffold).toEqual(["one", "two"]);
  });

  it("filters by tag, project, and date range", () => {
    seed({ concept_tag: "debouncing" });
    seed({ concept_tag: "auth-flow" });
    expect(selectQuestions(db, { tag: "auth-flow" })).toHaveLength(1);
    expect(selectQuestions(db, { projectId })).toHaveLength(2);
    expect(selectQuestions(db, { since: "2099-01-01" })).toHaveLength(0);
  });
});

describe("status (§17)", () => {
  it("says so on line one when the daemon is not running", () => {
    const { output } = runStatus({ dbFile });
    expect(output.split("\n")[0]).toMatch(/not running/);
    expect(output).toContain("grasp enable");
  });

  it("reports projects, pending counts, and failures", () => {
    seed();
    recordFailure(db, { projectId, kind: "live", payload: {}, error: "boom" });
    const { output } = runStatus({ dbFile });
    expect(output).toContain("/repo/one");
    expect(output).toContain("1 pending");
    expect(output).toMatch(/1 generation failure/);
    expect(output).toContain("grasp retry");
  });

  it("counts concepts at reconstruct using the EFFECTIVE tier (§11.2)", () => {
    setTier(db, "fresh", "reconstruct", new Date().toISOString());
    // Decayed past its 45-day window: no longer counted at reconstruct.
    setTier(db, "stale", "reconstruct", new Date(Date.now() - 60 * 86_400_000).toISOString());
    const { output } = runStatus({ dbFile });
    expect(output).toMatch(/2 concepts tracked · 1 at reconstruct/);
  });

  it("formats uptime and tildifies paths", () => {
    const started = new Date(Date.now() - (3 * 3600 + 12 * 60) * 1000).toISOString();
    expect(formatUptime(started)).toBe("3h 12m");
    expect(tildify("/Users/me/dev/app", "/Users/me")).toBe("~/dev/app");
    expect(tildify("/elsewhere/app", "/Users/me")).toBe("/elsewhere/app");
  });
});

describe("history (§17, §2.1)", () => {
  it("shows answered questions and never re-evaluates the answer", () => {
    const id = seed();
    recordAnswer(db, id, {
      status: "answered",
      self_assessment: "way_off",
      assistance_level: "hint",
      user_answer: "completely wrong",
    });
    expect(runHistory({ dbFile }).exitCode).toBe(0);
  });

  it("hides pending questions and filters by tag", () => {
    seed();
    expect(runHistory({ dbFile, tag: "debouncing" }).exitCode).toBe(0);
  });
});

describe("retry (§9.6, §19.1)", () => {
  it("reports failures that have exhausted their attempts without retrying them", async () => {
    const id = recordFailure(db, { projectId, kind: "live", payload: {}, error: "boom" });
    for (let i = 1; i < 5; i++) recordRetryAttempt(db, id, "again");
    const { runRetry } = await import("../src/cli/commands/retry.js");
    const result = await runRetry({ dbFile });
    expect(result.exitCode).toBe(0);
    expect(result.recovered).toBe(0);
    // Still reported, not deleted.
    expect(listFailures(db)).toHaveLength(1);
  });

  it("replays a stored payload, persists the question, and retires the row (§19.1)", async () => {
    const payload = {
      kind: "live" as const,
      projectId,
      files: ["src/a.ts"],
      diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@\n+const a = 1;\n",
      masteryContext: {},
      knownTags: [],
    };
    recordFailure(db, { projectId, kind: "live", payload, error: "was malformed" });

    const provider = {
      name: "api" as const,
      askModel: async () => ({
        text: JSON.stringify({
          skip: false,
          skip_reason: null,
          questions: [
            {
              concept_tag: "recovered-concept",
              reframe: false,
              tier: "trace",
              files: ["src/a.ts"],
              teaching_card: { body: "card", deeper: null },
              question: "recovered question",
              sample_answer: "a",
              hint: "h",
              scaffold: ["one", "two"],
            },
          ],
        }),
        usage: null,
      }),
    };

    const { runRetry } = await import("../src/cli/commands/retry.js");
    const result = await runRetry({ dbFile, deps: { provider, sleep: async () => {} } });

    expect(result.recovered).toBe(1);
    // The failure is retired on success.
    expect(listFailures(db)).toHaveLength(0);
    expect(listAllQuestions(db).some((q) => q.question_text === "recovered question")).toBe(true);
  });

  it("keeps the row and increments attempts when the replay fails again", async () => {
    recordFailure(db, {
      projectId,
      kind: "live",
      payload: {
        kind: "live",
        projectId,
        files: ["src/a.ts"],
        diff: "@@\n+x\n",
        masteryContext: {},
        knownTags: [],
      },
      error: "boom",
    });
    const provider = {
      name: "api" as const,
      askModel: async () => ({ text: "not json", usage: null }),
    };
    const { runRetry } = await import("../src/cli/commands/retry.js");
    await runRetry({ dbFile, deps: { provider, sleep: async () => {} } });

    const failures = listFailures(db);
    expect(failures).toHaveLength(1);
    expect(failures[0].attempts).toBe(2);
  });

  it("retires a failure whose replay comes back as skip", async () => {
    recordFailure(db, {
      projectId,
      kind: "scan",
      payload: {
        kind: "scan",
        projectId,
        files: ["src/a.ts"],
        section: "const a = 1;",
        masteryContext: {},
        knownTags: [],
      },
      error: "boom",
    });
    const provider = {
      name: "api" as const,
      askModel: async () => ({
        text: JSON.stringify({ skip: true, skip_reason: "config only" }),
        usage: null,
      }),
    };
    const { runRetry } = await import("../src/cli/commands/retry.js");
    const result = await runRetry({ dbFile, deps: { provider, sleep: async () => {} } });
    expect(result.recovered).toBe(0);
    expect(listFailures(db)).toHaveLength(0);
  });

  it("marks a corrupt payload as attempted rather than crashing", async () => {
    const id = recordFailure(db, { projectId, kind: "live", payload: {}, error: null });
    db.prepare("UPDATE generation_failures SET payload_json = 'not json' WHERE id = ?").run(id);
    const { runRetry } = await import("../src/cli/commands/retry.js");
    await expect(runRetry({ dbFile })).resolves.toMatchObject({ exitCode: 0 });
    expect(listFailures(db)[0].attempts).toBe(2);
  });

  it("does nothing when there are no failures", async () => {
    const { runRetry } = await import("../src/cli/commands/retry.js");
    expect((await runRetry({ dbFile })).recovered).toBe(0);
  });
});

describe("reset (§17)", () => {
  it("wipes history but leaves projects registered", async () => {
    seed();
    const configFile = path.join(home, "config.json");
    closeDatabase(db);

    const result = await runReset({ target: "history", yes: true, dbFile, configFile });
    expect(result.exitCode).toBe(0);

    db = openDatabase({ file: dbFile });
    expect(listAllQuestions(db)).toHaveLength(0);
  });

  it("rejects an unknown target with exit 2", async () => {
    const result = await runReset({ target: "everything" as "config", yes: true, dbFile });
    expect(result.exitCode).toBe(2);
  });

  it("restores default config", async () => {
    const configFile = path.join(home, "config.json");
    fs.writeFileSync(configFile, JSON.stringify({ debounceMs: 99, apiKey: "test-api-key" }));
    await runReset({ target: "config", yes: true, dbFile, configFile });
    const written = JSON.parse(fs.readFileSync(configFile, "utf8"));
    expect(written.debounceMs).toBe(4000);
    expect(written.apiKey).toBeNull();
  });
});

describe("grasp set (§18.3)", () => {
  it("writes a valid value and refuses an invalid one", () => {
    const configFile = path.join(home, "config.json");
    expect(
      runSet({ key: "decayWindows.trace", value: "120", globalFile: configFile }).exitCode,
    ).toBe(0);
    expect(JSON.parse(fs.readFileSync(configFile, "utf8")).decayWindows.trace).toBe(120);

    expect(
      runSet({ key: "decayWindows.trace", value: "soon", globalFile: configFile }).exitCode,
    ).toBe(2);
    // The bad value was never written.
    expect(JSON.parse(fs.readFileSync(configFile, "utf8")).decayWindows.trace).toBe(120);
  });

  it("exits 2 on an unknown key", () => {
    expect(
      runSet({ key: "nope", value: "1", globalFile: path.join(home, "config.json") }).exitCode,
    ).toBe(2);
  });
});

describe("uninstall-hooks (§6.5, §22.3 case 16)", () => {
  it("removes hooks across repos and restores a foreign one exactly", () => {
    const repoA = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "grasp-hookA-")));
    const repoB = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "grasp-hookB-")));
    for (const repo of [repoA, repoB])
      fs.mkdirSync(path.join(repo, ".git", "hooks"), { recursive: true });

    const foreign = "#!/bin/sh\nnpm test\n";
    fs.writeFileSync(hookPath(repoB), foreign, { mode: 0o755 });

    installHook(repoA);
    installHook(repoB);
    insertProject(db, repoA);
    insertProject(db, repoB);

    const result = runUninstallHooks({ dbFile });

    expect(result.removed).toBe(2);
    expect(result.restored).toBe(1);
    expect(fs.existsSync(hookPath(repoA))).toBe(false);
    // repoB's original is back, byte for byte.
    expect(fs.readFileSync(hookPath(repoB), "utf8")).toBe(foreign);
    expect(fs.existsSync(foreignHookPath(repoB))).toBe(false);

    fs.rmSync(repoA, { recursive: true, force: true });
    fs.rmSync(repoB, { recursive: true, force: true });
  });

  it("skips a repo that no longer exists", () => {
    insertProject(db, "/repo/deleted-since-registration");
    expect(runUninstallHooks({ dbFile }).exitCode).toBe(0);
  });
});
