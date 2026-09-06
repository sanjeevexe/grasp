/**
 * PID liveness, the projects-table poll, service files, and init.
 * GOVERNED BY: §5.1, §5.2, §5.3, §6.1, §6.2, §22.3 case 15
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, openDatabase } from "../src/storage/db.js";
import { insertProject, deleteProject, listProjects } from "../src/storage/models/projects.js";
import {
  Daemon,
  isDaemonRunning,
  isProcessAlive,
  readPidFile,
  removePidFile,
  writePidFile,
} from "../src/daemon/daemon.js";
import {
  LAUNCHD_LABEL,
  WINDOWS_TASK,
  installService,
  launchAgentPath,
  renderLaunchAgent,
  renderSystemdUnit,
  systemdUnitPath,
  uninstallService,
  type ServiceRunner,
} from "../src/daemon/service.js";
import { runInit } from "../src/cli/commands/init.js";
import { createLogger } from "../src/daemon/logger.js";

let home: string;
let pidFile: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "grasp-life-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  pidFile = path.join(home, "daemon.pid");
});

afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const TARGET = { node: "/usr/local/bin/node", script: "/opt/grasp/dist/cli/index.js" };
const okRunner: ServiceRunner = async () => ({ ok: true, stderr: "" });
const failRunner: ServiceRunner = async () => ({ ok: false, stderr: "no systemd" });

describe("PID file liveness (§5.2)", () => {
  it("reports a live daemon for its own pid", () => {
    writePidFile(pidFile);
    expect(isDaemonRunning(pidFile)?.pid).toBe(process.pid);
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("treats a stale PID file as not-running AND cleans it up (§5.2)", () => {
    // PID 2^31-1 is not a live process on any supported platform.
    fs.writeFileSync(
      pidFile,
      JSON.stringify({ pid: 2147483647, startedAt: new Date().toISOString() }),
    );
    expect(isDaemonRunning(pidFile)).toBeNull();
    // Never assume a stale file means a running daemon — it is removed.
    expect(fs.existsSync(pidFile)).toBe(false);
  });

  it("treats a corrupt PID file as not-running", () => {
    fs.writeFileSync(pidFile, "not json");
    expect(readPidFile(pidFile)).toBeNull();
    expect(isDaemonRunning(pidFile)).toBeNull();
  });

  it("removes the file on graceful shutdown, so a stale file always means a crash", () => {
    writePidFile(pidFile);
    removePidFile(pidFile);
    expect(fs.existsSync(pidFile)).toBe(false);
  });
});

describe("no IPC — the daemon polls the projects table (§5.3)", () => {
  it("picks up a newly registered project on the next reconcile", async () => {
    const dbFile = path.join(home, "history.db");
    const db = openDatabase({ file: dbFile });
    const daemon = new Daemon({
      dbFile,
      pidFile,
      logger: createLogger({ sink: () => {} }),
      pollIntervalMs: 60_000, // reconcile is driven manually here
    });
    daemon.start();
    expect(daemon.watchedProjectCount).toBe(0);

    // `grasp init` inserts a row and exits — no socket, no signal (§5.3).
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "grasp-life-repo-"));
    const project = insertProject(db, projectDir);
    daemon.reconcile();
    expect(daemon.watchedProjectCount).toBe(1);

    // Un-registering works the same way in reverse.
    deleteProject(db, project.id);
    daemon.reconcile();
    expect(daemon.watchedProjectCount).toBe(0);

    await daemon.stop();
    closeDatabase(db);
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it("refuses to run two daemons (§5.1)", async () => {
    const dbFile = path.join(home, "history.db");
    writePidFile(pidFile); // a live daemon (this process)
    const second = new Daemon({ dbFile, pidFile, logger: createLogger({ sink: () => {} }) });
    second.start();
    expect(second.watchedProjectCount).toBe(0);
    await second.stop();
  });
});

describe("service files (§6.2)", () => {
  it("renders a launchd agent with RunAtLoad and KeepAlive", () => {
    const plist = renderLaunchAgent(TARGET, path.join(home, "logs"));
    expect(plist).toContain(`<string>${LAUNCHD_LABEL}</string>`);
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(plist).toContain(TARGET.script);
    expect(plist).toContain("__daemon");
  });

  it("renders a systemd USER service with Restart=on-failure", () => {
    const unit = renderSystemdUnit(TARGET);
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain(`ExecStart=${TARGET.node} ${TARGET.script} __daemon`);
    expect(unit).toContain("WantedBy=default.target");
  });

  it("writes to the paths §6.2 specifies", () => {
    expect(launchAgentPath(home)).toBe(
      path.join(home, "Library", "LaunchAgents", "com.grasp.daemon.plist"),
    );
    expect(systemdUnitPath(home)).toBe(
      path.join(home, ".config", "systemd", "user", "grasp.service"),
    );
  });

  it("installs per platform", async () => {
    const mac = await installService({ target: TARGET, platform: "darwin", home, run: okRunner });
    expect(mac.mechanism).toBe("launchd");
    expect(fs.existsSync(launchAgentPath(home))).toBe(true);

    const linux = await installService({ target: TARGET, platform: "linux", home, run: okRunner });
    expect(linux.mechanism).toBe("systemd");
    expect(fs.existsSync(systemdUnitPath(home))).toBe(true);

    const windows = await installService({
      target: TARGET,
      platform: "win32",
      home,
      run: okRunner,
    });
    expect(windows.mechanism).toBe("schtasks");
  });

  it("passes argv as an array, never an interpolated shell string (§7.4)", async () => {
    const seen: { command: string; args: string[] }[] = [];
    const recording: ServiceRunner = async (command, args) => {
      seen.push({ command, args });
      return { ok: true, stderr: "" };
    };
    await installService({ target: TARGET, platform: "win32", home, run: recording });
    expect(seen[0].command).toBe("schtasks");
    expect(seen[0].args).toContain(WINDOWS_TASK);
    expect(Array.isArray(seen[0].args)).toBe(true);
  });

  it("falls back to a detached process rather than failing init (§6.2)", async () => {
    let spawned = false;
    const result = await installService({
      target: TARGET,
      platform: "linux",
      home,
      run: failRunner,
      spawnDetached: () => {
        spawned = true;
        return true;
      },
    });
    expect(spawned).toBe(true);
    expect(result.mechanism).toBe("detached");
    expect(result.installed).toBe(true);
    // The user is told it will not survive a reboot.
    expect(result.warning).toMatch(/will not survive a reboot/);
  });

  it("reports an unsupported platform clearly rather than throwing", async () => {
    const result = await installService({
      target: TARGET,
      platform: "aix" as NodeJS.Platform,
      home,
      run: okRunner,
    });
    expect(result.installed).toBe(false);
    expect(result.warning).toMatch(/does not know how to install/);
  });

  it("removes the service file on uninstall", async () => {
    await installService({ target: TARGET, platform: "darwin", home, run: okRunner });
    await uninstallService({ target: TARGET, platform: "darwin", home, run: okRunner });
    expect(fs.existsSync(launchAgentPath(home))).toBe(false);
  });
});

describe("grasp init (§6.1, §22.3 case 15)", () => {
  let repo: string;
  let dbFile: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "grasp-init-repo-"));
    fs.mkdirSync(path.join(repo, ".git"));
    fs.mkdirSync(path.join(repo, "src"));
    dbFile = path.join(home, "history.db");
  });

  afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

  const stubInstall = async () => ({ installed: true, mechanism: "launchd" as const });

  it("refuses to run outside a git repo, exiting 2 (§16.2)", async () => {
    const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), "grasp-not-repo-"));
    const result = await runInit({ cwd: notARepo, dbFile, yes: true, install: stubInstall });
    expect(result.exitCode).toBe(2);
    fs.rmSync(notARepo, { recursive: true, force: true });
  });

  it("is idempotent — one project row, exit 0 both times (§22.3 case 15)", async () => {
    const first = await runInit({ cwd: repo, dbFile, yes: true, install: stubInstall });
    const second = await runInit({ cwd: repo, dbFile, yes: true, install: stubInstall });

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);

    const db = openDatabase({ file: dbFile });
    expect(listProjects(db)).toHaveLength(1);
    closeDatabase(db);
  });

  it("registers the repo ROOT even when run from a subdirectory (§6.1 step 1)", async () => {
    const nested = path.join(repo, "src", "deep");
    fs.mkdirSync(nested, { recursive: true });
    const result = await runInit({ cwd: nested, dbFile, yes: true, install: stubInstall });
    expect(result.projectPath).toBe(fs.realpathSync(repo));
  });

  it("populates the snapshot so the first captured diff is real (§6.1 step 4)", async () => {
    fs.writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 1;\n");
    await runInit({ cwd: repo, dbFile, yes: true, install: stubInstall });

    const { readSnapshot } = await import("../src/capture/snapshot.js");
    expect(readSnapshot(fs.realpathSync(repo), "src/a.ts")).toBe("export const a = 1;\n");
  });

  it("suggests a scan only when the repo has substantial existing code (§6.1 step 5)", async () => {
    const small = await runInit({ cwd: repo, dbFile, yes: true, install: stubInstall });
    expect(small.scanSuggested).toBe(false);

    const bigRepo = fs.mkdtempSync(path.join(os.tmpdir(), "grasp-big-repo-"));
    fs.mkdirSync(path.join(bigRepo, ".git"));
    for (let i = 0; i < 12; i++) {
      fs.writeFileSync(path.join(bigRepo, `file${i}.ts`), "export const x = 1;\n");
    }
    const big = await runInit({
      cwd: bigRepo,
      dbFile: path.join(home, "big.db"),
      yes: true,
      install: stubInstall,
    });
    expect(big.scanSuggested).toBe(true);
    fs.rmSync(bigRepo, { recursive: true, force: true });
  });
});
