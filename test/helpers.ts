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
