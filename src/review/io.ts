/**
 * Terminal I/O for the review session.  GOVERNED BY: §14.4, §22.3
 *
 * RAW KEYPRESS MODE, not line mode. §14.4's keybinds fire on the key itself,
 * with no Enter, so this owns the line editing rather than delegating to a
 * readline interface.
 *
 * COMMANDS ARE Ctrl+letter. Bare letters are ALWAYS text, so any answer can be
 * typed without an escape hatch — the earlier bare-letter scheme made answers
 * beginning with e/d/b/s/q impossible, and before that it silently skipped
 * questions whose answer began with "s".
 *
 * WHICH LETTERS ARE SAFE is not a matter of taste; several Ctrl combinations
 * never reach an application, or reach it as something else. The defaults and
 * the reserved list live in keys.ts, and bindings are user-configurable because
 * some collisions happen above the terminal entirely (§14.4). Verified in a real
 * PTY with raw mode on, not assumed:
 *
 *   Ctrl+H / Ctrl+I / Ctrl+J / Ctrl+M  arrive as backspace / tab / enter /
 *     return. They are those keys — a terminal cannot distinguish them, so
 *     binding one would also fire on Backspace or Enter.
 *   Ctrl+S / Ctrl+Q  are XON/XOFF flow control. Raw mode happens to deliver
 *     them, but raw mode is only on WHILE prompting; press Ctrl+S at any other
 *     moment and the terminal freezes. A user who learns "Ctrl+S skips" will
 *     eventually press it at the wrong moment, so it stays unbound.
 *   Ctrl+Z  suspends the process.
 *   Ctrl+B  is tmux's default prefix, Ctrl+A is GNU screen's. Both are swallowed
 *     before the application sees them for anyone working inside a multiplexer.
 *
 * Ctrl+C and Ctrl+D keep their ordinary meanings and end the session with
 * everything already answered persisted (§14.4). Raw mode delivers no SIGINT, so
 * Ctrl+C is handled explicitly. Every other control combination is ignored
 * rather than inserted as text.
 */
import readline from "node:readline";
import chalk from "chalk";
import { DEFAULT_REVIEW_KEYS, matchBinding, type ReviewAction } from "./keys.js";
import type { SelfAssessment } from "../types/index.js";

export type ReviewCommand = "hint" | "explain" | "deeper" | "breakdown" | "skip" | "quit";

export type ReviewInput =
  { kind: "answer"; text: string } | { kind: "command"; command: ReviewCommand };

export interface ReviewIo {
  write(text: string): void;
  /** Resolves when the user submits an answer or presses a command key. */
  prompt(): Promise<ReviewInput>;
  /** §10.3 — the only progression mechanism. `null` means the user quit. */
  promptAssessment(): Promise<SelfAssessment | null>;
  close(): void;
}

/** Wording for each command in the key hint line (§14.4), in display order. */
export const COMMAND_LABELS: { command: ReviewCommand; label: string }[] = [
  { command: "hint", label: "hint" },
  { command: "explain", label: "explain" },
  { command: "deeper", label: "deeper" },
  { command: "breakdown", label: "break it down" },
  { command: "skip", label: "skip" },
  { command: "quit", label: "quit" },
];

interface Key {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  sequence?: string;
}

/** Printable text, as opposed to a control or navigation key. */
function isTypable(str: string | undefined, key: Key): boolean {
  if (key.ctrl || key.meta) return false;
  if (str === undefined || str.length === 0) return false;
  // Control characters (including the raw bytes for Ctrl+S/Q/Z) are never text.
  const code = str.charCodeAt(0);
  return code >= 0x20 && code !== 0x7f;
}

export interface TerminalIoStreams {
  /** Defaults to the process streams; tests pass pipes. */
  input?: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (mode: boolean) => void };
  output?: NodeJS.WritableStream;
  /** Resolved `config.review.keys` (§18.1); defaults when omitted. */
  keys?: Record<ReviewAction, string>;
}

export function createTerminalIo(streams: TerminalIoStreams = {}): ReviewIo {
  const input = (streams.input ?? process.stdin) as NodeJS.ReadStream;
  const output = (streams.output ?? process.stdout) as NodeJS.WriteStream;
  const keys = streams.keys ?? DEFAULT_REVIEW_KEYS;

  let rawModeDepth = 0;

  const beginRawMode = (): void => {
    rawModeDepth += 1;
    if (rawModeDepth > 1) return;
    readline.emitKeypressEvents(input);
    if (input.isTTY && typeof input.setRawMode === "function") input.setRawMode(true);
    input.resume();
  };

  const endRawMode = (): void => {
    rawModeDepth = Math.max(0, rawModeDepth - 1);
    if (rawModeDepth > 0) return;
    if (input.isTTY && typeof input.setRawMode === "function") input.setRawMode(false);
  };

  /** One keypress reader; both prompts are built on it. */
  function readKeys<T>(
    handle: (str: string | undefined, key: Key, finish: (value: T) => void) => void,
  ): Promise<T> {
    return new Promise<T>((resolve) => {
      let settled = false;
      const finish = (value: T): void => {
        if (settled) return;
        settled = true;
        input.off("keypress", onKeypress);
        input.off("end", onEnd);
        endRawMode();
        resolve(value);
      };
      const onKeypress = (str: string | undefined, key: Key = {}): void => handle(str, key, finish);
      const onEnd = (): void => handle(undefined, { name: "d", ctrl: true }, finish);

      beginRawMode();
      input.on("keypress", onKeypress);
      input.once("end", onEnd);
    });
  }

  return {
    write: (text) => output.write(text),

    prompt: () => {
      let buffer = "";
      return readKeys<ReviewInput>((str, key, finish) => {
        if (key.ctrl && key.name) {
          // Ctrl+D is EOF only on an empty line; mid-answer it does nothing.
          if (key.name === "d") {
            if (buffer.length === 0) {
              output.write("\n");
              finish({ kind: "command", command: "quit" });
            }
            return;
          }
          // Ctrl+C always ends the session, whatever the bindings say — a
          // misconfigured map must never leave someone stuck in a prompt.
          if (key.name === "c") {
            output.write("\n");
            finish({ kind: "command", command: "quit" });
            return;
          }
          const command = matchBinding(key, keys);
          if (command) {
            finish({ kind: "command", command });
            return;
          }
          // Unbound control combination — ignored, never text.
          return;
        }

        if (key.name === "return" || key.name === "enter") {
          if (key.meta) {
            // Alt+Enter: a newline inside the answer (§14.4).
            buffer += "\n";
            output.write("\n  ");
            return;
          }
          if (buffer.trim().length === 0) return; // a bare Enter submits nothing
          output.write("\n");
          finish({ kind: "answer", text: buffer.trim() });
          return;
        }

        if (key.name === "backspace") {
          if (buffer.length > 0) {
            buffer = buffer.slice(0, -1);
            output.write("\b \b");
          }
          return;
        }

        if (isTypable(str, key)) {
          // Bare letters are always text — there is no command that a typed
          // answer can trigger by accident.
          buffer += str as string;
          output.write(str as string);
        }
        // Everything else — Esc, arrows, function keys — is ignored.
      });
    },

    promptAssessment: () => {
      output.write(
        `\n${chalk.bold("How did that compare?")}   ${chalk.green("[1] Nailed it")}   ` +
          `${chalk.yellow("[2] Mostly there")}   ${chalk.red("[3] Way off")}\n> `,
      );
      const choices: Record<string, SelfAssessment> = {
        "1": "nailed_it",
        "2": "mostly_there",
        "3": "way_off",
      };
      // A menu, not a text field: bare 1/2/3 with nothing to collide with.
      return readKeys<SelfAssessment | null>((str, key, finish) => {
        if (key.ctrl && (key.name === "c" || key.name === "d")) {
          output.write("\n");
          finish(null);
          return;
        }
        const choice = choices[str ?? ""];
        if (choice) {
          output.write(`${str}\n`);
          finish(choice);
          return;
        }
        if (isTypable(str, key)) output.write(chalk.dim("\nEnter 1, 2, or 3.\n> "));
      });
    },

    close: () => {
      rawModeDepth = 1;
      endRawMode();
    },
  };
}
