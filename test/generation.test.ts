/**
 * Generation parsing, validation, clamping, and retry.  GOVERNED BY: §9.4, §9.6, §22.2
 *
 * These cover the machinery around the prompt, not the prompt's wording: they
 * must keep passing while the prompt is rewritten.
 */
import { describe, expect, it } from "vitest";
import {
  API_RETRY_DELAYS_MS,
  MAX_TOKENS,
  extractDeclaredIdentifiers,
  findLeakedIdentifiers,
  generateQuestions,
  generateSynthesisQuestion,
  isDistinctiveIdentifier,
  parseModelJson,
  stripFences,
  validateGenerationResult,
  validateSynthesisResult,
} from "../src/generation/generateQuestion.js";
import { ProviderError, type AskOptions, type ModelProvider } from "../src/generation/provider.js";
import {
  MAX_KNOWN_TAGS,
  buildSystemPrompt,
  buildUserMessage,
  tierForMastery,
} from "../src/generation/prompts/systemPrompt.js";
import { pathsEqual } from "../src/util/paths.js";
import type { GenerationInput, Tier } from "../src/types/index.js";

const FILES = ["src/hooks/useDebouncedSearch.ts", "src/api/search.ts"];

function input(
  mastery: Record<string, Tier> = {},
  over: Partial<GenerationInput> = {},
): GenerationInput {
  return {
    kind: "live",
    files: [...FILES],
    masteryContext: mastery,
    knownTags: ["debouncing", "auth-flow"],
    diff: "--- a/src/hooks/useDebouncedSearch.ts\n+++ b/src/hooks/useDebouncedSearch.ts\n@@\n+const t = setTimeout(fn, delay);\n",
    ...over,
  } as GenerationInput;
}

function question(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    concept_tag: "debouncing",
    reframe: false,
    tier: "trace",
    files: [FILES[0]],
    teaching_card: null,
    question: "If query changes three times within 300ms, how many times does setDebounced run?",
    sample_answer: "Once — each keystroke clears the previous timer.",
    hint: "Look at what happens to the previous timer.",
    scaffold: ["What does the cleanup do?", "When does the effect re-run?"],
    ...over,
  };
}

function payload(
  over: Record<string, unknown> = {},
  questions?: Record<string, unknown>[],
): string {
  return JSON.stringify({
    skip: false,
    skip_reason: null,
    questions: questions ?? [question()],
    ...over,
  });
}

/** A provider that returns canned text and records what it was asked. */
function fakeProvider(replies: string[]): ModelProvider & {
  prompts: string[];
  opts: AskOptions[];
} {
  let i = 0;
  const prompts: string[] = [];
  const opts: AskOptions[] = [];
  return {
    name: "api",
    prompts,
    opts,
    askModel: async (prompt, options) => {
      prompts.push(prompt);
      opts.push(options);
      return { text: replies[Math.min(i++, replies.length - 1)], usage: null };
    },
  };
}

function throwingProvider(errors: unknown[], success?: string): ModelProvider & { calls: number } {
  const provider = {
    name: "api" as const,
    calls: 0,
    askModel: async () => {
      const error = errors[provider.calls];
      provider.calls += 1;
      if (error) throw error;
      if (success) return { text: success, usage: null };
      throw new Error("no reply configured");
    },
  };
  return provider;
}

const noSleep = { sleep: async () => {}, random: () => 0 };

describe("parsing (§9.4)", () => {
  it("parses a clean payload", () => {
    expect(parseModelJson(payload()).ok).toBe(true);
  });

  it("strips ```json fences the prompt forbids but models emit anyway", () => {
    expect(stripFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(parseModelJson("```\n" + payload() + "\n```").ok).toBe(true);
  });

  it("recovers a single object wrapped in prose", () => {
    const parsed = parseModelJson("Here you go:\n" + payload() + "\nHope that helps!");
    expect(parsed.ok).toBe(true);
  });

  it("rejects empty and non-JSON output", () => {
    expect(parseModelJson("   ")).toEqual({ ok: false, error: "model returned an empty response" });
    expect(parseModelJson("no json here")).toEqual({
      ok: false,
      error: "response was not valid JSON",
    });
  });
});

describe("validation (§9.4)", () => {
  it("accepts a valid payload", () => {
    const result = validateGenerationResult(JSON.parse(payload()), input({ debouncing: "none" }));
    expect(result.ok).toBe(true);
  });

  it("skip:true needs a reason and no questions", () => {
    const ok = validateGenerationResult({ skip: true, skip_reason: "lockfile bump" }, input());
    expect(ok).toEqual({
      ok: true,
      value: { skip: true, skip_reason: "lockfile bump", questions: [] },
      warnings: [],
    });

    expect(validateGenerationResult({ skip: true }, input()).ok).toBe(false);
    expect(
      validateGenerationResult({ skip: true, skip_reason: "x", questions: [question()] }, input())
        .ok,
    ).toBe(false);
  });

  it.each([
    ["unknown tier", question({ tier: "expert" })],
    [
      "missing sample_answer",
      (() => {
        const q = question();
        delete q.sample_answer;
        return q;
      })(),
    ],
    ["empty question text", question({ question: "  " })],
    ["a non-hyphenated tag", question({ concept_tag: "Auth Flow" })],
    ["a non-boolean reframe", question({ reframe: "yes" })],
    ["no files", question({ files: [] })],
    ["a teaching card with no body", question({ teaching_card: { deeper: "x" } })],
    ["trace with no scaffold", question({ scaffold: [] })],
  ])("rejects %s without coercing it", (_label, bad) => {
    const result = validateGenerationResult(JSON.parse(payload({}, [bad])), input());
    expect(result.ok).toBe(false);
  });

  it("rejects more than three questions (§9.4)", () => {
    const four = [question(), question(), question(), question()];
    const result = validateGenerationResult(JSON.parse(payload({}, four)), input());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations[0]).toMatch(/at most 3/);
  });

  it("rejects a non-object response and a missing skip flag", () => {
    expect(validateGenerationResult([1, 2], input()).ok).toBe(false);
    expect(validateGenerationResult({ questions: [] }, input()).ok).toBe(false);
    expect(validateGenerationResult({ skip: false, questions: [] }, input()).ok).toBe(false);
    expect(validateGenerationResult({ skip: false, questions: "no" }, input()).ok).toBe(false);
  });

  it("defaults absent optional fields instead of failing", () => {
    const bare = question();
    delete bare.reframe;
    delete bare.teaching_card;
    const result = validateGenerationResult(
      JSON.parse(payload({}, [bare])),
      input({ debouncing: "trace" }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.questions[0].reframe).toBe(false);
      expect(result.value.questions[0].teaching_card).toBeNull();
    }
  });
});

describe("tier clamping (§9.2 step 4, §9.6)", () => {
  const RANK = { trace: 0, predict_break: 1, reconstruct: 2 } as const;

  it.each([
    ["none", "trace"],
    ["trace", "predict_break"],
    ["predict_break", "reconstruct"],
    ["reconstruct", "reconstruct"],
  ] as const)("mastery %s sets a ceiling of tier %s", (mastery, ceiling) => {
    expect(tierForMastery(mastery)).toBe(ceiling);
    // The mastery map is a ceiling: never store a tier above it, never promote
    // a question written for a lower one.
    for (const claimed of ["trace", "predict_break", "reconstruct"] as const) {
      const q = question({ tier: claimed, scaffold: ["a", "b"] });
      const result = validateGenerationResult(
        JSON.parse(payload({}, [q])),
        input({ debouncing: mastery }),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        const stored = result.value.questions[0].tier;
        expect(RANK[stored]).toBeLessThanOrEqual(RANK[ceiling]);
        expect(stored).toBe(RANK[claimed] > RANK[ceiling] ? ceiling : claimed);
      }
    }
  });

  it("never promotes a question written for a lower tier", () => {
    // Observed in a real run: a predict_break question names the identifiers it
    // asks about. Promoting it to reconstruct hides the code those names refer
    // to, leaving a question about something the user cannot see.
    const q = question({ tier: "predict_break", scaffold: ["a", "b"] });
    const result = validateGenerationResult(
      JSON.parse(payload({}, [q])),
      input({ debouncing: "predict_break" }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.questions[0].tier).toBe("predict_break");
      expect(result.warnings.join(" ")).toMatch(/below the "reconstruct"/);
    }
  });

  it("clamps a reconstruct question down when the concept is brand new", () => {
    // The failure this prevents: code hidden (§10.1) for a concept never seen.
    const q = question({ tier: "reconstruct", scaffold: ["a", "b"] });
    const result = validateGenerationResult(
      JSON.parse(payload({}, [q])),
      input({ debouncing: "none" }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.questions[0].tier).toBe("trace");
      expect(result.warnings.join(" ")).toMatch(/clamped down to "trace"/);
    }
  });

  it("treats an unknown tag as mastery none", () => {
    const q = question({
      concept_tag: "brand-new-idea",
      tier: "reconstruct",
      scaffold: ["a", "b"],
    });
    const result = validateGenerationResult(
      JSON.parse(payload({}, [q])),
      input({ debouncing: "reconstruct" }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.questions[0].tier).toBe("trace");
  });

  it("warns, rather than failing, when the clamp leaves a trace question scaffold-less", () => {
    const q = question({ tier: "predict_break", scaffold: [] });
    const result = validateGenerationResult(
      JSON.parse(payload({}, [q])),
      input({ debouncing: "none" }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.warnings.join(" ")).toMatch(/nothing to break down/);
  });
});

describe("file attribution (§13.3, §16.4)", () => {
  it("drops a hallucinated path and keeps the real ones", () => {
    const q = question({ files: [FILES[0], "src/does/not/exist.ts"] });
    const result = validateGenerationResult(JSON.parse(payload({}, [q])), input());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.questions[0].files).toEqual([FILES[0]]);
      expect(result.warnings.join(" ")).toMatch(/not in the batch — dropped/);
    }
  });

  it("promotes an all-hallucinated list to a violation", () => {
    const q = question({ files: ["nope.ts", "also-nope.ts"] });
    const result = validateGenerationResult(JSON.parse(payload({}, [q])), input());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations.join(" ")).toMatch(/named no file from this batch/);
  });

  it("stores the batch's spelling, not the model's echo", () => {
    const q = question({ files: ["./" + FILES[0]] });
    const result = validateGenerationResult(JSON.parse(payload({}, [q])), input());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.questions[0].files).toEqual([FILES[0]]);
  });

  it("honors platform case rules", () => {
    expect(pathsEqual("src/Auth.ts", "src/auth.ts", true)).toBe(true);
    expect(pathsEqual("src/Auth.ts", "src/auth.ts", false)).toBe(false);
    expect(pathsEqual("src\\auth\\mw.ts", "src/auth/mw.ts", false)).toBe(true);
  });
});

describe("softer rules stay warnings", () => {
  it("keeps a teaching card generated above mastery none", () => {
    const q = question({ teaching_card: { body: "Debouncing delays an action.", deeper: null } });
    const result = validateGenerationResult(
      JSON.parse(payload({}, [q])),
      input({ debouncing: "trace" }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.questions[0].teaching_card).not.toBeNull();
      expect(result.warnings.join(" ")).toMatch(/null unless none/);
    }
  });

  it("notes a missing card at mastery none, and an odd scaffold length", () => {
    const q = question({ scaffold: ["a", "b", "c", "d", "e"] });
    const result = validateGenerationResult(
      JSON.parse(payload({}, [q])),
      input({ debouncing: "none" }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings.join(" ")).toMatch(/no teaching card/);
      expect(result.warnings.join(" ")).toMatch(/asks for 2-4/);
    }
  });
});

describe("prompt assembly (§9.3)", () => {
  it("caps known tags at 60, most-recent-first", () => {
    const tags = Array.from({ length: 90 }, (_, i) => `tag-${i}`);
    const message = buildUserMessage(input({}, { knownTags: tags }));
    expect(message).toContain("tag-0");
    expect(message).toContain(`tag-${MAX_KNOWN_TAGS - 1}`);
    expect(message).not.toContain(`tag-${MAX_KNOWN_TAGS}`);
  });

  it("labels the mode and carries mastery, files, and the diff", () => {
    const message = buildUserMessage(input({ debouncing: "trace" }));
    expect(message).toMatch(/MODE: live/);
    expect(message).toContain("debouncing: trace");
    expect(message).toContain(FILES[0]);
    expect(message).toContain("setTimeout");
  });

  it("frames scan mode as existing code, not a change", () => {
    const message = buildUserMessage({
      kind: "scan",
      files: [FILES[0]],
      masteryContext: {},
      knownTags: [],
      section: "export const x = 1;",
      sectionLabel: "section 2 of 4",
    });
    expect(message).toMatch(/MODE: scan/);
    expect(message).toContain("section 2 of 4");
    expect(message).toMatch(/nothing tracked yet/);
  });
});

describe("generateQuestions transport (§9.6)", () => {
  it("returns the parsed result on the first attempt", async () => {
    const provider = fakeProvider([payload()]);
    const outcome = await generateQuestions(input({ debouncing: "none" }), {
      provider,
      ...noSleep,
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.attempts).toBe(1);
      expect(outcome.result.questions).toHaveLength(1);
    }
    expect(provider.opts[0].maxTokens).toBe(MAX_TOKENS);
  });

  it("repairs malformed output exactly once, showing the model its own output", async () => {
    const provider = fakeProvider(["not json at all", payload()]);
    const outcome = await generateQuestions(input(), { provider, ...noSleep });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.attempts).toBe(2);
    expect(provider.prompts).toHaveLength(2);
    expect(provider.prompts[1]).toContain("not json at all");
    expect(provider.prompts[1]).toMatch(/ONLY the corrected JSON/);
  });

  it("fails after the second malformed attempt, keeping the re-runnable payload", async () => {
    const provider = fakeProvider(["nope", "still nope"]);
    const original = input({ debouncing: "trace" });
    const outcome = await generateQuestions(original, { provider, ...noSleep });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("malformed_output");
      expect(outcome.attempts).toBe(2);
      // §19.1: everything needed to re-run without re-deriving it.
      expect(outcome.payload).toEqual(original);
      expect(outcome.violations).toContain("response was not valid JSON");
    }
  });

  it("backs off 1s/4s/10s on retryable errors, then succeeds", async () => {
    const slept: number[] = [];
    const provider = throwingProvider(
      [new ProviderError("api_error", true, "429"), new ProviderError("api_error", true, "500")],
      payload(),
    );
    const outcome = await generateQuestions(input(), {
      provider,
      sleep: async (ms) => void slept.push(ms),
      random: () => 0,
    });
    expect(outcome.ok).toBe(true);
    expect(slept).toEqual([API_RETRY_DELAYS_MS[0], API_RETRY_DELAYS_MS[1]]);
    expect(provider.calls).toBe(3);
  });

  it("gives up after three retries", async () => {
    const provider = throwingProvider(
      Array.from({ length: 9 }, () => new ProviderError("api_error", true, "503")),
    );
    const slept: number[] = [];
    const outcome = await generateQuestions(input(), {
      provider,
      sleep: async (ms) => void slept.push(ms),
      random: () => 0,
    });
    expect(outcome.ok).toBe(false);
    expect(slept).toHaveLength(API_RETRY_DELAYS_MS.length);
    expect(provider.calls).toBe(API_RETRY_DELAYS_MS.length + 1);
  });

  it("never retries an auth failure, and never leaks the key", async () => {
    const provider = throwingProvider([
      new ProviderError(
        "auth_error",
        false,
        "authentication failed (HTTP 401) — check your API key: sk-ant-***",
      ),
    ]);
    const outcome = await generateQuestions(input(), { provider, ...noSleep });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("auth_error");
      expect(outcome.error).toMatch(/check your API key/);
      expect(outcome.error).not.toMatch(/sk-ant-api/);
    }
    expect(provider.calls).toBe(1);
  });

  it("reports a resolution failure without ever calling a model", async () => {
    const outcome = await generateQuestions(input(), {
      providerSetting: "api",
      apiKey: null,
      runCli: async () => ({ stdout: "", stderr: "", code: 1, timedOut: false }),
      ...noSleep,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("auth_error");
      expect(outcome.attempts).toBe(0);
    }
  });

  it("wraps a non-ProviderError throw instead of letting it escape", async () => {
    const provider: ModelProvider = {
      name: "api",
      askModel: async () => {
        throw new TypeError("something in the transport blew up");
      },
    };
    const outcome = await generateQuestions(input(), { provider, ...noSleep });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("api_error");
      expect(outcome.error).toMatch(/blew up/);
    }
  });

  it("warns when skip_reason is set alongside skip:false", async () => {
    const provider = fakeProvider([payload({ skip_reason: "contradictory" })]);
    const outcome = await generateQuestions(input({ debouncing: "none" }), {
      provider,
      ...noSleep,
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.warnings.join(" ")).toMatch(/skip_reason/);
  });

  it("skip:true is a success, not a failure — the checkpoint may advance (§8.3)", async () => {
    const provider = fakeProvider([
      JSON.stringify({ skip: true, skip_reason: "dependency bump only" }),
    ]);
    const outcome = await generateQuestions(input(), { provider, ...noSleep });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.skip).toBe(true);
      expect(outcome.result.questions).toHaveLength(0);
    }
  });
});

describe("synthesis (§9.5)", () => {
  const bundle = {
    kind: "synthesis" as const,
    tag: "auth-flow",
    files: FILES,
    bundle: [
      { files: [FILES[0]], code: "a", question: "asked before" },
      { files: [FILES[1]], code: "b" },
    ],
  };

  it("accepts exactly the three-field contract", () => {
    const ok = validateSynthesisResult({ question: "q", sample_answer: "a", hint: "h" });
    expect(ok.ok).toBe(true);
    expect(validateSynthesisResult({ question: "q", sample_answer: "a" }).ok).toBe(false);
    expect(validateSynthesisResult("nope").ok).toBe(false);
  });

  it("round-trips through the provider", async () => {
    const provider = fakeProvider([
      JSON.stringify({ question: "q", sample_answer: "a", hint: "h" }),
    ]);
    const outcome = await generateSynthesisQuestion(bundle, { provider, ...noSleep });
    expect(outcome.ok).toBe(true);
    expect(provider.prompts[0]).toContain("auth-flow");
    expect(provider.prompts[0]).toContain("asked before");
  });
});

describe("reconstruct leak check (§9.2, §9.6)", () => {
  // A slice of the shape that broke the prompt-only rule: a third-party parser.
  const PARSER_CODE = [
    "class BinOpNode(Node):",
    "    def __init__(self, op, left, right):",
    "        self.op = op",
    "",
    "class Parser:",
    "    def parse_expr(self) -> Node:",
    "        node = self.parse_term()",
    "        while self.peek().type in (PLUS, MINUS):",
    "            value = self.advance()",
    "            node = BinOpNode(value, node, self.parse_term())",
    "        return node",
    "",
    "    def parse_power(self) -> Node:",
    "        base = self.parse_unary()",
    "        return base",
  ].join("\n");

  const scanInput = (mastery: Record<string, Tier>): GenerationInput => ({
    kind: "scan",
    files: ["main.py"],
    masteryContext: mastery,
    knownTags: [],
    section: PARSER_CODE,
  });

  function reconstructQuestion(over: Record<string, unknown> = {}): Record<string, unknown> {
    return question({
      concept_tag: "recursive-descent-parsing",
      tier: "reconstruct",
      files: ["main.py"],
      teaching_card: null,
      question:
        "You need to evaluate arithmetic expressions with correct operator precedence. Before looking: how would you structure the parsing?",
      hint: "Think about what has to happen before you can decide precedence.",
      sample_answer:
        "One function per precedence level; parse_expr delegates to parse_term, which builds a BinOpNode.",
      scaffold: ["Which operators bind tightest?", "How does a level hand off to the next?"],
      ...over,
    });
  }

  describe("identifier extraction", () => {
    it("finds declared functions, methods, and classes across languages", () => {
      const found = extractDeclaredIdentifiers(PARSER_CODE);
      expect(found).toContain("parse_expr");
      expect(found).toContain("parse_power");
      expect(found).toContain("BinOpNode");
      expect(found).toContain("Parser");
    });

    it("ignores generic locals, which would false-positive on prose", () => {
      const found = extractDeclaredIdentifiers(PARSER_CODE);
      expect(found).not.toContain("value");
      expect(found).not.toContain("node");
      expect(found).not.toContain("base");
      expect(found).not.toContain("op");
    });

    it.each([
      ["parse_expr", true],
      ["BinOpNode", true],
      ["pathsEqual", true],
      ["Parser", true],
      ["run", false],
      ["get", false],
      ["data", false],
      ["if", false],
      // Observed false positive: a clean question saying "should evaluate as"
      // was flagged because the file declared `def evaluate`, costing a repair
      // retry and a tier downgrade. A lone lowercase word reads as prose.
      ["evaluate", false],
      ["tokenize", false],
    ])("treats %s as distinctive=%s", (name, expected) => {
      expect(isDistinctiveIdentifier(name)).toBe(expected);
    });

    it("does not flag an English word that happens to be a function name", () => {
      const code = "def evaluate(node):\n    return node\n";
      const declared = extractDeclaredIdentifiers(code);
      expect(findLeakedIdentifiers("`2 ^ 3 ^ 2` should evaluate as 512", declared)).toEqual([]);
    });

    it("reads declarations out of a diff's added lines", () => {
      const diff =
        "--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,4 @@\n context\n+export function parseHeaders(raw: string) {\n+  return raw;\n+}\n";
      expect(extractDeclaredIdentifiers(diff)).toContain("parseHeaders");
    });

    it("handles JS/TS declaration forms", () => {
      const code = [
        "export class TokenStream {}",
        "const buildIndex = (rows) => rows;",
        "interface ParserOptions {}",
        "function normalizePath(p) { return p; }",
      ].join("\n");
      const found = extractDeclaredIdentifiers(code);
      expect(found).toEqual(
        expect.arrayContaining(["TokenStream", "buildIndex", "ParserOptions", "normalizePath"]),
      );
    });
  });

  describe("matching", () => {
    it("matches whole identifiers only, case-sensitively", () => {
      const ids = ["parse_expr", "BinOpNode"];
      expect(findLeakedIdentifiers("call parse_expr first", ids)).toEqual(["parse_expr"]);
      // A longer identifier that merely starts with it is a different symbol.
      expect(findLeakedIdentifiers("see parse_expr_list", ids)).toEqual([]);
      expect(findLeakedIdentifiers("each binopnode in the tree", ids)).toEqual([]);
      expect(findLeakedIdentifiers("nothing to see", ids)).toEqual([]);
    });
  });

  describe("enforcement", () => {
    it("rejects a hint that names hidden code", () => {
      const q = reconstructQuestion({ hint: "Look at what parse_expr does with the operator." });
      const result = validateGenerationResult(
        JSON.parse(payload({}, [q])),
        scanInput({ "recursive-descent-parsing": "predict_break" }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.violations.join(" ")).toMatch(/hint: parse_expr/);
    });

    it("rejects a scaffold entry that names hidden code", () => {
      const q = reconstructQuestion({
        scaffold: [
          "Which operators bind tightest?",
          "What does parse_power return for a BinOpNode?",
        ],
      });
      const result = validateGenerationResult(
        JSON.parse(payload({}, [q])),
        scanInput({ "recursive-descent-parsing": "predict_break" }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.violations.join(" ")).toMatch(/scaffold\[1\]: parse_power/);
        expect(result.violations.join(" ")).toMatch(/BinOpNode/);
      }
    });

    it("exempts sample_answer, which is shown after the code is revealed", () => {
      // The fixture's sample_answer already names parse_expr and BinOpNode.
      const result = validateGenerationResult(
        JSON.parse(payload({}, [reconstructQuestion()])),
        scanInput({ "recursive-descent-parsing": "predict_break" }),
      );
      expect(result.ok).toBe(true);
    });

    it("does not check tiers where the code stays visible", () => {
      const q = reconstructQuestion({ hint: "Look at what parse_expr does." });
      const result = validateGenerationResult(
        JSON.parse(payload({}, [q])),
        // mastery trace ⇒ ceiling predict_break ⇒ code visible ⇒ names are fine
        scanInput({ "recursive-descent-parsing": "trace" }),
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.questions[0].tier).toBe("predict_break");
    });

    it("downgrades instead of discarding when the repair retry still leaks", () => {
      const q = reconstructQuestion({ hint: "Look at what parse_expr does." });
      const result = validateGenerationResult(
        JSON.parse(payload({}, [q])),
        scanInput({ "recursive-descent-parsing": "predict_break" }),
        { finalAttempt: true },
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.questions[0].tier).toBe("predict_break");
        expect(result.warnings.join(" ")).toMatch(/downgraded to predict_break/);
      }
    });

    it("repairs once, then keeps the question at a lower tier end to end", async () => {
      const leaky = payload({}, [reconstructQuestion({ hint: "Trace parse_expr from the top." })]);
      const provider = fakeProvider([leaky, leaky]);
      const outcome = await generateQuestions(
        scanInput({ "recursive-descent-parsing": "predict_break" }),
        { provider, ...noSleep },
      );
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.attempts).toBe(2); // one repair retry was spent
        expect(outcome.result.questions[0].tier).toBe("predict_break");
        // §9.7: a two-attempt success must say what the first attempt got wrong.
        expect(outcome.repairedViolations.join(" ")).toMatch(/names hidden code/);
      }
      expect(provider.prompts[1]).toMatch(/names hidden code/);
    });

    it("requires a scaffold at reconstruct — [b] must have something to show", () => {
      // §10.4: the scaffold is the deepest rung of the stuck flow, and
      // reconstruct is where a stuck user has nothing else — the code is hidden.
      const q = reconstructQuestion({ scaffold: [] });
      const result = validateGenerationResult(
        JSON.parse(payload({}, [q])),
        scanInput({ "recursive-descent-parsing": "predict_break" }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.violations.join(" ")).toMatch(/reconstruct tier requires 2-4/);
    });

    it("still allows predict_break without a scaffold", () => {
      const q = reconstructQuestion({ tier: "predict_break", scaffold: [] });
      const result = validateGenerationResult(
        JSON.parse(payload({}, [q])),
        scanInput({ "recursive-descent-parsing": "trace" }),
      );
      expect(result.ok).toBe(true);
    });

    it("keeps a clean reconstruct question at reconstruct", async () => {
      const provider = fakeProvider([payload({}, [reconstructQuestion()])]);
      const outcome = await generateQuestions(
        scanInput({ "recursive-descent-parsing": "predict_break" }),
        { provider, ...noSleep },
      );
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.attempts).toBe(1);
        expect(outcome.result.questions[0].tier).toBe("reconstruct");
        expect(outcome.repairedViolations).toEqual([]);
      }
    });
  });
});

describe("fenced output is tolerated, not fought (§9.4)", () => {
  it("no longer tells the model to avoid fences", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).not.toMatch(/no markdown fences/i);
    expect(prompt).toMatch(/fence around the object is fine/i);
  });

  it("accepts a fenced payload with no repair retry", async () => {
    const provider = fakeProvider(["```json\n" + payload() + "\n```"]);
    const outcome = await generateQuestions(input({ debouncing: "none" }), {
      provider,
      ...noSleep,
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.attempts).toBe(1);
  });
});
