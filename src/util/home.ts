/**
 * Where Grasp keeps its state.  GOVERNED BY: §5.2, §5.5, §16.1, §18.1
 *
 * Resolved through `os.homedir()` on every call rather than cached at import:
 * §22.1 requires every test to run against a temp HOME, and a module-level
 * constant would capture the developer's real one at import time — the exact
 * failure that setup guard exists to catch.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** `~/.grasp` — everything Grasp owns lives under here. */
export function graspHome(): string {
  return path.join(os.homedir(), ".grasp");
}

export function graspDbPath(): string {
  return path.join(graspHome(), "history.db");
}

export function graspConfigPath(): string {
  return path.join(graspHome(), "config.json");
}

export function graspPidPath(): string {
  return path.join(graspHome(), "daemon.pid");
}

export function graspLogDir(): string {
  return path.join(graspHome(), "logs");
}

export function graspSnapshotRoot(): string {
  return path.join(graspHome(), "snapshots");
}

export function graspReviewLockPath(): string {
  return path.join(graspHome(), "review.lock");
}

/** Create `~/.grasp` if absent. Safe to call repeatedly. */
export function ensureGraspHome(): string {
  const home = graspHome();
  fs.mkdirSync(home, { recursive: true });
  return home;
}
