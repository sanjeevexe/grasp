import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";
import { CapturedDiff, DiffFile, DiffHunk } from "../src/adapters/agentAdapter";
import { GraspConfig } from "../src/types";
import { DEFAULT_CONFIG } from "../src/config";

/** A deep-enough clone of DEFAULT_CONFIG for tests to mutate freely without cross-test bleed. */
export function testConfig(overrides: Partial<GraspConfig> = {}): GraspConfig {
  return {
    ...structuredClone(DEFAULT_CONFIG),
    ...overrides,
  };
}

export function hunk(header: string, lines: string[]): DiffHunk {
  return { header, lines };
}

export function diffFile(overrides: Partial<DiffFile> & Pick<DiffFile, "path">): DiffFile {
  return {
    oldPath: null,
    status: "modified",
    insertions: 0,
    deletions: 0,
    hunks: [],
    ...overrides,
  };
}

export function capturedDiff(files: DiffFile[], repo = "/tmp/test-repo"): CapturedDiff {
  return {
    repo,
    capturedAt: new Date().toISOString(),
    files,
    rawDiffText: "",
    diffHash: null,
  };
}

// --- real-pty test driver ---------------------------------------------------
//
// Shared by any test that needs to exercise `grasp review`'s actual TTY/ink
// path end to end (child_process.spawn's pipes are not a TTY, so ink's
// raw-mode-dependent input handling doesn't run the same way — see
// reviewAppPty.test.ts's file-level doc comment for the full diagnosis this
// was originally built for).

export const CLI_PATH = path.resolve(process.cwd(), "dist/cli.js");
const PTY_DRIVER = path.resolve(process.cwd(), "test/fixtures/ptyDriver.py");

export function mkTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export interface PtyStep {
  type: "wait_for" | "send" | "sleep";
  text?: string;
  seconds?: number;
  timeout?: number;
}

/** Spawns `node dist/cli.js <args>` under a real pty and drives it through `steps`. */
export function runPty(
  args: string[],
  steps: PtyStep[],
  env: Record<string, string>,
  cwd: string,
  dumpPath?: string
): Promise<{ code: number | null; stderr: string }> {
  const specPath = path.join(mkTempDir("grasp-test-ptyspec-"), "spec.json");
  fs.writeFileSync(
    specPath,
    JSON.stringify({
      cmd: ["node", CLI_PATH, ...args],
      cwd,
      env,
      cols: 120,
      rows: 45,
      final_wait_seconds: 1.0,
      steps,
      dump_path: dumpPath,
    })
  );
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [PTY_DRIVER, specPath], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr }));
  });
}
