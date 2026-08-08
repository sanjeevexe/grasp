#!/usr/bin/env python3
"""
Drives an interactive process (grasp review) under a real pseudo-terminal.

Used by test/reviewAppPty.test.ts to exercise ink's raw-mode/stdin-driven
input handling for real — child_process.spawn's pipes are NOT a TTY, so a
process reading via ink's setRawMode(true) behaves differently (or not at
all) than it does here. This is a Python script, not a new npm dependency
(node has no built-in pty module and this project stays deliberately light
on dependencies — see DECISIONS.md's "grasp review pty regression tests"
entry) — every dev/CI environment already needs git and a C toolchain for
better-sqlite3, and python3 is a reasonable assumption alongside those on
any macOS/Linux dev machine.

Usage: ptyDriver.py <spec.json>

spec.json: {
  "cmd": ["node", "dist/cli.js", "review"],
  "cwd": "...", "env": {...}, "cols": 100, "rows": 40,
  "dump_path": "...",           # optional: raw captured bytes written here
  "final_wait_seconds": 1.0,    # optional: how long to keep reading after the last step
  "steps": [
    {"type": "wait_for", "text": "...", "timeout": 5},
    {"type": "send", "text": "..."},
    {"type": "sleep", "seconds": 0.3}
  ]
}

Exits 0 if every "wait_for" step found its text in time, 2 otherwise.
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

    ok = True
    for step in spec.get("steps", []):
        t = step["type"]
        if t == "wait_for":
            if not wait_for(step["text"], step.get("timeout", 5)):
                print(f"TIMEOUT waiting for: {step['text']!r}", file=sys.stderr)
                ok = False
                break
        elif t == "send":
            os.write(master_fd, step["text"].encode())
        elif t == "sleep":
            time.sleep(step["seconds"])
        else:
            raise ValueError(f"unknown step type {t}")

    read_available(spec.get("final_wait_seconds", 1.0))

    # Clean shutdown: SIGTERM, poll WNOHANG, SIGKILL fallback — a bare
    # blocking waitpid() can hang forever if the child is wedged.
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
