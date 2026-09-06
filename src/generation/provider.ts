/**
 * Model transport.  GOVERNED BY: §6.3, §9.1
 *
 * ONE interface, two implementations, and nothing outside this file knows which
 * one ran:
 *
 *   claude-cli — shells out to the user's installed Claude Code CLI, which uses
 *                their existing subscription auth. Zero setup, no API credits.
 *   api        — the Anthropic SDK, for users with an API key and no Claude Code.
 *
 * Resolution (§6.3): claude-cli if present AND authenticated → api if a key is
 * configured → a clear error naming both routes.
 *
 * The CLI path needs four things right, or generation quality silently rots:
 *
 *   1. CONTEXT ISOLATION. `claude -p` reads CLAUDE.md, user memory, and project
 *      settings from its working directory. Verified empirically: run inside a
 *      repo with a CLAUDE.md and the model answers questions about that project.
 *      Grasp's prompt must be the ONLY instruction, so: run from a neutral temp
 *      cwd, pass --safe-mode (disables CLAUDE.md, skills, plugins, hooks, MCP,
 *      custom agents and settings while leaving auth alone), --strict-mcp-config
 *      with no --mcp-config, and --system-prompt, which REPLACES the default
 *      system prompt rather than appending to it.
 *   2. NO TOOLS. Grasp puts the diff in the prompt; the model must not go
 *      reading the filesystem. `--tools ""` disables the whole built-in set.
 *   3. PARSEABLE OUTPUT. `--output-format json` returns an envelope whose
 *      `result` field holds the model text. That framing is stripped here, so
 *      the fence-stripping in generateQuestion.ts sees the same string it would
 *      have seen from the SDK.
 *   4. execFile WITH A TIMEOUT (§7.4). Never exec with an interpolated string —
 *      prompts contain quotes, backticks, and newlines. CLI-missing,
 *      not-authenticated, and timeout all map onto the normal failure path:
 *      no crash, no notification (§9.6).
 *
 * DECISION: --bare looks like the obvious isolation flag and is the wrong one —
 * it forces auth to ANTHROPIC_API_KEY only, which defeats the entire point of
 * this path. --safe-mode is the flag that keeps subscription auth.
 *
 * DECISION: the child inherits the environment unchanged. Scrubbing
 * ANTHROPIC_API_KEY would force subscription billing, but it would also break
 * users whose Claude Code runs against Bedrock, Vertex, or a corporate gateway.
 * The CLI resolves its own credentials exactly as it does interactively.
 */
import { execFile } from "node:child_process";
import os from "node:os";
import Anthropic from "@anthropic-ai/sdk";
import type { GenerationFailureReason } from "../types/index.js";

export type ProviderName = "claude-cli" | "api";
export type ProviderSetting = "auto" | ProviderName;

export const CLAUDE_BIN = "claude";
export const CLI_PROBE_TIMEOUT_MS = 10_000;
export const CLI_GENERATION_TIMEOUT_MS = 180_000;
export const CLI_MAX_BUFFER = 16 * 1024 * 1024;

/** Everything that keeps ambient context out of the call. See note 1 above. */
export const CLI_ISOLATION_ARGS: readonly string[] = [
  "--safe-mode",
  "--strict-mcp-config",
  "--no-session-persistence",
  "--tools",
  "",
];

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface AskOptions {
  system: string;
  model: string;
  /** Honored by the API path; the CLI has no equivalent flag and ignores it. */
  maxTokens: number;
}

export interface AskResult {
  text: string;
  usage: TokenUsage | null;
}

export interface ModelProvider {
  readonly name: ProviderName;
  askModel(prompt: string, opts: AskOptions): Promise<AskResult>;
}

/**
 * Transport failures, classified by the provider so that callers never branch on
 * HTTP status codes or CLI exit codes — the two paths report the same shapes.
 */
export class ProviderError extends Error {
  constructor(
    readonly reason: Extract<GenerationFailureReason, "api_error" | "auth_error">,
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/** §16.1 — an API key must never reach a log, an error string, or the DB. */
export function redact(text: string): string {
  return text.replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-***");
}

/* ------------------------------------------------------------------ *
 * claude-cli
 * ------------------------------------------------------------------ */

export interface CliInvocation {
  args: string[];
  stdin: string;
  timeoutMs: number;
}

export interface CliOutcome {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  /** Set when the binary could not be spawned at all (ENOENT etc.). */
  spawnError?: NodeJS.ErrnoException;
}

export type CliRunner = (invocation: CliInvocation) => Promise<CliOutcome>;

/**
 * §7.4 — execFile with an argv array, never a shell string.
 *
 * The binary is a parameter so the tests can exercise this exact code path
 * against a harmless process: §22.4's rule that the real spawn path must run for
 * real on every platform is where the cross-platform bugs actually are.
 */
export const createCliRunner =
  (bin: string = CLAUDE_BIN): CliRunner =>
  ({ args, stdin, timeoutMs }) =>
    new Promise<CliOutcome>((resolve) => {
      let timedOut = false;
      const child = execFile(
        bin,
        args,
        {
          // A neutral cwd: nothing to discover, nothing to leak.
          cwd: os.tmpdir(),
          timeout: timeoutMs,
          maxBuffer: CLI_MAX_BUFFER,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          const err = error as (NodeJS.ErrnoException & { code?: string | number }) | null;
          const spawnError = err && typeof err.code === "string" ? err : undefined;
          resolve({
            stdout,
            stderr,
            code: child.exitCode,
            timedOut,
            spawnError,
          });
        },
      );
      child.on("exit", (_code, signal) => {
        // execFile's timeout kills the child; the signal is how we tell that apart
        // from an ordinary non-zero exit.
        if (signal === "SIGTERM") timedOut = true;
      });
      child.stdin?.end(stdin);
    });

export const defaultCliRunner: CliRunner = createCliRunner();

export interface CliAuthStatus {
  loggedIn: boolean;
  /** e.g. "claude.ai" for a subscription, or an API-key method. */
  authMethod?: string;
  subscriptionType?: string;
}

/**
 * §7.4's probe-once rule: `claude auth status --json` costs no model tokens, but
 * it does spawn a process, so the answer is cached for the process lifetime.
 */
let cliProbeCache: Promise<CliAuthStatus | null> | undefined;

export function resetProviderProbeCache(): void {
  cliProbeCache = undefined;
}

export async function probeClaudeCli(
  run: CliRunner = defaultCliRunner,
): Promise<CliAuthStatus | null> {
  const outcome = await run({
    args: ["auth", "status", "--json"],
    stdin: "",
    timeoutMs: CLI_PROBE_TIMEOUT_MS,
  });
  if (outcome.spawnError || outcome.timedOut || outcome.code !== 0) return null;
  try {
    const parsed: unknown = JSON.parse(outcome.stdout);
    if (typeof parsed !== "object" || parsed === null) return null;
    const status = parsed as CliAuthStatus;
    return status.loggedIn === true ? status : null;
  } catch {
    return null;
  }
}

function probeClaudeCliCached(run: CliRunner): Promise<CliAuthStatus | null> {
  cliProbeCache ??= probeClaudeCli(run);
  return cliProbeCache;
}

/** The `--output-format json` envelope. Only the fields Grasp reads. */
interface CliEnvelope {
  is_error?: boolean;
  subtype?: string;
  result?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

/**
 * The CLI reports cached input separately from fresh input, so `input_tokens`
 * alone reads as ~3 on a cached call. Sum them, or the number is misleading
 * wherever it is displayed.
 */
function cliInputTokens(usage: NonNullable<CliEnvelope["usage"]>): number {
  return (
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  );
}

export function createClaudeCliProvider(run: CliRunner = defaultCliRunner): ModelProvider {
  return {
    name: "claude-cli",
    async askModel(prompt, opts) {
      const outcome = await run({
        args: [
          "-p",
          "--system-prompt",
          opts.system,
          "--output-format",
          "json",
          "--model",
          opts.model,
          ...CLI_ISOLATION_ARGS,
        ],
        stdin: prompt,
        timeoutMs: CLI_GENERATION_TIMEOUT_MS,
      });

      if (outcome.spawnError) {
        throw new ProviderError(
          "auth_error",
          false,
          outcome.spawnError.code === "ENOENT"
            ? "the `claude` CLI is not installed or not on PATH"
            : `could not run the \`claude\` CLI: ${redact(outcome.spawnError.message)}`,
        );
      }
      if (outcome.timedOut) {
        // DECISION: not retryable in-loop. Three more 180s attempts would stall a
        // capture batch for ten minutes; the checkpoint stays put either way, so
        // `grasp retry` is the right place to pick it back up (§9.6).
        throw new ProviderError(
          "api_error",
          false,
          `the \`claude\` CLI timed out after ${CLI_GENERATION_TIMEOUT_MS}ms`,
        );
      }

      let envelope: CliEnvelope | null = null;
      try {
        envelope = JSON.parse(outcome.stdout) as CliEnvelope;
      } catch {
        envelope = null;
      }

      if (outcome.code !== 0 || envelope === null) {
        const detail = redact((outcome.stderr || outcome.stdout || "").trim().slice(0, 500));
        // Not authenticated shows up here rather than at the probe when auth
        // lapses between the probe and the call.
        const isAuth = /not (logged in|authenticated)|please run .*login|invalid api key/i.test(
          detail,
        );
        throw new ProviderError(
          isAuth ? "auth_error" : "api_error",
          !isAuth,
          `the \`claude\` CLI exited with code ${outcome.code}: ${detail || "no output"}`,
        );
      }

      if (envelope.is_error === true || (envelope.subtype && envelope.subtype !== "success")) {
        throw new ProviderError(
          "api_error",
          true,
          `the \`claude\` CLI reported ${envelope.subtype ?? "an error"}: ${redact(
            (envelope.result ?? "").slice(0, 500),
          )}`,
        );
      }
      if (typeof envelope.result !== "string") {
        throw new ProviderError("api_error", true, "the `claude` CLI returned no result field");
      }

      const usage =
        typeof envelope.usage?.input_tokens === "number" &&
        typeof envelope.usage?.output_tokens === "number"
          ? {
              input_tokens: cliInputTokens(envelope.usage),
              output_tokens: envelope.usage.output_tokens,
            }
          : null;

      return { text: envelope.result, usage };
    },
  };
}

/* ------------------------------------------------------------------ *
 * api
 * ------------------------------------------------------------------ */

export function createApiProvider(apiKey?: string): ModelProvider {
  let client: Anthropic | undefined;
  return {
    name: "api",
    async askModel(prompt, opts) {
      try {
        // Lazy: constructing at import time would break the no-side-effects rule
        // (§3) and would throw in processes that never generate.
        client ??= new Anthropic({
          apiKey,
          // §9.6 owns the retry policy; the SDK's own retries would double it.
          maxRetries: 0,
        });
        const message = await client.messages.create({
          model: opts.model,
          max_tokens: opts.maxTokens,
          system: opts.system,
          messages: [{ role: "user", content: prompt }],
        });
        const text = message.content
          .filter((block): block is Anthropic.TextBlock => block.type === "text")
          .map((block) => block.text)
          .join("");
        return {
          text,
          usage: {
            input_tokens: message.usage.input_tokens,
            output_tokens: message.usage.output_tokens,
          },
        };
      } catch (error) {
        throw toProviderError(error);
      }
    },
  };
}

function toProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;

  // Read `status` structurally rather than via `instanceof Anthropic.APIError`:
  // every SDK error class carries it, and structural reading keeps this working
  // when the SDK is mocked at the module boundary (§22.1).
  const status =
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof (error as { status: unknown }).status === "number"
      ? (error as { status: number }).status
      : undefined;
  const detail = redact(error instanceof Error ? error.message : String(error));

  if (status === 401 || status === 403) {
    return new ProviderError(
      "auth_error",
      false,
      `authentication failed (HTTP ${status}) — check your API key: ${detail}`,
    );
  }
  const retryable = status === 429 || status === undefined || (status >= 500 && status < 600);
  return new ProviderError(
    "api_error",
    retryable,
    status === undefined
      ? `request failed: ${detail}`
      : `request failed with HTTP ${status}: ${detail}`,
  );
}

/* ------------------------------------------------------------------ *
 * Resolution (§6.3)
 * ------------------------------------------------------------------ */

export const NO_PROVIDER_MESSAGE =
  "No model provider available. Either install Claude Code and run `claude auth login` " +
  "(Grasp then uses your existing subscription — no API credits needed), " +
  "or set ANTHROPIC_API_KEY / apiKey in ~/.grasp/config.json.";

export interface ResolveProviderOptions {
  setting?: ProviderSetting;
  /** From config.apiKey; falls back to ANTHROPIC_API_KEY. */
  apiKey?: string | null;
  runCli?: CliRunner;
  env?: NodeJS.ProcessEnv;
}

export async function resolveProvider(
  options: ResolveProviderOptions = {},
): Promise<ModelProvider> {
  const setting = options.setting ?? "auto";
  const run = options.runCli ?? defaultCliRunner;
  const env = options.env ?? process.env;
  const apiKey = options.apiKey ?? env.ANTHROPIC_API_KEY ?? null;

  if (setting === "claude-cli") {
    if (await probeClaudeCliCached(run)) return createClaudeCliProvider(run);
    throw new ProviderError(
      "auth_error",
      false,
      'provider is set to "claude-cli", but the `claude` CLI is not installed or not logged in — run `claude auth login`.',
    );
  }

  if (setting === "api") {
    if (apiKey) return createApiProvider(apiKey);
    throw new ProviderError(
      "auth_error",
      false,
      'provider is set to "api", but no API key is configured — set ANTHROPIC_API_KEY or apiKey in ~/.grasp/config.json.',
    );
  }

  if (await probeClaudeCliCached(run)) return createClaudeCliProvider(run);
  if (apiKey) return createApiProvider(apiKey);
  throw new ProviderError("auth_error", false, NO_PROVIDER_MESSAGE);
}
