/**
 * The API provider and the real subprocess runner.  GOVERNED BY: §6.3, §9.6, §22.4
 *
 * This file replaces the global SDK mock with a controllable one so the error
 * mapping can be exercised; §22.1's no-network guarantee still holds, because
 * nothing here reaches the network.
 *
 * The mock delegates to a per-test handler rather than a shared `vi.fn()`:
 * resetting a shared mock whose recorded result is a rejected promise makes
 * vitest 2 re-report that rejection as unhandled, even when the code under test
 * caught it correctly.
 */
import { describe, expect, it, vi } from "vitest";

interface CreateCall {
  model: string;
  max_tokens: number;
  system: string;
  messages: { role: string; content: string }[];
}

const state: { handler: (body: CreateCall) => Promise<unknown>; calls: CreateCall[] } = {
  handler: () => Promise.reject(new Error("no handler set")),
  calls: [],
};

vi.mock("@anthropic-ai/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/sdk")>();
  class MockAnthropic {
    messages = {
      create: (body: CreateCall) => {
        state.calls.push(body);
        return state.handler(body);
      },
    };
  }
  // The real default export carries APIError as a static; mirror that.
  (MockAnthropic as unknown as { APIError: unknown }).APIError = actual.APIError;
  return { ...actual, default: MockAnthropic, APIError: actual.APIError };
});

const { createApiProvider, createCliRunner, ProviderError } =
  await import("../src/generation/provider.js");

const ASK = { system: "SYSTEM", model: "claude-sonnet-4-6", maxTokens: 4096 };
const SECRET_SHAPED_KEY = ["sk", "ant", "api03", "REDACT_ME"].join("-");

/** Point the mocked SDK at one behavior and return the calls it records. */
function whenCreate(handler: (body: CreateCall) => Promise<unknown>): CreateCall[] {
  state.handler = handler;
  state.calls = [];
  return state.calls;
}

function rejectsWith(
  status: number | undefined,
  message = "boom",
): (body: CreateCall) => Promise<never> {
  return () =>
    Promise.reject(
      status === undefined ? new Error(message) : Object.assign(new Error(message), { status }),
    );
}

async function askExpectingError(): Promise<InstanceType<typeof ProviderError>> {
  try {
    await createApiProvider("test-api-key").askModel("p", ASK);
  } catch (error) {
    return error as InstanceType<typeof ProviderError>;
  }
  throw new Error("expected askModel to reject");
}

describe("api provider", () => {
  it("joins text blocks and reports usage", async () => {
    const calls = whenCreate(() =>
      Promise.resolve({
        content: [
          { type: "text", text: '{"skip":' },
          { type: "thinking", thinking: "ignored" },
          { type: "text", text: "true}" },
        ],
        usage: { input_tokens: 12, output_tokens: 3 },
      }),
    );
    const reply = await createApiProvider("test-api-key").askModel("prompt", ASK);
    expect(reply.text).toBe('{"skip":true}');
    expect(reply.usage).toEqual({ input_tokens: 12, output_tokens: 3 });
    expect(calls[0]).toEqual({
      model: ASK.model,
      max_tokens: ASK.maxTokens,
      system: ASK.system,
      messages: [{ role: "user", content: "prompt" }],
    });
  });

  it.each([
    [401, "auth_error", false],
    [403, "auth_error", false],
    [429, "api_error", true],
    [500, "api_error", true],
    [503, "api_error", true],
    [400, "api_error", false],
    [404, "api_error", false],
  ])("maps HTTP %i to %s (retryable=%s)", async (status, reason, retryable) => {
    whenCreate(rejectsWith(status));
    const error = await askExpectingError();
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.reason).toBe(reason);
    expect(error.retryable).toBe(retryable);
  });

  it("treats a transport error with no status as retryable", async () => {
    whenCreate(rejectsWith(undefined, "socket hang up"));
    const error = await askExpectingError();
    expect(error.reason).toBe("api_error");
    expect(error.retryable).toBe(true);
    expect(error.message).toMatch(/socket hang up/);
  });

  it("redacts a key echoed back in an error (§16.1)", async () => {
    whenCreate(rejectsWith(401, `invalid key ${SECRET_SHAPED_KEY} here`));
    const error = await askExpectingError();
    expect(error.message).not.toMatch(/REDACT_ME/);
    expect(error.message).toMatch(/sk-ant-\*\*\*/);
  });

  it("constructs the client lazily and reuses it across calls", async () => {
    const calls = whenCreate(() =>
      Promise.resolve({ content: [], usage: { input_tokens: 1, output_tokens: 1 } }),
    );
    const provider = createApiProvider("test-api-key");
    expect(calls).toHaveLength(0); // nothing constructed or sent yet
    await provider.askModel("a", ASK);
    await provider.askModel("b", ASK);
    expect(calls).toHaveLength(2);
    expect(calls[1].messages[0].content).toBe("b");
  });
});

describe("the real execFile runner (§7.4, §22.4)", () => {
  const node = process.execPath;

  it("writes the prompt to stdin and reads stdout back", async () => {
    const run = createCliRunner(node);
    const outcome = await run({
      args: ["-e", "process.stdin.on('data', (d) => process.stdout.write(d))"],
      stdin: "prompt with 'quotes', `backticks`, and\nnewlines",
      timeoutMs: 10_000,
    });
    expect(outcome.stdout).toBe("prompt with 'quotes', `backticks`, and\nnewlines");
    expect(outcome.code).toBe(0);
    expect(outcome.timedOut).toBe(false);
  });

  it("reports a non-zero exit without throwing", async () => {
    const run = createCliRunner(node);
    const outcome = await run({
      args: ["-e", "process.stderr.write('nope'); process.exit(3)"],
      stdin: "",
      timeoutMs: 10_000,
    });
    expect(outcome.code).toBe(3);
    expect(outcome.stderr).toBe("nope");
  });

  it("kills a hung process and flags the timeout", async () => {
    const run = createCliRunner(node);
    const outcome = await run({
      args: ["-e", "setTimeout(() => {}, 30000)"],
      stdin: "",
      timeoutMs: 150,
    });
    expect(outcome.timedOut).toBe(true);
  });

  it("surfaces a missing binary as a spawn error, not a crash", async () => {
    const run = createCliRunner("grasp-definitely-not-a-real-binary");
    const outcome = await run({ args: [], stdin: "", timeoutMs: 5_000 });
    expect(outcome.spawnError?.code).toBe("ENOENT");
  });
});
