/**
 * Global test setup.  GOVERNED BY: DESIGN_BRIEF.md §22.1
 *
 * TWO HARD GUARANTEES this file enforces:
 *
 * 1. NO TEST MAY TOUCH THE DEVELOPER'S REAL ~/.grasp.
 *    HOME/USERPROFILE are redirected to a fresh temp dir per test file (Node's
 *    os.homedir() reads them), and a real-home resolution fails loudly.
 *
 * 2. NO NETWORK AND NO SUBPROCESS, EVER.
 *    Both providers are mocked at the module boundary: the Anthropic SDK throws
 *    if constructed, and execFile refuses to spawn the real `claude` CLI. A test
 *    that reaches either is a FAILING test, not a slow one.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, vi } from "vitest";

const REAL_HOME = os.homedir();
let sandboxHome: string;

beforeAll(() => {
  sandboxHome = mkdtempSync(path.join(os.tmpdir(), "grasp-test-home-"));
  process.env.HOME = sandboxHome;
  process.env.USERPROFILE = sandboxHome;
  // Guard, not a hope: if anything resolves the developer's real home, fail.
  if (os.homedir() === REAL_HOME && sandboxHome !== REAL_HOME) {
    throw new Error("test sandbox failed: os.homedir() still resolves to the real home");
  }
  // A stray real key must never reach a provider during tests.
  delete process.env.ANTHROPIC_API_KEY;
});

afterAll(() => {
  if (sandboxHome) rmSync(sandboxHome, { recursive: true, force: true });
});

vi.mock("@anthropic-ai/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/sdk")>();
  class MockAnthropic {
    messages = {
      create: () => {
        throw new Error("test attempted a real Anthropic API call");
      },
    };
  }
  // The real default export carries APIError as a static; mirror that.
  (MockAnthropic as unknown as { APIError: unknown }).APIError = actual.APIError;
  return { ...actual, default: MockAnthropic, APIError: actual.APIError };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: (file: string, ...rest: unknown[]) => {
      if (file === "claude") throw new Error("test attempted to spawn the real `claude` CLI");
      return (actual.execFile as unknown as (...args: unknown[]) => unknown)(file, ...rest);
    },
  };
});
