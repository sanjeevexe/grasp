#!/usr/bin/env python3
"""
Generalized real-pseudo-terminal driver for exercising any interactive
process (originally built for `grasp review`, now the shared mechanism for
this codebase's whole PTY-driven test surface, including `test/e2e/`) —
`child_process.spawn`'s pipes are NOT a TTY, so a process reading via ink's
`setRawMode(true)` (or anything else that behaves differently under a real
TTY vs. a pipe) doesn't run the same way over plain pipes as it does here.
This is a Python script, not a new npm dependency (node has no built-in pty
module and this project stays deliberately light on dependencies — see
DECISIONS.md's "grasp review pty regression tests" entry) — every dev/CI
environment already needs git and a C toolchain for better-sqlite3, and
python3 is a reasonable assumption alongside those on any macOS/Linux dev
machine.

Deliberately still the ONE pty-driving mechanism in this codebase (see
DECISIONS.md's "PTY e2e harness: driver architecture" entry) — the e2e
harness's TypeScript layer (`test/e2e/lib/ptyDriver.ts`) is a thin wrapper
around this same script, not a second, parallel implementation.

Usage: ptyDriver.py <spec.json>

spec.json: {
  "cmd": ["node", "dist/cli.js", "review"],   # any process, not just grasp
  "cwd": "...", "env": {...}, "cols": 100, "rows": 40,
  "dump_path": "...",           # optional: raw captured bytes written here
  "final_wait_seconds": 1.0,    # optional: how long to keep reading after the last step
  "steps": [
    {"type": "wait_for", "text": "...", "timeout": 5},
    {"type": "send", "text": "..."},
    {"type": "sleep", "seconds": 0.3},
    {"type": "resize", "cols": 80, "rows": 24},
    {"type": "snapshot", "path": "..."}   # dump the buffer-so-far to a named file, for a mid-run checkpoint read
  ]
}

Exits 0 if every "wait_for" step found its text in time (and no step raised
an unexpected error), 2 otherwise. The child process is ALWAYS terminated
and reaped before this script exits — on a clean run, on a wait_for
timeout, or on any other step-level failure — see the try/finally around
the step loop below; this is deliberately structured so no code path can
skip cleanup and leak a pty child process.
"""
import os
import sys
import json
import pty
import time
import signal
import select
import struct
import fcntl
import termios


def main():
    spec = json.load(open(sys.argv[1]))
    cmd = spec["cmd"]
    cwd = spec.get("cwd")
    env = dict(os.environ)
    env.update(spec.get("env", {}))
    cols = spec.get("cols", 100)
    rows = spec.get("rows", 40)

    pid, master_fd = pty.fork()
    if pid == 0:
        if cwd:
            os.chdir(cwd)
        os.execvpe(cmd[0], cmd, env)
        os._exit(1)

    fcntl.ioctl(master_fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    buf = b""

    def read_available(timeout=0.2):
        nonlocal buf
        end = time.time() + timeout
        got_any = False
        while time.time() < end:
            r, _, _ = select.select([master_fd], [], [], 0.05)
            if master_fd in r:
                try:
                    chunk = os.read(master_fd, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                buf += chunk
                got_any = True
            elif got_any:
                break
        return got_any

    def wait_for(text, timeout):
        end = time.time() + timeout
        while time.time() < end:
            read_available(0.2)
            if text.encode() in buf:
                return True
        return False

    def resize(new_cols, new_rows):
        nonlocal cols, rows
        cols, rows = new_cols, new_rows
        fcntl.ioctl(master_fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        # A real terminal emulator sends SIGWINCH to the foreground process
        # group on resize — the pty itself doesn't do this automatically
        # just because TIOCSWINSZ was applied, so it's sent explicitly here.
        # This is what lets a resize-aware app (e.g. ink's `useStdout`
        # resize listener) actually notice and re-render, not just what a
        # later os.read happens to return.
        try:
            os.kill(pid, signal.SIGWINCH)
        except ProcessLookupError:
            pass

    # ok=True unless a wait_for step times out or a step raises. Wrapped in
    # try/finally (not just a plain for-loop) so ANY unexpected exception
    # mid-step (a malformed step dict, an OSError writing to an already-dead
    # child's fd, etc.) still falls through to the cleanup section below
    # instead of leaking the forked pty child — see this file's own module
    # doc comment. Each step is also individually try/except-wrapped so one
    # bad step reports clearly (stderr + ok=False) rather than crashing the
    # whole driver with a raw traceback.
    ok = True
    try:
        for step in spec.get("steps", []):
            t = step.get("type")
            try:
                if t == "wait_for":
                    if not wait_for(step["text"], step.get("timeout", 5)):
                        print(f"TIMEOUT waiting for: {step['text']!r}", file=sys.stderr)
                        ok = False
                        break
                elif t == "send":
                    os.write(master_fd, step["text"].encode())
                elif t == "sleep":
                    time.sleep(step["seconds"])
                elif t == "resize":
                    resize(step["cols"], step["rows"])
                elif t == "snapshot":
                    read_available(0.1)
                    with open(step["path"], "wb") as f:
                        f.write(buf)
                else:
                    print(f"UNKNOWN STEP TYPE: {t!r}", file=sys.stderr)
                    ok = False
                    break
            except Exception as exc:  # noqa: BLE001 - deliberately broad, see doc comment
                print(f"STEP FAILED ({t!r}): {exc}", file=sys.stderr)
                ok = False
                break
    finally:
        read_available(spec.get("final_wait_seconds", 1.0))

        # Clean shutdown: SIGTERM, poll WNOHANG, SIGKILL fallback — a bare
        # blocking waitpid() can hang forever if the child is wedged. This
        # runs unconditionally, success or failure — a leaked pty process is
        # worse than a failed test (see this file's own module doc comment).
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        reaped = False
        for _ in range(20):
            try:
                wpid, _ = os.waitpid(pid, os.WNOHANG)
            except ChildProcessError:
                reaped = True
                break
            if wpid == pid:
                reaped = True
                break
            time.sleep(0.1)
        if not reaped:
            try:
                os.kill(pid, signal.SIGKILL)
                os.waitpid(pid, 0)
            except (ProcessLookupError, ChildProcessError):
                pass

    dump_path = spec.get("dump_path")
    if dump_path:
        with open(dump_path, "wb") as f:
            f.write(buf)

    sys.stdout.write(buf.decode(errors="replace"))
    sys.exit(0 if ok else 2)


if __name__ == "__main__":
    main()
