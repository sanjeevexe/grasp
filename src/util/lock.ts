/**
 * Single-holder lock files.  GOVERNED BY: §16.5
 *
 * One `grasp review` at a time, one `grasp scan` per project at a time. A lock
 * older than 30 minutes is stale: the holder crashed, and refusing forever
 * because of a dead process is worse than the race it prevents.
 */
import fs from "node:fs";
import path from "node:path";
import { ensureGraspHome } from "./home.js";

export const STALE_LOCK_MS = 30 * 60 * 1000;

export interface LockHandle {
  release(): void;
}

export interface LockInfo {
  pid: number;
  acquiredAt: string;
}

function readLock(file: string): LockInfo | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof parsed === "object" && parsed !== null && "pid" in parsed) return parsed as LockInfo;
    return null;
  } catch {
    return null;
  }
}

function isStale(info: LockInfo | null, now: number): boolean {
  if (!info) return true;
  const acquired = Date.parse(info.acquiredAt);
  if (Number.isNaN(acquired)) return true;
  if (now - acquired > STALE_LOCK_MS) return true;
  // A lock whose process is gone is stale regardless of age.
  try {
    process.kill(info.pid, 0);
    return false;
  } catch {
    return true;
  }
}

export function acquireLock(file: string, now = Date.now()): LockHandle | { held: LockInfo } {
  ensureGraspHome();
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const existing = readLock(file);
  if (fs.existsSync(file) && !isStale(existing, now)) {
    return { held: existing as LockInfo };
  }

  fs.writeFileSync(
    file,
    JSON.stringify({ pid: process.pid, acquiredAt: new Date(now).toISOString() }),
  );
  return {
    release: () => {
      try {
        const current = readLock(file);
        // Only remove our own lock: a stale-takeover race must not delete the
        // winner's file.
        if (current?.pid === process.pid) fs.rmSync(file, { force: true });
      } catch {
        // A lock we cannot remove will go stale on its own.
      }
    },
  };
}

export function isLockHandle(result: LockHandle | { held: LockInfo }): result is LockHandle {
  return "release" in result;
}
