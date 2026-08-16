import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import { mkTempDir } from "./env";

/**
 * The generalized, reusable PTY driver this harness is built on. Thin
 * TypeScript wrapper around `test/fixtures/ptyDriver.py` (see that file's
 * own module doc comment) — deliberately NOT a second, parallel pty-driving
 * implementation. `test/helpers.ts`'s existing `runPty` already proved this
 * exact shape works for `grasp review`/`grasp scan`'s ink-based raw-mode
 * input; this module generalizes it (arbitrary `cmd`, not just `node
 * dist/cli.js <args>`; a resize step; always-on screen-content capture) so
 * `test/e2e/scenarios/*` can drive ANY process through a real pty, not only
 * grasp subcommands, and so mid-session resize (one of the two specific
 * gaps this whole harness exists to close) is expressible as a step at all.
 *
 * Design note (see DECISIONS.md's "PTY e2e harness: driver architecture"
 * entry): steps are a pre-built, declarative list handed to one Python
 * subprocess invocation, not a live, bidirectional Node<->pty channel. That
 * keeps this file thin and keeps the actual pty-handling logic in exactly
 * one place (the Python driver), at the cost of not supporting truly
 * dynamic "branch on what I just saw" scripts — every scenario in this
 * harness is expressible as a fixed step sequence (matching how a human
 * tester follows a written test script), so that cost was judged worth
 * paying for the simplicity.
 */

export type PtyStep =
  | { type: "wait_for"; text: string; timeout?: number }
  | { type: "send"; text: string }
  | { type: "sleep"; seconds: number }
  | { type: "resize"; cols: number; rows: number }
  | { type: "snapshot"; path: string };

/** Named special keys, for readability in scenario files (`Key.DOWN` reads better than a raw escape sequence). */
export const Key = {
  UP: "\x1b[A",
  DOWN: "\x1b[B",
  RIGHT: "\x1b[C",
  LEFT: "\x1b[D",
  ENTER: "\r",
  ESCAPE: "\x1b",
  CTRL_C: "\x03",
  TAB: "\t",
} as const;

export interface PtySpawnOptions {
  cwd: string;
  env: Record<string, string>;
  cols?: number;
  rows?: number;
  /** How long (seconds) to keep reading output after the last step completes, to catch trailing output. */
  finalWaitSeconds?: number;
  /** Hard outer kill timeout (ms) for the whole driver subprocess — defense in depth against the python driver itself somehow wedging, on top of its own internal SIGTERM/SIGKILL child cleanup. */
  hardTimeoutMs?: number;
}

export interface PtyResult {
  /** 0 if every wait_for step found its text and no step errored; 2 on a driver-detected failure; null if the driver itself had to be force-killed by this wrapper's hard timeout. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Full raw captured screen bytes (decoded, errors replaced) — the harness's answer to "read the full current rendered screen content for assertions." Always populated (a dump_path is always requested), regardless of whether the caller also used "snapshot" steps for mid-run checkpoints. */
  screen: string;
  /** True if this wrapper had to forcibly kill the driver subprocess itself because it exceeded hardTimeoutMs — should never happen in practice (the Python driver has its own bounded wait_for timeouts and always cleans up its child), but exists so a genuinely wedged run fails loudly rather than hanging the whole e2e suite. */
  hardTimedOut: boolean;
}

const PTY_DRIVER = path.resolve(process.cwd(), "test/fixtures/ptyDriver.py");
const DEFAULT_HARD_TIMEOUT_MS = 60_000;

/**
 * Spawns `cmd` under a real pty and drives it through `steps`, returning
 * once the driver subprocess exits (cleanly, on a wait_for timeout, or
 * because this wrapper's own hard timeout fired). The child pty process is
 * guaranteed cleaned up by the time this resolves — see ptyDriver.py's own
 * try/finally cleanup, and the extra hard-timeout kill below for the
 * (should-never-happen) case where the driver itself doesn't exit on its
 * own.
 */
export function runPty(cmd: string[], steps: PtyStep[], opts: PtySpawnOptions): Promise<PtyResult> {
  const specDir = mkTempDir("grasp-e2e-ptyspec-");
  const specPath = path.join(specDir, "spec.json");
  const dumpPath = path.join(specDir, "dump.bin");

  fs.writeFileSync(
    specPath,
    JSON.stringify({
      cmd,
      cwd: opts.cwd,
      env: opts.env,
      cols: opts.cols ?? 120,
      rows: opts.rows ?? 45,
      final_wait_seconds: opts.finalWaitSeconds ?? 1.0,
      steps,
      dump_path: dumpPath,
    })
  );

  return new Promise((resolve, reject) => {
    const child = spawn("python3", [PTY_DRIVER, specPath], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let hardTimedOut = false;

    const hardTimeout = setTimeout(() => {
      hardTimedOut = true;
      // SIGKILL, not SIGTERM — this path only fires if the driver itself
      // (which handles its own SIGTERM->SIGKILL child cleanup internally)
      // has failed to exit on its own within a generous ceiling, so there's
      // no point waiting further here.
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }, opts.hardTimeoutMs ?? DEFAULT_HARD_TIMEOUT_MS);
    hardTimeout.unref();

    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", (err) => {
      clearTimeout(hardTimeout);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(hardTimeout);
      let screen = "";
      try {
        screen = fs.readFileSync(dumpPath, "utf-8");
      } catch {
        // Driver may not have reached the dump-writing step (e.g. hard-killed).
      }
      resolve({ code, stdout, stderr, screen, hardTimedOut });
    });
  });
}

/** Convenience: spawns `node dist/cli.js <args>` — the common case for every grasp-specific scenario. */
export function runGraspPty(cliPath: string, args: string[], steps: PtyStep[], opts: PtySpawnOptions): Promise<PtyResult> {
  return runPty(["node", cliPath, ...args], steps, opts);
}

/** Builds a "send this text" step from named keys/literal text — mostly for scenario-file readability (`sendText(Key.DOWN, Key.DOWN, "hello", Key.ENTER)`). */
export function sendText(...parts: string[]): PtyStep {
  return { type: "send", text: parts.join("") };
}

export function waitFor(text: string, timeout = 8): PtyStep {
  return { type: "wait_for", text, timeout };
}

export function sleepStep(seconds: number): PtyStep {
  return { type: "sleep", seconds };
}

export function resizeStep(cols: number, rows: number): PtyStep {
  return { type: "resize", cols, rows };
}
