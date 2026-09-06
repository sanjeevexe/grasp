/**
 * Syntax-check lookup and probe cache.  GOVERNED BY: §7.3, §7.4
 *
 * A file that parses is strong evidence the write finished. A file that does not
 * is probably mid-write — the AI paused, or the editor autosaved a partial
 * function — so the batch waits and re-checks. After three consecutive failures
 * it proceeds anyway: the code may simply be broken, and Grasp is not a linter.
 *
 * PROBE ONCE, CACHE FOR THE DAEMON'S LIFETIME (§7.4). Never re-probe per file.
 * A missing toolchain marks the extension unsupported, and unsupported degrades
 * to debounce-only — it must NEVER block capture.
 *
 * All shell-outs use execFile with an argv array (§7.4), a 5s timeout, and treat
 * a timeout as "unsupported" rather than "invalid".
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseJs } from "@babel/parser";

export const PROBE_TIMEOUT_MS = 5000;
export const CHECK_TIMEOUT_MS = 5000;

/** §7.3 — after three consecutive parse failures, proceed anyway. */
export const MAX_SYNTAX_RETRIES = 3;

export type SyntaxResult = "valid" | "invalid" | "unsupported";

interface ShellCheck {
  /** Cheap availability test, run at most once per extension. */
  probe: { command: string; args: string[] };
  /** Argv builder for checking one file. */
  check: (file: string, tempDir: string) => { command: string; args: string[] };
}

/**
 * §7.4 — only JS/TS and Python must be verified working for v1. The rest ride on
 * probe-and-fallback: an untested entry degrades safely rather than breaking.
 */
const SHELL_CHECKS: Record<string, ShellCheck> = {
  ".py": {
    probe: { command: "python3", args: ["--version"] },
    check: (file) => ({
      command: "python3",
      args: ["-c", "import ast,sys; ast.parse(open(sys.argv[1]).read())", file],
    }),
  },
  ".go": {
    probe: { command: "gofmt", args: ["--help"] },
    check: (file) => ({ command: "gofmt", args: ["-e", file] }),
  },
  ".rs": {
    probe: { command: "rustc", args: ["--version"] },
    check: (file, tempDir) => ({
      command: "rustc",
      args: ["--edition", "2021", "--emit=metadata", "-o", path.join(tempDir, "out.rmeta"), file],
    }),
  },
  ".rb": {
    probe: { command: "ruby", args: ["--version"] },
    check: (file) => ({ command: "ruby", args: ["-c", file] }),
  },
  ".php": {
    probe: { command: "php", args: ["--version"] },
    check: (file) => ({ command: "php", args: ["-l", file] }),
  },
  ".java": {
    probe: { command: "javac", args: ["-version"] },
    check: (file, tempDir) => ({ command: "javac", args: ["-proc:only", "-d", tempDir, file] }),
  },
};

/** In-process parse, always available — no shell-out, no probe (§7.4). */
const IN_PROCESS_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"]);

/** §7.1 — everything else never enters the pipeline at all. */
export const SOURCE_EXTENSIONS = new Set([
  ...IN_PROCESS_EXTENSIONS,
  ...Object.keys(SHELL_CHECKS),
  ".cs",
  ".kt",
  ".swift",
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".hpp",
  ".scala",
  ".sh",
  ".sql",
  ".vue",
  ".svelte",
]);

export function isSourceFile(filePath: string): boolean {
  return SOURCE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export type CommandRunner = (
  command: string,
  args: string[],
  timeoutMs: number,
) => Promise<{ ok: boolean; timedOut: boolean; spawnFailed: boolean }>;

/** §7.4 — execFile with an argv array, never exec with an interpolated string. */
export const defaultRunner: CommandRunner = (command, args, timeoutMs) =>
  new Promise((resolve) => {
    let timedOut = false;
    const child = execFile(command, args, { timeout: timeoutMs, windowsHide: true }, (error) => {
      const err = error as (NodeJS.ErrnoException & { code?: string | number }) | null;
      const spawnFailed = Boolean(err && typeof err.code === "string" && err.code === "ENOENT");
      resolve({ ok: !error, timedOut, spawnFailed });
    });
    child.on("exit", (_code, signal) => {
      if (signal === "SIGTERM") timedOut = true;
    });
  });

/**
 * Probe results live for the process lifetime (§7.4). Exported reset exists for
 * tests only — the daemon never clears it.
 */
const probeCache = new Map<string, boolean>();

export function resetProbeCache(): void {
  probeCache.clear();
}

export function probeCacheSize(): number {
  return probeCache.size;
}

async function isToolchainAvailable(extension: string, run: CommandRunner): Promise<boolean> {
  const cached = probeCache.get(extension);
  if (cached !== undefined) return cached;

  const entry = SHELL_CHECKS[extension];
  if (!entry) {
    probeCache.set(extension, false);
    return false;
  }
  const result = await run(entry.probe.command, entry.probe.args, PROBE_TIMEOUT_MS);
  const available = result.ok && !result.timedOut && !result.spawnFailed;
  probeCache.set(extension, available);
  return available;
}

/**
 * In-process JS/TS/JSX parse (§7.4) — no shell-out, always available.
 *
 * DECISION: `@babel/parser`, chosen because §7.4 calls for "a bundled parser"
 * without naming one. The runtime's own `new Function` cannot do this job: it
 * rejects `import`/`export` outright (illegal in a function body) and every TS
 * type annotation, so almost every real file would read as mid-write and stall
 * the batch forever. Babel is pure JavaScript, so §3's zero-compiled-dependency
 * rule still holds, and it parses TS and JSX without a separate toolchain.
 *
 * Parsing only — the code is NEVER executed.
 */
export function checkJavaScriptSyntax(source: string, filePath = "file.ts"): SyntaxResult {
  const extension = path.extname(filePath).toLowerCase();
  const plugins: ("typescript" | "jsx")[] = [".tsx", ".jsx"].includes(extension)
    ? ["typescript", "jsx"]
    : ["typescript"];
  try {
    // `unambiguous` handles both ESM and CommonJS files in one call.
    //
    // `errorRecovery` draws exactly the line §7.3 wants. The question here is
    // "did the write finish?", not "is this code correct". With recovery on,
    // Babel still THROWS on a truncated write (an unclosed brace, a half-typed
    // object, an unterminated string) but RECOVERS from semantic complaints like
    // a duplicate declaration — which say nothing about whether the file is
    // complete. Without it, a file with one redeclaration would be read as
    // mid-write on every batch until the retry budget ran out.
    parseJs(source, { sourceType: "unambiguous", plugins, errorRecovery: true });
    return "valid";
  } catch {
    return "invalid";
  }
}

export async function checkSyntax(
  filePath: string,
  content: string,
  run: CommandRunner = defaultRunner,
): Promise<SyntaxResult> {
  const extension = path.extname(filePath).toLowerCase();

  if (IN_PROCESS_EXTENSIONS.has(extension)) return checkJavaScriptSyntax(content, filePath);
  if (!(extension in SHELL_CHECKS)) return "unsupported";
  if (!(await isToolchainAvailable(extension, run))) return "unsupported";

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "grasp-syntax-"));
  try {
    const { command, args } = SHELL_CHECKS[extension].check(filePath, tempDir);
    const result = await run(command, args, CHECK_TIMEOUT_MS);
    // A timeout is "unsupported", not "invalid": a slow toolchain must not be
    // read as a mid-write file and stall the batch (§7.4).
    if (result.timedOut || result.spawnFailed) return "unsupported";
    return result.ok ? "valid" : "invalid";
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
