/**
 * Debounce, syntax checking, and log privacy.  GOVERNED BY: §7.2, §7.3, §7.4, §16.1, §22.3
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Debouncer, type PendingBatch } from "../src/daemon/debounce.js";
import {
  checkJavaScriptSyntax,
  checkSyntax,
  isSourceFile,
  probeCacheSize,
  resetProbeCache,
  type CommandRunner,
} from "../src/daemon/parsers/index.js";
import { createLogger, redactMeta } from "../src/daemon/logger.js";

beforeEach(() => resetProbeCache());
afterEach(() => vi.useRealTimers());

describe("debounce (§7.2)", () => {
  it("coalesces writes into one batch, closing after the quiet period", () => {
    vi.useFakeTimers();
    const closed: PendingBatch[] = [];
    const debouncer = new Debouncer({ debounceMs: 4000, maxFilesPerBatch: 25 }, (batch) =>
      closed.push(batch),
    );

    // Five files written 500ms apart: one batch, not five (§22.3 case 3).
    for (let i = 0; i < 5; i++) {
      debouncer.add(`src/file${i}.ts`, 100);
      vi.advanceTimersByTime(500);
    }
    expect(closed).toHaveLength(0); // still inside the quiet period

    vi.advanceTimersByTime(4000);
    expect(closed).toHaveLength(1);
    expect(closed[0].files.size).toBe(5);
  });

  it("closes early at maxFilesPerBatch rather than waiting (§22.3 case 4)", () => {
    vi.useFakeTimers();
    const closed: PendingBatch[] = [];
    const debouncer = new Debouncer({ debounceMs: 4000, maxFilesPerBatch: 25 }, (batch) =>
      closed.push(batch),
    );

    for (let i = 0; i < 30; i++) debouncer.add(`src/file${i}.ts`, 100);

    expect(closed).toHaveLength(1);
    expect(closed[0].files.size).toBe(25);
    // The overflow stays open for the next batch rather than being dropped.
    expect(debouncer.size).toBe(5);
  });

  it("resets the timer on every event", () => {
    vi.useFakeTimers();
    const closed: PendingBatch[] = [];
    const debouncer = new Debouncer({ debounceMs: 1000, maxFilesPerBatch: 25 }, (batch) =>
      closed.push(batch),
    );

    debouncer.add("a.ts", 10);
    vi.advanceTimersByTime(900);
    debouncer.add("b.ts", 10);
    vi.advanceTimersByTime(900);
    expect(closed).toHaveLength(0);
    vi.advanceTimersByTime(200);
    expect(closed).toHaveLength(1);
  });

  it("dedups repeated writes to one file", () => {
    vi.useFakeTimers();
    const closed: PendingBatch[] = [];
    const debouncer = new Debouncer({ debounceMs: 100, maxFilesPerBatch: 25 }, (batch) =>
      closed.push(batch),
    );
    debouncer.add("a.ts", 10);
    debouncer.add("a.ts", 20);
    vi.advanceTimersByTime(100);
    expect(closed[0].files.size).toBe(1);
  });

  it("never fires an empty batch", () => {
    vi.useFakeTimers();
    const closed: PendingBatch[] = [];
    const debouncer = new Debouncer({ debounceMs: 100, maxFilesPerBatch: 25 }, (batch) =>
      closed.push(batch),
    );
    debouncer.close("quiet");
    expect(closed).toHaveLength(0);
  });
});

describe("syntax check (§7.3, §7.4)", () => {
  it("accepts complete JS/TS and rejects a half-written function", () => {
    expect(checkJavaScriptSyntax("export function done() { return 1; }")).toBe("valid");
    // The §22.3 case 2 shape: an AI paused mid-function.
    expect(checkJavaScriptSyntax("export function half() { if (x) {")).toBe("invalid");
  });

  it("does not trip over TypeScript-only syntax", () => {
    expect(
      checkJavaScriptSyntax("import type { A } from './a';\nexport const x: number = 1;"),
    ).toBe("valid");
    expect(checkJavaScriptSyntax("interface Thing {\n  a: string;\n}\nconst t = 1;")).toBe("valid");
  });

  it("never executes the code it checks", () => {
    // If this were evaluated the process would exit; it must only be parsed.
    expect(checkJavaScriptSyntax("process.exit(1);")).toBe("valid");
  });

  it("degrades to unsupported for an extension with no checker", async () => {
    expect(await checkSyntax("notes.txt", "anything")).toBe("unsupported");
  });

  it("probes once per extension and caches for the process lifetime (§7.4)", async () => {
    let probes = 0;
    const run: CommandRunner = async (command) => {
      if (command === "python3" && probes >= 0) probes += 1;
      return { ok: true, timedOut: false, spawnFailed: false };
    };
    await checkSyntax("/tmp/a.py", "x = 1", run);
    await checkSyntax("/tmp/b.py", "y = 2", run);
    await checkSyntax("/tmp/c.py", "z = 3", run);
    // One probe, three checks.
    expect(probes).toBe(4); // 1 probe + 3 checks, all through the same runner
    expect(probeCacheSize()).toBe(1);
  });

  it("treats a missing toolchain as unsupported, never as invalid (§7.4)", async () => {
    const run: CommandRunner = async () => ({ ok: false, timedOut: false, spawnFailed: true });
    expect(await checkSyntax("/tmp/a.py", "x = 1", run)).toBe("unsupported");
  });

  it("treats a timeout as unsupported rather than invalid (§7.4)", async () => {
    // Probe succeeds, then the check times out: a slow toolchain must not read
    // as a mid-write file and stall the batch.
    let call = 0;
    const timingOut: CommandRunner = async () => {
      call += 1;
      return call === 1
        ? { ok: true, timedOut: false, spawnFailed: false }
        : { ok: false, timedOut: true, spawnFailed: false };
    };
    expect(await checkSyntax("/tmp/a.py", "x = 1", timingOut)).toBe("unsupported");
  });

  it("reports invalid when the toolchain says so", async () => {
    let call = 0;
    const run: CommandRunner = async () => {
      call += 1;
      return call === 1
        ? { ok: true, timedOut: false, spawnFailed: false } // probe
        : { ok: false, timedOut: false, spawnFailed: false }; // check
    };
    expect(await checkSyntax("/tmp/a.py", "def broken(", run)).toBe("invalid");
  });

  it("gates the pipeline to plausible source extensions (§7.1)", () => {
    expect(isSourceFile("src/a.ts")).toBe(true);
    expect(isSourceFile("main.py")).toBe(true);
    expect(isSourceFile("logo.png")).toBe(false);
    expect(isSourceFile("package-lock.json")).toBe(false);
  });
});

describe("log privacy (§16.1)", () => {
  it("NEVER writes file contents or diff bodies", () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "debug", sink: (line) => lines.push(line) });
    const diff = `--- a/src/secret.ts\n+++ b/src/secret.ts\n${"+const PROPRIETARY = 'value';\n".repeat(40)}`;

    logger.info("batch captured", { path: "src/secret.ts", diff, count: 3 });

    const written = lines.join("");
    expect(written).not.toContain("PROPRIETARY");
    expect(written).toMatch(/chars omitted/);
    // Paths, counts, and timings are exactly what it MAY log.
    expect(written).toContain("src/secret.ts");
    expect(written).toContain('"count":3');
  });

  it("masks anything shaped like an API key", () => {
    const secretShapedKey = ["sk", "ant", "api03", "SECRET"].join("-");
    expect(JSON.stringify(redactMeta({ error: `bad key ${secretShapedKey}` }))).not.toMatch(
      /SECRET/,
    );
    expect(JSON.stringify(redactMeta({ error: new Error(secretShapedKey) }))).toMatch(
      /sk-ant-\*\*\*/,
    );
  });

  it("summarizes objects rather than serializing them", () => {
    // A nested diff would otherwise reach the log through JSON.stringify.
    expect(redactMeta({ payload: { diff: "secret content" } })).toEqual({ payload: "<object>" });
    expect(redactMeta({ files: ["a", "b"] })).toEqual({ files: "<2 items>" });
  });

  it("respects the level, defaulting to info", () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "info", sink: (line) => lines.push(line) });
    logger.debug("noisy");
    logger.warn("important");
    expect(lines.join("")).not.toContain("noisy");
    expect(lines.join("")).toContain("important");
  });
});
