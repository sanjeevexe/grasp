/**
 * Provider resolution and the CLI isolation contract.  GOVERNED BY: §6.3, §22.2
 *
 * The argv assertions here are not style checks. Every isolation flag was added
 * because dropping it changes what the model sees — verified against the real
 * CLI, which answers from a repo's CLAUDE.md when run without them.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLAUDE_BIN,
  ProviderError,
  createClaudeCliProvider,
  probeClaudeCli,
  resetProviderProbeCache,
  resolveProvider,
  type CliOutcome,
  type CliRunner,
} from "../src/generation/provider.js";

const ASK = { system: "SYSTEM RULES", model: "claude-sonnet-4-6", maxTokens: 4096 };
const SECRET_SHAPED_KEY = ["sk", "ant", "api03", "REDACT_ME"].join("-");

function outcome(over: Partial<CliOutcome> = {}): CliOutcome {
  return { stdout: "", stderr: "", code: 0, timedOut: false, ...over };
}

const loggedIn = JSON.stringify({
  loggedIn: true,
  authMethod: "claude.ai",
  subscriptionType: "pro",
});

function envelope(result: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    is_error: false,
    subtype: "success",
    result,
    usage: { input_tokens: 100, output_tokens: 20 },
    ...extra,
  });
}

/** A runner that answers the auth probe and records every invocation. */
function runnerFor(replies: (args: string[]) => CliOutcome): {
  run: CliRunner;
  calls: { args: string[]; stdin: string; timeoutMs: number }[];
} {
  const calls: { args: string[]; stdin: string; timeoutMs: number }[] = [];
  const run: CliRunner = async (invocation) => {
    calls.push(invocation);
    return replies(invocation.args);
  };
  return { run, calls };
}

beforeEach(() => resetProviderProbeCache());

describe("probeClaudeCli", () => {
  it("costs no model tokens — it only runs `auth status --json`", async () => {
    const { run, calls } = runnerFor(() => outcome({ stdout: loggedIn }));
    await probeClaudeCli(run);
    expect(calls[0].args).toEqual(["auth", "status", "--json"]);
    expect(calls[0].stdin).toBe("");
  });

  it.each([
    [
      "a missing binary",
      outcome({ spawnError: Object.assign(new Error("enoent"), { code: "ENOENT" }) }),
    ],
    ["a non-zero exit", outcome({ code: 1 })],
    ["a timeout", outcome({ timedOut: true })],
    ["unparseable output", outcome({ stdout: "not json" })],
    ["loggedIn false", outcome({ stdout: JSON.stringify({ loggedIn: false }) })],
  ])("returns null on %s", async (_label, result) => {
    const { run } = runnerFor(() => result);
    await expect(probeClaudeCli(run)).resolves.toBeNull();
  });
});

describe("resolveProvider", () => {
  it("auto picks claude-cli when the CLI is logged in", async () => {
    const { run } = runnerFor(() => outcome({ stdout: loggedIn }));
    const provider = await resolveProvider({
      setting: "auto",
      runCli: run,
      apiKey: "test-api-key",
      env: {},
    });
    expect(provider.name).toBe("claude-cli");
  });

  it("auto falls back to the API key when the CLI is unavailable", async () => {
    const { run } = runnerFor(() => outcome({ code: 1 }));
    const provider = await resolveProvider({
      setting: "auto",
      runCli: run,
      apiKey: "test-api-key",
      env: {},
    });
    expect(provider.name).toBe("api");
  });

  it("auto reads ANTHROPIC_API_KEY when config has no key", async () => {
    const { run } = runnerFor(() => outcome({ code: 1 }));
    const provider = await resolveProvider({
      setting: "auto",
      runCli: run,
      env: { ANTHROPIC_API_KEY: "environment-test-key" },
    });
    expect(provider.name).toBe("api");
  });

  it("auto with neither route available errors naming BOTH", async () => {
    const { run } = runnerFor(() => outcome({ code: 1 }));
    const error = await resolveProvider({ setting: "auto", runCli: run, env: {} }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).message).toMatch(/claude auth login/);
    expect((error as ProviderError).message).toMatch(/ANTHROPIC_API_KEY/);
    expect((error as ProviderError).reason).toBe("auth_error");
  });

  it("a pinned provider never silently falls back", async () => {
    const { run } = runnerFor(() => outcome({ code: 1 }));
    await expect(
      resolveProvider({ setting: "claude-cli", runCli: run, apiKey: "test-api-key", env: {} }),
    ).rejects.toThrow(/claude auth login/);

    resetProviderProbeCache();
    const { run: ok } = runnerFor(() => outcome({ stdout: loggedIn }));
    await expect(resolveProvider({ setting: "api", runCli: ok, env: {} })).rejects.toThrow(
      /no API key is configured/,
    );
  });

  it("caches the probe instead of re-running it per call (§7.4)", async () => {
    const { run, calls } = runnerFor(() => outcome({ stdout: loggedIn }));
    await resolveProvider({ setting: "auto", runCli: run, env: {} });
    await resolveProvider({ setting: "auto", runCli: run, env: {} });
    expect(calls.filter((c) => c.args[0] === "auth")).toHaveLength(1);
  });
});

describe("claude-cli provider", () => {
  it("carries every isolation flag and sends the prompt on stdin", async () => {
    const { run, calls } = runnerFor(() => outcome({ stdout: envelope('{"skip":true}') }));
    await createClaudeCliProvider(run).askModel("THE PROMPT", ASK);

    const { args, stdin, timeoutMs } = calls[0];
    // Context isolation (§6.3.1) — verified against the real CLI.
    expect(args).toContain("--safe-mode");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--no-session-persistence");
    // The prompt replaces the default system prompt rather than appending.
    expect(args[args.indexOf("--system-prompt") + 1]).toBe(ASK.system);
    // No filesystem access: the diff is in the prompt.
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--output-format") + 1]).toBe("json");
    expect(args[args.indexOf("--model") + 1]).toBe(ASK.model);
    expect(args).toContain("-p");
    // --bare would force ANTHROPIC_API_KEY-only auth, defeating this path.
    expect(args).not.toContain("--bare");
    // Long prompts go over stdin, never argv (§7.4).
    expect(stdin).toBe("THE PROMPT");
    expect(args).not.toContain("THE PROMPT");
    expect(timeoutMs).toBeGreaterThan(0);
  });

  it("strips the CLI envelope so the parser sees only model text", async () => {
    const { run } = runnerFor(() =>
      outcome({ stdout: envelope('{"skip":true,"skip_reason":"x"}') }),
    );
    const reply = await createClaudeCliProvider(run).askModel("p", ASK);
    expect(reply.text).toBe('{"skip":true,"skip_reason":"x"}');
    expect(reply.usage).toEqual({ input_tokens: 100, output_tokens: 20 });
  });

  it("counts cached input tokens, which the CLI reports separately", async () => {
    const { run } = runnerFor(() =>
      outcome({
        stdout: JSON.stringify({
          is_error: false,
          subtype: "success",
          result: "{}",
          usage: {
            input_tokens: 3,
            output_tokens: 900,
            cache_read_input_tokens: 6000,
            cache_creation_input_tokens: 1200,
          },
        }),
      }),
    );
    const reply = await createClaudeCliProvider(run).askModel("p", ASK);
    // 3 alone would read as a near-empty prompt.
    expect(reply.usage).toEqual({ input_tokens: 7203, output_tokens: 900 });
  });

  it("maps a missing binary to a non-retryable auth error", async () => {
    const { run } = runnerFor(() =>
      outcome({ spawnError: Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }) }),
    );
    const error = (await createClaudeCliProvider(run)
      .askModel("p", ASK)
      .catch((e: unknown) => e)) as ProviderError;
    expect(error.reason).toBe("auth_error");
    expect(error.retryable).toBe(false);
    expect(error.message).toMatch(/not installed/);
  });

  it("maps a timeout to a non-retryable api error (no in-loop stall)", async () => {
    const { run } = runnerFor(() => outcome({ timedOut: true }));
    const error = (await createClaudeCliProvider(run)
      .askModel("p", ASK)
      .catch((e: unknown) => e)) as ProviderError;
    expect(error.reason).toBe("api_error");
    expect(error.retryable).toBe(false);
  });

  it("treats a logged-out CLI as auth, and a generic failure as retryable", async () => {
    const { run: out } = runnerFor(() =>
      outcome({ code: 1, stderr: "Not logged in. Please run claude auth login" }),
    );
    const authError = (await createClaudeCliProvider(out)
      .askModel("p", ASK)
      .catch((e: unknown) => e)) as ProviderError;
    expect(authError.reason).toBe("auth_error");
    expect(authError.retryable).toBe(false);

    const { run: boom } = runnerFor(() => outcome({ code: 2, stderr: "upstream connect error" }));
    const apiError = (await createClaudeCliProvider(boom)
      .askModel("p", ASK)
      .catch((e: unknown) => e)) as ProviderError;
    expect(apiError.reason).toBe("api_error");
    expect(apiError.retryable).toBe(true);
  });

  it("rejects an error envelope and unparseable output", async () => {
    const { run: errored } = runnerFor(() =>
      outcome({
        stdout: JSON.stringify({
          is_error: true,
          subtype: "error_during_execution",
          result: "boom",
        }),
      }),
    );
    await expect(createClaudeCliProvider(errored).askModel("p", ASK)).rejects.toThrow(
      /error_during_execution/,
    );

    const { run: garbage } = runnerFor(() => outcome({ stdout: "<!doctype html>" }));
    await expect(createClaudeCliProvider(garbage).askModel("p", ASK)).rejects.toBeInstanceOf(
      ProviderError,
    );
  });

  it("redacts an API key that appears in CLI output", async () => {
    const { run } = runnerFor(() => outcome({ code: 1, stderr: `bad key ${SECRET_SHAPED_KEY}` }));
    const error = (await createClaudeCliProvider(run)
      .askModel("p", ASK)
      .catch((e: unknown) => e)) as ProviderError;
    expect(error.message).not.toMatch(/REDACT_ME/);
    expect(error.message).toMatch(/sk-ant-\*\*\*/);
  });

  it("never spawns the real CLI in tests", async () => {
    // The setup file mocks execFile; this asserts the guard is live.
    const { execFile } = await import("node:child_process");
    expect(() => (execFile as unknown as (f: string) => void)(CLAUDE_BIN)).toThrow(
      /real `claude` CLI/,
    );
    expect(vi.isMockFunction).toBeDefined();
  });
});
