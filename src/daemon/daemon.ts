/**
 * The daemon: PID file, project fan-out, lifecycle.  GOVERNED BY: §5.1, §5.2, §5.3, §5.6
 *
 * ONE DAEMON, MANY PROJECTS (§5.1). Never two.
 *
 * THERE IS NO IPC (§5.3). The daemon POLLS the `projects` table every 5 seconds
 * and reconciles its watcher set against it. `grasp init` inserts a row and
 * exits; within 5s the daemon picks it up. Do not add a socket, a named pipe, or
 * a signal channel — cross-platform IPC is the single biggest source of
 * avoidable bugs in a tool like this, and this poll costs one local SQLite read.
 */
import fs from "node:fs";
import { closeDatabase, openDatabase } from "../storage/db.js";
import { listProjects } from "../storage/models/projects.js";
import { loadConfig } from "../config/config.js";
import { graspPidPath, ensureGraspHome } from "../util/home.js";
import { ProjectWatcher, type WatcherDeps, type WatcherSettings } from "./watcher.js";
import { createLogger, type Logger } from "./logger.js";
import { notifyNewQuestions } from "../notifications/notify.js";
import { gateModeFor, syncHookForMode } from "../gate/gateModes.js";

/** §5.3 — the reconcile interval. Not configurable; it is an implementation detail. */
export const POLL_INTERVAL_MS = 5000;

export interface DaemonState {
  pid: number;
  startedAt: string;
}

/** §5.2 — read the PID file and check liveness with signal 0. */
export function readPidFile(file = graspPidPath()): DaemonState | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof parsed === "object" && parsed !== null && "pid" in parsed)
      return parsed as DaemonState;
    return null;
  } catch {
    return null;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 checks existence without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * §5.2 — a stale PID file (crash, hard reboot) MUST be treated as not-running
 * and cleaned up. Never assume a PID file means a live daemon.
 */
export function isDaemonRunning(file = graspPidPath()): DaemonState | null {
  const state = readPidFile(file);
  if (!state) return null;
  if (isProcessAlive(state.pid)) return state;
  fs.rmSync(file, { force: true });
  return null;
}

export function writePidFile(file = graspPidPath(), pid = process.pid): DaemonState {
  ensureGraspHome();
  const state: DaemonState = { pid, startedAt: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(state));
  return state;
}

export function removePidFile(file = graspPidPath()): void {
  fs.rmSync(file, { force: true });
}

export interface DaemonOptions {
  dbFile?: string;
  pidFile?: string;
  logger?: Logger;
  pollIntervalMs?: number;
  deps?: WatcherDeps;
}

/**
 * The resident process. Reconciles watchers against the `projects` table on a
 * timer and never talks to the CLI (§5.3).
 */
export class Daemon {
  private readonly watchers = new Map<number, ProjectWatcher>();
  private timer: NodeJS.Timeout | undefined;
  private readonly logger: Logger;
  private db: ReturnType<typeof openDatabase> | undefined;

  constructor(private readonly options: DaemonOptions = {}) {
    this.logger = options.logger ?? createLogger();
  }

  start(): void {
    // §5.2 — refuse to run two.
    const existing = isDaemonRunning(this.options.pidFile);
    if (existing) {
      this.logger.info("daemon already running", { pid: existing.pid });
      return;
    }
    writePidFile(this.options.pidFile);
    this.db = openDatabase(this.options.dbFile ? { file: this.options.dbFile } : {});
    this.logger.info("daemon started", { pid: process.pid });

    this.reconcile();
    this.timer = setInterval(
      () => this.reconcile(),
      this.options.pollIntervalMs ?? POLL_INTERVAL_MS,
    );
    this.timer.unref?.();

    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => void this.stop());
    }
  }

  /** §5.3 — the whole of CLI→daemon communication. */
  reconcile(): void {
    if (!this.db) return;
    const projects = listProjects(this.db);
    const seen = new Set<number>();

    for (const project of projects) {
      seen.add(project.id);
      if (this.watchers.has(project.id)) continue;

      // Per-repo config is merged here so a project's own .grasp.json applies.
      const { config, warnings } = loadConfig({ projectRoot: project.path });
      for (const warning of warnings) this.logger.warn("config", { warning });

      const settings: WatcherSettings = {
        debounceMs: config.debounceMs,
        maxFilesPerBatch: config.maxFilesPerBatch,
        minLines: config.diffSizeThreshold.minLines,
        ignorePatterns: config.ignorePatterns,
        maxQuestionsPerHour: config.maxQuestionsPerHour,
        maxDiffLines: config.maxDiffLines,
        minDiffCount: config.synthesisTrigger.minDiffCount,
        minMasteryTier: config.synthesisTrigger.minMasteryTier,
        decayWindows: config.decayWindows,
      };

      // §13.1 — keep each repo's pre-commit hook matching its resolved mode,
      // including a per-repo .grasp.json override the CLI never saw.
      try {
        syncHookForMode(project.path, gateModeFor(this.db, project.path, config.gateMode));
      } catch (error) {
        this.logger.warn("could not sync the pre-commit hook", {
          projectId: project.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      const watcher = new ProjectWatcher(this.db, project.id, project.path, settings, {
        logger: this.logger,
        providerSetting: config.provider,
        apiKey: config.apiKey,
        model: config.model,
        // §15 — ONE notification per closed capture turn, never per question.
        onQuestions: (count, projectPath) => {
          const result = notifyNewQuestions({ count, projectPath }, config.notifications);
          this.logger.debug("notification", {
            count,
            sent: result.sent,
            suppressed: result.suppressed,
          });
        },
        ...this.options.deps,
      });
      void watcher.start();
      this.watchers.set(project.id, watcher);
      this.logger.info("watching project", { projectId: project.id, path: project.path });
    }

    // Un-registering works the same way in reverse (§5.3).
    for (const [id, watcher] of this.watchers) {
      if (seen.has(id)) continue;
      void watcher.stop();
      this.watchers.delete(id);
      this.logger.info("stopped watching project", { projectId: id });
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const watcher of this.watchers.values()) await watcher.stop();
    this.watchers.clear();
    if (this.db) closeDatabase(this.db);
    this.db = undefined;
    // §5.2 — removed on graceful shutdown, so a stale file always means a crash.
    removePidFile(this.options.pidFile);
    this.logger.info("daemon stopped");
  }

  get watchedProjectCount(): number {
    return this.watchers.size;
  }
}
