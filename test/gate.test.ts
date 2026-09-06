/**
 * Hook install/chain/remove and staged-file scoping.
 * GOVERNED BY: §13.2, §13.3, §13.4, §22.2, §22.3 case 16
 *
 * §13.3 is the last verify-deliberately item: only questions tied to files in
 * THIS commit may block it.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { closeDatabase, openDatabase } from "../src/storage/db.js";
import { insertProject } from "../src/storage/models/projects.js";
import { insertQuestion, recordAnswer } from "../src/storage/models/questions.js";
import {
  FOREIGN_HOOK_SUFFIX,
  HOOK_MARKER,
  foreignHookPath,
  hookPath,
  installHook,
  isGraspHook,
  questionsBlockingCommit,
  removeHook,
  renderBlockedMessage,
  renderHook,
  stagedFiles,
  type GitRunner,
} from "../src/gate/gitHook.js";
import { resolveGateMode, syncHookForMode } from "../src/gate/gateModes.js";
import { runPrecommit } from "../src/cli/commands/precommit.js";

let home: string;
let repo: string;
let db: DatabaseSync;
let dbFile: string;
let projectId: number;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "grasp-gate-home-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "grasp-gate-repo-")));
  fs.mkdirSync(path.join(repo, ".git", "hooks"), { recursive: true });
  dbFile = path.join(home, "history.db");
  db = openDatabase({ file: dbFile });
  projectId = insertProject(db, repo).id;
});

afterEach(() => {
  closeDatabase(db);
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

function seed(over: Partial<Parameters<typeof insertQuestion>[1]> = {}): number {
  return insertQuestion(db, {
    project_id: projectId,
    type: "trace",
    concept_tag: "auth-flow",
    origin: "live",
    question_text:
      "what happens if the token has expired before the refresh completes and the retry fires",
    sample_answer: "a",
    files: ["src/auth/middleware.js"],
    ...over,
  });
}

const gitReturning =
  (files: string[]): GitRunner =>
  async () =>
    files.join("\n");

describe("hook installation and chaining (§13.2)", () => {
  it("writes an executable hook carrying the marker and calling the hidden command", () => {
    installHook(repo);
    const contents = fs.readFileSync(hookPath(repo), "utf8");

    expect(contents).toContain(HOOK_MARKER);
    // The body invokes the command so behavior updates with the package.
    expect(contents).toContain("grasp __precommit");
    if (process.platform !== "win32") {
      expect(fs.statSync(hookPath(repo)).mode & 0o777).toBe(0o755);
    }
  });

  it("recognizes its own hook and does not double-install (§13.2)", () => {
    installHook(repo);
    const first = fs.readFileSync(hookPath(repo), "utf8");
    const second = installHook(repo);

    expect(second.alreadyInstalled).toBe(true);
    expect(fs.readFileSync(hookPath(repo), "utf8")).toBe(first);
    // A foreign copy was never made from our own hook.
    expect(fs.existsSync(foreignHookPath(repo))).toBe(false);
  });

  it("chains a foreign hook, running it FIRST with its failure winning", () => {
    const foreign = "#!/bin/sh\necho existing\nexit 0\n";
    fs.writeFileSync(hookPath(repo), foreign, { mode: 0o755 });

    const result = installHook(repo);
    expect(result.chainedForeign).toBe(true);
    // The original is preserved byte for byte, never clobbered.
    expect(fs.readFileSync(foreignHookPath(repo), "utf8")).toBe(foreign);

    const contents = fs.readFileSync(hookPath(repo), "utf8");
    const foreignCall = contents.indexOf(FOREIGN_HOOK_SUFFIX);
    const graspCall = contents.indexOf("grasp __precommit");
    expect(foreignCall).toBeGreaterThan(-1);
    expect(foreignCall).toBeLessThan(graspCall); // foreign runs first
    expect(contents).toContain("|| exit $?"); // and short-circuits on failure
  });

  it("restores the foreign hook exactly on removal (§22.3 case 16)", () => {
    const foreign = "#!/bin/sh\nexit 0\n";
    fs.writeFileSync(hookPath(repo), foreign, { mode: 0o755 });
    installHook(repo);

    const result = removeHook(repo);
    expect(result.restoredForeign).toBe(true);
    expect(fs.readFileSync(hookPath(repo), "utf8")).toBe(foreign);
    expect(fs.existsSync(foreignHookPath(repo))).toBe(false);
  });

  it("never deletes a hook that is not Grasp's", () => {
    const foreign = "#!/bin/sh\nexit 0\n";
    fs.writeFileSync(hookPath(repo), foreign, { mode: 0o755 });
    const result = removeHook(repo);
    expect(result.removed).toBe(false);
    expect(fs.readFileSync(hookPath(repo), "utf8")).toBe(foreign);
  });

  it("identifies Grasp hooks by marker", () => {
    expect(isGraspHook(renderHook(false))).toBe(true);
    expect(isGraspHook("#!/bin/sh\nnpm test\n")).toBe(false);
  });
});

describe("gate modes (§13, §13.1)", () => {
  it("prefers the project setting over the global default", () => {
    expect(resolveGateMode("hard", "soft")).toBe("hard");
    expect(resolveGateMode(null, "warn")).toBe("warn");
  });

  it("installs the hook for warn and hard, removes it for soft", () => {
    expect(syncHookForMode(repo, "hard").hookPresent).toBe(true);
    expect(fs.existsSync(hookPath(repo))).toBe(true);

    expect(syncHookForMode(repo, "soft").hookPresent).toBe(false);
    expect(fs.existsSync(hookPath(repo))).toBe(false);

    expect(syncHookForMode(repo, "warn").hookPresent).toBe(true);
  });
});

describe("hooks follow the gate mode (§13.1)", () => {
  it("`grasp set gateMode` installs and removes hooks across registered repos", async () => {
    const { runSet } = await import("../src/cli/commands/set.js");
    const configFile = path.join(home, "config.json");
    const dbFile = path.join(home, "history.db");
    closeDatabase(db);

    // hard → the hook must appear without waiting for the next init.
    expect(
      runSet({ key: "gateMode", value: "hard", globalFile: configFile, dbFile }).exitCode,
    ).toBe(0);
    expect(fs.existsSync(hookPath(repo))).toBe(true);

    // soft → it must go away again.
    expect(
      runSet({ key: "gateMode", value: "soft", globalFile: configFile, dbFile }).exitCode,
    ).toBe(0);
    expect(fs.existsSync(hookPath(repo))).toBe(false);

    db = openDatabase({ file: dbFile });
  });

  it("leaves a foreign hook chained when the mode turns on", async () => {
    const { runSet } = await import("../src/cli/commands/set.js");
    const foreign = "#!/bin/sh\nnpm test\n";
    fs.writeFileSync(hookPath(repo), foreign, { mode: 0o755 });
    const dbFile = path.join(home, "history.db");
    closeDatabase(db);

    runSet({ key: "gateMode", value: "warn", globalFile: path.join(home, "config.json"), dbFile });

    expect(fs.readFileSync(foreignHookPath(repo), "utf8")).toBe(foreign);
    db = openDatabase({ file: dbFile });
  });
});

describe("STAGED-FILE SCOPING (§13.3)", () => {
  const options = { staleDays: 14 };

  it("blocks on a pending question attached to a staged file", () => {
    seed();
    const blocking = questionsBlockingCommit(db, projectId, ["src/auth/middleware.js"], options);
    expect(blocking).toHaveLength(1);
  });

  it("does NOT block on a question about an unstaged file", () => {
    seed({ files: ["src/unrelated.js"] });
    expect(
      questionsBlockingCommit(db, projectId, ["src/auth/middleware.js"], options),
    ).toHaveLength(0);
  });

  it("does NOT block on an expired question (§14.3)", () => {
    const id = seed();
    db.prepare("UPDATE questions SET created_at = ? WHERE id = ?").run(
      "2020-01-01T00:00:00.000Z",
      id,
    );
    expect(
      questionsBlockingCommit(db, projectId, ["src/auth/middleware.js"], options),
    ).toHaveLength(0);
  });

  it("does NOT block on an already-answered question", () => {
    const id = seed();
    recordAnswer(db, id, {
      status: "answered",
      self_assessment: "nailed_it",
      assistance_level: "none",
      user_answer: "x",
    });
    expect(
      questionsBlockingCommit(db, projectId, ["src/auth/middleware.js"], options),
    ).toHaveLength(0);
  });

  it("does NOT block on another project's question", () => {
    const other = insertProject(db, path.join(repo, "..", "other")).id;
    insertQuestion(db, {
      project_id: other,
      type: "trace",
      concept_tag: "auth-flow",
      origin: "live",
      question_text: "q",
      sample_answer: "a",
      files: ["src/auth/middleware.js"],
    });
    expect(
      questionsBlockingCommit(db, projectId, ["src/auth/middleware.js"], options),
    ).toHaveLength(0);
  });

  it("blocks nothing when nothing is staged", () => {
    seed();
    expect(questionsBlockingCommit(db, projectId, [], options)).toHaveLength(0);
  });

  it("matches Windows-style input against POSIX-style stored paths (§16.4)", async () => {
    seed({ files: ["src/auth/middleware.js"] });
    // git emits POSIX paths everywhere, but a caller may hand us backslashes.
    const staged = await stagedFiles(repo, gitReturning(["src\\auth\\middleware.js"]));
    expect(staged).toEqual(["src/auth/middleware.js"]);
    expect(questionsBlockingCommit(db, projectId, staged, options)).toHaveLength(1);
  });

  it("reports only the staged files a question is attached to", () => {
    seed({ files: ["src/auth/middleware.js", "src/auth/refresh.js"] });
    const blocking = questionsBlockingCommit(db, projectId, ["src/auth/refresh.js"], options);
    expect(blocking[0].files).toEqual(["src/auth/refresh.js"]);
  });
});

describe("the real git runner (§22.4 — must run for real on every OS)", () => {
  it("reads actually-staged files from a real repository", async () => {
    const realRepo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "grasp-real-git-")));
    const git = (args: string[]): void => {
      execFileSync("git", args, { cwd: realRepo, stdio: "ignore" });
    };
    git(["init", "-q"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test"]);

    fs.mkdirSync(path.join(realRepo, "src", "auth"), { recursive: true });
    fs.writeFileSync(path.join(realRepo, "src", "auth", "middleware.js"), "export const a = 1;\n");
    fs.writeFileSync(path.join(realRepo, "src", "untracked.js"), "export const b = 2;\n");
    git(["add", "src/auth/middleware.js"]);

    // The default runner, not a stub: this is the code the hook actually runs.
    const staged = await stagedFiles(realRepo);
    expect(staged).toEqual(["src/auth/middleware.js"]);
    // git emits POSIX separators on every platform, including Windows (§13.3).
    expect(staged[0]).not.toContain("\\");

    fs.rmSync(realRepo, { recursive: true, force: true });
  });

  it("returns nothing rather than throwing outside a repository", async () => {
    const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), "grasp-no-git-"));
    await expect(stagedFiles(notARepo)).resolves.toEqual([]);
    fs.rmSync(notARepo, { recursive: true, force: true });
  });
});

describe("the blocked-commit message (§13.4)", () => {
  it("names files, truncates question text, and states the bypass neutrally", () => {
    seed();
    const blocking = questionsBlockingCommit(db, projectId, ["src/auth/middleware.js"], {
      staleDays: 14,
    });
    const message = renderBlockedMessage(blocking);

    expect(message).toContain("Grasp: commit blocked (hard gate)");
    expect(message).toContain("src/auth/middleware.js");
    expect(message).toContain("what happens if the token has expired");
    expect(message).toContain("...");
    // Exactly one next action, and the bypass without shame framing.
    expect(message).toContain("Run `grasp review`");
    expect(message).toContain("git commit --no-verify");
    expect(message).not.toMatch(/shame|lazy|cheat|discipline/i);
  });

  it("distinguishes a synthesis checkpoint from an ordinary question", () => {
    seed({ type: "synthesis", origin: "synthesis", question_text: "connect the pieces" });
    const blocking = questionsBlockingCommit(db, projectId, ["src/auth/middleware.js"], {
      staleDays: 14,
    });
    expect(renderBlockedMessage(blocking)).toContain("synthesis checkpoint: auth-flow");
  });

  it("uses the singular for one question", () => {
    seed();
    const blocking = questionsBlockingCommit(db, projectId, ["src/auth/middleware.js"], {
      staleDays: 14,
    });
    expect(renderBlockedMessage(blocking)).toContain("1 unanswered comprehension question on");
  });
});

describe("grasp __precommit (§16.2)", () => {
  it("exits 3 to block under the hard gate", async () => {
    db.prepare("UPDATE projects SET gate_mode = 'hard' WHERE id = ?").run(projectId);
    seed();
    const result = await runPrecommit({
      cwd: repo,
      dbFile,
      git: gitReturning(["src/auth/middleware.js"]),
    });
    expect(result.exitCode).toBe(3);
  });

  it("exits 0 under the warn gate, having printed the list", async () => {
    db.prepare("UPDATE projects SET gate_mode = 'warn' WHERE id = ?").run(projectId);
    seed();
    const result = await runPrecommit({
      cwd: repo,
      dbFile,
      git: gitReturning(["src/auth/middleware.js"]),
    });
    expect(result.exitCode).toBe(0);
  });

  it("exits 0 under the soft gate without consulting git at all", async () => {
    seed();
    let consulted = false;
    const result = await runPrecommit({
      cwd: repo,
      dbFile,
      git: async () => {
        consulted = true;
        return "";
      },
    });
    expect(result.exitCode).toBe(0);
    expect(consulted).toBe(false);
  });

  it("never blocks a commit in a repo Grasp does not track", async () => {
    const untracked = fs.mkdtempSync(path.join(os.tmpdir(), "grasp-untracked-"));
    fs.mkdirSync(path.join(untracked, ".git"), { recursive: true });
    const result = await runPrecommit({ cwd: untracked, dbFile, git: gitReturning(["a.ts"]) });
    expect(result.exitCode).toBe(0);
    fs.rmSync(untracked, { recursive: true, force: true });
  });

  it("does not block when the staged files have no questions", async () => {
    db.prepare("UPDATE projects SET gate_mode = 'hard' WHERE id = ?").run(projectId);
    seed({ files: ["src/other.js"] });
    const result = await runPrecommit({
      cwd: repo,
      dbFile,
      git: gitReturning(["src/auth/middleware.js"]),
    });
    expect(result.exitCode).toBe(0);
  });
});
