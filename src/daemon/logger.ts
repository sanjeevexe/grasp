/**
 * Rotating file logger.  GOVERNED BY: §16.1
 *
 * NEVER LOGS: the API key, file contents, or diff bodies. Paths, counts, tags,
 * and timings only. This is a privacy guarantee with a release-gate check
 * (§22.5) — a user's proprietary source must not end up in a plaintext log.
 *
 * The `redactMeta` pass below is the enforcement: any value that looks like a
 * key is masked, and any string long enough to be file content is replaced with
 * its length rather than truncated, because a truncated diff is still a diff.
 */
import fs from "node:fs";
import path from "node:path";
import { graspLogDir } from "../util/home.js";

export type LogLevel = "error" | "warn" | "info" | "debug";

const LEVEL_RANK: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

export const MAX_LOG_BYTES = 5 * 1024 * 1024;
export const MAX_LOG_FILES = 3;
/** Anything longer is treated as content, never logged verbatim (§16.1). */
export const MAX_META_STRING = 200;

export interface Logger {
  error(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
}

export function resolveLevel(env: NodeJS.ProcessEnv = process.env): LogLevel {
  const requested = env.GRASP_LOG?.toLowerCase();
  return requested && requested in LEVEL_RANK ? (requested as LogLevel) : "info";
}

/** §16.1 — the last line of defence before anything reaches disk. */
export function redactMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (typeof value === "string") {
      const masked = value.replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-***");
      safe[key] = masked.length > MAX_META_STRING ? `<${masked.length} chars omitted>` : masked;
    } else if (value instanceof Error) {
      safe[key] = value.message.replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-***");
    } else if (typeof value === "object" && value !== null) {
      // Objects are summarized, never serialized: a nested diff would otherwise
      // reach the log through JSON.stringify.
      safe[key] = Array.isArray(value) ? `<${value.length} items>` : "<object>";
    } else {
      safe[key] = value;
    }
  }
  return safe;
}

function rotate(file: string): void {
  try {
    if (fs.statSync(file).size < MAX_LOG_BYTES) return;
  } catch {
    return; // no log yet
  }
  // daemon.log → daemon.log.1 → daemon.log.2, dropping the oldest.
  for (let i = MAX_LOG_FILES - 1; i >= 1; i--) {
    const from = i === 1 ? file : `${file}.${i - 1}`;
    const to = `${file}.${i}`;
    try {
      fs.renameSync(from, to);
    } catch {
      // Missing intermediate files are normal on the first rotations.
    }
  }
}

export interface LoggerOptions {
  file?: string;
  level?: LogLevel;
  /** Tests capture lines instead of writing to disk. */
  sink?: (line: string) => void;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? resolveLevel();
  const file = options.file ?? path.join(graspLogDir(), "daemon.log");

  const write = (logLevel: LogLevel, message: string, meta?: Record<string, unknown>): void => {
    if (LEVEL_RANK[logLevel] > LEVEL_RANK[level]) return;
    const payload = meta ? ` ${JSON.stringify(redactMeta(meta))}` : "";
    const line = `${new Date().toISOString()} ${logLevel.toUpperCase()} ${message}${payload}\n`;

    if (options.sink) {
      options.sink(line);
      return;
    }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      rotate(file);
      fs.appendFileSync(file, line);
    } catch {
      // Logging must never take the daemon down.
    }
  };

  return {
    error: (message, meta) => write("error", message, meta),
    warn: (message, meta) => write("warn", message, meta),
    info: (message, meta) => write("info", message, meta),
    debug: (message, meta) => write("debug", message, meta),
  };
}
