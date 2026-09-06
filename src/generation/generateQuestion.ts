/**
 * Generation: prompt assembly, transport retry, structured-output parsing and
 * validation.  GOVERNED BY: §9
 *
 * ONE call per batch (§9.1). There is no "is this worth asking?" pre-check call —
 * that judgment lives in the same prompt (§9.2 step 1). The transport itself
 * lives in provider.ts; this file never knows whether the Claude Code CLI or the
 * Anthropic SDK answered.
 *
 * DECISION: this module never touches the database. §9.6 says a hard failure
 * "records a generation_failures row"; storage does not exist yet (build order
 * §23 puts it at stage 2) and generation must stay importable with no side
 * effects, so a failure is RETURNED — carrying the §19.1 payload verbatim — and
 * the caller persists it. Same reason there is no logger dependency: the failure
 * carries a user-safe `error` string (API key redacted, no file contents) and
 * the daemon logs it.
 *
 * DECISION: three classes of problem, deliberately handled differently.
 *   violations — the §9.4 contract is broken (bad shape, unknown tier, >3
 *     questions, missing required field). Rejected, never coerced: one repair
 *     retry, then a failure. The caller must NOT advance the checkpoint (§8.3).
 *   clamps     — a field the model does not get the final say on. Tier is a pure
 *     function of the mastery Grasp supplied, so it is recomputed locally, and
 *     hallucinated file paths are dropped. Both are corrected, then reported.
 *   warnings   — well-formed output that breaks a softer prompt rule (a teaching
 *     card where mastery is not none). Extra content, not wrong content: kept.
 */
import { DEFAULT_CONFIG } from "../config/defaults.js";
import { pathsEqual } from "../util/paths.js";
import {
  MAX_QUESTIONS,
  buildRepairInstruction,
  buildSystemPrompt,
  buildUserMessage,
  tierForMastery,
} from "./prompts/systemPrompt.js";
import {
  buildSynthesisSystemPrompt,
  buildSynthesisUserMessage,
} from "./prompts/synthesisPrompt.js";
import {
  ProviderError,
  redact,
  resolveProvider,
  type AskResult,
  type CliRunner,
  type ModelProvider,
  type ProviderSetting,
} from "./provider.js";
import type {
  GeneratedQuestion,
  GenerationInput,
  GenerationOutcome,
  GenerationResult,
  SynthesisGenerationInput,
  SynthesisResult,
  Tier,
  ValidationOutcome,
} from "../types/index.js";

/** §9.1 */
export const MAX_TOKENS = 4096;

/** §9.6 — 429/5xx backoff, before jitter. Three retries after the first attempt. */
export const API_RETRY_DELAYS_MS = [1000, 4000, 10000] as const;

/** §9.6 — malformed output gets exactly one repair attempt. */
export const MAX_GENERATION_ATTEMPTS = 2;

const TAG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const VALID_TIERS = new Set<string>(["trace", "predict_break", "reconstruct"]);

/** Ordering for the §9.2-step-4 ceiling. Higher means more is withheld. */
const TIER_RANK: Record<Exclude<Tier, "none">, number> = {
  trace: 0,
  predict_break: 1,
  reconstruct: 2,
};

export interface GenerationDeps {
  /** Injected by tests and the dev harness; otherwise resolved per §6.3. */
  provider?: ModelProvider;
  /** config.provider — "auto" | "claude-cli" | "api". */
  providerSetting?: ProviderSetting;
  /** config.apiKey; falls back to ANTHROPIC_API_KEY inside resolution. */
  apiKey?: string | null;
  model?: string;
  runCli?: CliRunner;
  sleep?: (ms: number) => Promise<void>;
  /** Injected for deterministic jitter in tests. */
  random?: () => number;
}

/* ------------------------------------------------------------------ *
 * Parsing (§9.4)
 * ------------------------------------------------------------------ */

/**
 * The prompt forbids markdown fences; models emit them anyway often enough that
 * failing here would burn a retry on nothing.
 */
export function stripFences(raw: string): string {
  const trimmed = raw.trim();
  const fenced = /^```(?:json|jsonc)?\s*\n([\s\S]*?)\n?```$/i.exec(trimmed);
  return fenced ? fenced[1].trim() : trimmed;
}

export function parseModelJson(
  raw: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const candidate = stripFences(raw);
  if (candidate.length === 0) return { ok: false, error: "model returned an empty response" };

  try {
    return { ok: true, value: JSON.parse(candidate) as unknown };
  } catch {
    // Last defensive pass: prose wrapped around a single JSON object.
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return { ok: true, value: JSON.parse(candidate.slice(start, end + 1)) as unknown };
      } catch {
        /* fall through to the shared failure below */
      }
    }
    return { ok: false, error: "response was not valid JSON" };
  }
}

/* ------------------------------------------------------------------ *
 * Validation (§9.4, §9.6)
 * ------------------------------------------------------------------ */

/**
 * Reconstruct-tier leak detection (§9.2, §10.1).
 *
 * At `reconstruct` the review UI withholds `code_snippet` (§14.4), so the
 * question, hint, and scaffold are all read with the code hidden. An identifier
 * from that hidden code is therefore both a leak of the design and a reference
 * to something the user cannot see. Prompt wording alone did not hold this:
 * observed on a third-party parser, a clean question shipped with a hint naming
 * `parse_expr` and a scaffold naming `parse_power` and `BinOpNode`.
 *
 * `sample_answer` is exempt — it appears only after the code is revealed.
 *
 * DECISION: declared function, method, and class names only, never every local.
 * Locals are dominated by generic names (`value`, `result`, `data`) that appear
 * in ordinary prose, and a check that fires on those would turn every reconstruct
 * question into a repair retry.
 */
const DIFF_MARKERS = /^(?:diff |index |--- |\+\+\+ |@@ )/;

/** Declaration forms, across the languages a captured file is likely to be. */
const DECLARATION_PATTERNS: readonly RegExp[] = [
  /\bfunction\s+([A-Za-z_$][\w$]*)/g, // JS/TS/PHP
  /\b(?:async\s+)?def\s+([A-Za-z_]\w*)/g, // Python
  /\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/g, // Go, including receivers
  /\bfn\s+([A-Za-z_]\w*)/g, // Rust
  /\b(?:class|interface|struct|enum|trait|type|record)\s+([A-Za-z_$][\w$]*)/g,
  // `const foo = () => {}` / `const foo = function () {}`
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+?)?=>|[A-Za-z_$][\w$]*\s*=>)/g,
  // Method shorthand: `  parseExpr(tokens) {` / `  parse(self) ->`
  /^[\t ]*(?:(?:public|private|protected|static|readonly|async|override|export)\s+)*([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*[:{]/gm,
];

/** Control-flow and declaration keywords the shorthand pattern would otherwise catch. */
const NOT_IDENTIFIERS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "function",
  "constructor",
  "super",
  "new",
  "typeof",
  "await",
  "yield",
  "else",
  "try",
  "finally",
  "import",
  "export",
  "class",
  "struct",
  "enum",
  "interface",
  "type",
  "def",
  "fn",
  "func",
  "with",
  "lambda",
  "assert",
  "raise",
  "print",
  "match",
  "elif",
  "except",
  "and",
  "or",
  "not",
  "in",
  "is",
  "do",
  "using",
  "namespace",
]);

/**
 * Distinctive enough to be worth matching: the name has to LOOK like code rather
 * than like prose — snake_case, camelCase, or PascalCase.
 *
 * DECISION: length is deliberately not a signal. A first cut also accepted any
 * name of 8+ characters, and a real run immediately paid for it: a clean
 * reconstruct question about a parser was flagged for the word "evaluate" — the
 * English verb, in "`2 ^ 3 ^ 2` should evaluate as ..." — because the file
 * happened to declare `def evaluate`. That cost a repair retry and then a tier
 * downgrade on a question that had leaked nothing.
 *
 * A single all-lowercase word is indistinguishable from prose, so it is not
 * matched. The cost is a missed leak when a helper is named `tokenize` and the
 * text says `tokenize`; that is the weakest kind of leak, the prompt still argues
 * against it, and it is far cheaper than downgrading good questions.
 */
export function isDistinctiveIdentifier(name: string): boolean {
  if (name.length < 4 || NOT_IDENTIFIERS.has(name)) return false;
  return name.includes("_") || /[a-z][A-Z]/.test(name) || /^[A-Z]/.test(name);
}

/** Strip diff framing so declarations on added lines are still seen. */
function undiff(code: string): string {
  if (!/^(?:@@ |--- |\+\+\+ )/m.test(code)) return code;
  return code
    .split("\n")
    .filter((line) => !DIFF_MARKERS.test(line))
    .map((line) => (/^[+\-]/.test(line) ? line.slice(1) : line))
    .join("\n");
}

export function extractDeclaredIdentifiers(code: string): string[] {
  const source = undiff(code);
  const found = new Set<string>();
  for (const pattern of DECLARATION_PATTERNS) {
    // Patterns are module-level and stateful (/g); reset before each use.
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const name = match[1];
      if (name && isDistinctiveIdentifier(name)) found.add(name);
    }
  }
  return [...found];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Case-sensitive, whole-identifier matches only: `parse_expr` must not fire on
 * `parse_expr_list`, and `Node` must not fire on the word "node".
 */
export function findLeakedIdentifiers(text: string, identifiers: readonly string[]): string[] {
  return identifiers.filter((name) =>
    new RegExp(`(?<![A-Za-z0-9_$])${escapeRegExp(name)}(?![A-Za-z0-9_$])`).test(text),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function effectiveMastery(input: GenerationInput, tag: string): Tier {
  return input.masteryContext[tag] ?? "none";
}

function validateQuestion(
  raw: unknown,
  index: number,
  input: GenerationInput,
  violations: string[],
  warnings: string[],
  context: { declaredIdentifiers: string[]; finalAttempt: boolean },
): GeneratedQuestion | null {
  const where = `questions[${index}]`;
  if (!isRecord(raw)) {
    violations.push(`${where} is not an object`);
    return null;
  }

  const before = violations.length;

  if (!isNonEmptyString(raw.concept_tag)) {
    violations.push(`${where}.concept_tag is missing or empty`);
  } else if (!TAG_PATTERN.test(raw.concept_tag)) {
    // DECISION: a violation, not a normalized value. The tag is the mastery unit
    // AND the synthesis clustering key (§11.5) — silently rewriting "Auth Flow"
    // to "auth-flow" is exactly the near-duplicate drift §9.2 step 2 exists to
    // prevent, and §9.6 says reject rather than coerce.
    violations.push(
      `${where}.concept_tag "${raw.concept_tag}" is not lowercase-hyphenated (^[a-z0-9]+(-[a-z0-9]+)*$)`,
    );
  }

  if (!isNonEmptyString(raw.tier)) {
    violations.push(`${where}.tier is missing`);
  } else if (!VALID_TIERS.has(raw.tier)) {
    violations.push(`${where}.tier "${raw.tier}" is not one of trace|predict_break|reconstruct`);
  }

  for (const field of ["question", "sample_answer", "hint"] as const) {
    if (!isNonEmptyString(raw[field])) violations.push(`${where}.${field} is missing or empty`);
  }

  // DECISION: an ABSENT optional field takes its documented default (reframe
  // false, teaching_card null, scaffold []); a PRESENT field of the wrong type
  // is a violation. Defaulting an omitted field is reading the contract, not
  // guessing at the model's intent.
  let reframe = false;
  if (raw.reframe !== undefined && raw.reframe !== null) {
    if (typeof raw.reframe !== "boolean") violations.push(`${where}.reframe is not a boolean`);
    else reframe = raw.reframe;
  }

  // Hallucinated paths are dropped, not stored: question_files is what scopes the
  // hard gate (§13.3), so a wrong path blocks the wrong commit.
  const files: string[] = [];
  if (!Array.isArray(raw.files) || raw.files.length === 0) {
    violations.push(`${where}.files is missing or empty`);
  } else {
    for (const candidate of raw.files) {
      if (typeof candidate !== "string") {
        violations.push(`${where}.files contains a non-string entry`);
        continue;
      }
      // Store the batch's own spelling, never the model's echo of it (§16.4).
      const match = input.files.find((f) => pathsEqual(f, candidate));
      if (match) files.push(match);
      else
        warnings.push(`${where}.files listed "${candidate}", which was not in the batch — dropped`);
    }
    if (files.length === 0 && violations.length === before) {
      violations.push(`${where}.files named no file from this batch`);
    }
  }

  let teachingCard: GeneratedQuestion["teaching_card"] = null;
  if (raw.teaching_card !== undefined && raw.teaching_card !== null) {
    if (!isRecord(raw.teaching_card) || !isNonEmptyString(raw.teaching_card.body)) {
      violations.push(`${where}.teaching_card is present but has no body`);
    } else {
      const deeper = raw.teaching_card.deeper;
      if (deeper !== undefined && deeper !== null && typeof deeper !== "string") {
        violations.push(`${where}.teaching_card.deeper is not a string or null`);
      } else {
        teachingCard = {
          body: raw.teaching_card.body,
          deeper: isNonEmptyString(deeper) ? deeper : null,
        };
      }
    }
  }

  const scaffold: string[] = [];
  if (raw.scaffold !== undefined && raw.scaffold !== null) {
    if (!Array.isArray(raw.scaffold)) {
      violations.push(`${where}.scaffold is not an array`);
    } else {
      for (const step of raw.scaffold) {
        if (!isNonEmptyString(step)) violations.push(`${where}.scaffold contains an empty entry`);
        else scaffold.push(step);
      }
    }
  }

  if (violations.length !== before) return null;

  const tag = raw.concept_tag as string;
  const declaredTier = raw.tier as Exclude<Tier, "none">;
  const mastery = effectiveMastery(input, tag);

  // §9.2 step 4 is a pure function of the mastery Grasp supplied, so the mastery
  // map is a CEILING Grasp enforces — never a promotion.
  //
  // Clamping down is safe: a question written for a higher tier still works with
  // the code visible, and it prevents the real harm — a `reconstruct` on a
  // concept at mastery `none` hides the code (§10.1) from someone who has never
  // met the idea, the same capstone-on-unfamiliar-material failure §11.6's
  // mastery condition prevents elsewhere.
  //
  // Clamping UP is not safe, which observation confirmed: a question written as
  // predict_break names the very identifiers it asks about, and promoting it to
  // reconstruct hides the code those names refer to, leaving a question about
  // something the user cannot see. Keep the model's lower tier and say so.
  const ceiling = tierForMastery(mastery);
  let tier = TIER_RANK[declaredTier] > TIER_RANK[ceiling] ? ceiling : declaredTier;
  if (declaredTier !== tier) {
    warnings.push(
      `${where} came back as tier "${declaredTier}" for "${tag}", whose effective mastery is "${mastery}" — clamped down to "${tier}" (§9.2 step 4)`,
    );
  } else if (declaredTier !== ceiling) {
    warnings.push(
      `${where} came back as tier "${declaredTier}" for "${tag}", below the "${ceiling}" its mastery allows — kept, because the question text was written for the lower tier`,
    );
  }

  // The code is hidden at reconstruct, so anything shown alongside the question
  // must not name it. Enforced here rather than trusted to the prompt: it is a
  // correctness property, and the prompt did not hold it (§9.6).
  if (tier === "reconstruct") {
    const shownWithCodeHidden: [string, string][] = [
      ["question", raw.question as string],
      ["hint", raw.hint as string],
      ...scaffold.map((step, i): [string, string] => [`scaffold[${i}]`, step]),
    ];
    const leaks = shownWithCodeHidden.flatMap(([field, text]) =>
      findLeakedIdentifiers(text, context.declaredIdentifiers).map((name) => `${field}: ${name}`),
    );
    if (leaks.length > 0) {
      if (!context.finalAttempt) {
        violations.push(
          `${where} is tier reconstruct but names hidden code in ${leaks.join(", ")} — the user cannot see these while answering`,
        );
        return null;
      }
      // The repair retry did not land. Downgrading beats discarding: at
      // predict_break the code is visible, so the identifiers are legitimate and
      // the question is valid rather than wasted.
      tier = "predict_break";
      warnings.push(
        `${where} still named hidden code after a repair retry (${leaks.join(", ")}) — downgraded to predict_break, where the code is visible`,
      );
    }
  }

  // §9.2 step 9 / §10.4: the scaffold IS the deepest rung of the stuck flow, so
  // the two tiers that most need it must have it. At reconstruct it is checked
  // against the CLAMPED tier: the code is hidden there, which is exactly when a
  // stuck user has nothing else left.
  if ((declaredTier === "trace" || tier === "reconstruct") && scaffold.length < 2) {
    violations.push(
      `${where}.scaffold has ${scaffold.length} steps; ${declaredTier === "trace" ? "trace" : "reconstruct"} tier requires 2-4`,
    );
    return null;
  }
  if (tier === "trace" && scaffold.length < 2) {
    // Caused by the clamp rather than by the model ignoring the contract.
    warnings.push(
      `${where} clamped to trace but carries ${scaffold.length} scaffold steps; the stuck flow will have nothing to break down`,
    );
  } else if (scaffold.length === 1 || scaffold.length > 4) {
    warnings.push(`${where}.scaffold has ${scaffold.length} steps; the contract asks for 2-4`);
  }

  if (teachingCard && mastery !== "none") {
    warnings.push(
      `${where} carries a teaching card, but mastery for "${tag}" is "${mastery}" (§9.4: null unless none)`,
    );
  }
  if (!teachingCard && mastery === "none") {
    warnings.push(
      `${where} has no teaching card, but mastery for "${tag}" is "none" (§9.2 step 5)`,
    );
  }
  if (reframe && mastery !== "none") {
    warnings.push(`${where} sets reframe, which only applies when mastery is "none" (§9.2 step 3)`);
  }

  return {
    concept_tag: tag,
    reframe,
    tier,
    files,
    teaching_card: teachingCard,
    question: raw.question as string,
    sample_answer: raw.sample_answer as string,
    hint: raw.hint as string,
    scaffold,
  };
}

/** The code the model was shown — the source of truth for the leak check. */
function snippetOf(input: GenerationInput): string {
  return input.kind === "live" ? input.diff : input.section;
}

export function validateGenerationResult(
  value: unknown,
  input: GenerationInput,
  options: { finalAttempt?: boolean } = {},
): ValidationOutcome<GenerationResult> {
  const violations: string[] = [];
  const warnings: string[] = [];

  if (!isRecord(value)) return { ok: false, violations: ["response is not a JSON object"] };
  if (typeof value.skip !== "boolean") {
    return { ok: false, violations: ['"skip" is missing or not a boolean'] };
  }

  const rawQuestions = value.questions;

  if (value.skip) {
    if (!isNonEmptyString(value.skip_reason)) {
      violations.push('"skip" is true but "skip_reason" is missing');
    }
    if (Array.isArray(rawQuestions) && rawQuestions.length > 0) {
      violations.push('"skip" is true but questions were returned');
    }
    if (violations.length > 0) return { ok: false, violations };
    return {
      ok: true,
      value: { skip: true, skip_reason: value.skip_reason as string, questions: [] },
      warnings,
    };
  }

  if (!Array.isArray(rawQuestions)) {
    return { ok: false, violations: ['"skip" is false but "questions" is not an array'] };
  }
  if (rawQuestions.length === 0) {
    return { ok: false, violations: ['"skip" is false but no questions were returned'] };
  }
  if (rawQuestions.length > MAX_QUESTIONS) {
    return {
      ok: false,
      violations: [
        `${rawQuestions.length} questions returned; the contract allows at most ${MAX_QUESTIONS}`,
      ],
    };
  }
  if (value.skip_reason !== undefined && value.skip_reason !== null) {
    warnings.push('"skip_reason" was set even though "skip" is false');
  }

  const questions: GeneratedQuestion[] = [];
  // Extracted once per response, not per question.
  const context = {
    declaredIdentifiers: extractDeclaredIdentifiers(snippetOf(input)),
    finalAttempt: options.finalAttempt ?? false,
  };
  rawQuestions.forEach((raw, i) => {
    const question = validateQuestion(raw, i, input, violations, warnings, context);
    if (question) questions.push(question);
  });

  if (violations.length > 0) return { ok: false, violations };
  return { ok: true, value: { skip: false, skip_reason: null, questions }, warnings };
}

export function validateSynthesisResult(value: unknown): ValidationOutcome<SynthesisResult> {
  if (!isRecord(value)) return { ok: false, violations: ["response is not a JSON object"] };

  const violations: string[] = [];
  for (const field of ["question", "sample_answer", "hint"] as const) {
    if (!isNonEmptyString(value[field])) violations.push(`"${field}" is missing or empty`);
  }
  if (violations.length > 0) return { ok: false, violations };

  return {
    ok: true,
    value: {
      question: value.question as string,
      sample_answer: value.sample_answer as string,
      hint: value.hint as string,
    },
    warnings: [],
  };
}

/* ------------------------------------------------------------------ *
 * Transport retry (§9.6)
 * ------------------------------------------------------------------ */

function asProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  return new ProviderError(
    "api_error",
    false,
    redact(error instanceof Error ? error.message : String(error)),
  );
}

async function askWithRetries(
  provider: ModelProvider,
  prompt: string,
  system: string,
  model: string,
  deps: GenerationDeps,
): Promise<AskResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = deps.random ?? Math.random;

  for (let attempt = 0; ; attempt++) {
    try {
      return await provider.askModel(prompt, { system, model, maxTokens: MAX_TOKENS });
    } catch (error) {
      const failure = asProviderError(error);
      if (!failure.retryable || attempt >= API_RETRY_DELAYS_MS.length) throw failure;
      const base = API_RETRY_DELAYS_MS[attempt];
      await sleep(base + Math.floor(random() * base * 0.5));
    }
  }
}

/* ------------------------------------------------------------------ *
 * Entry points
 * ------------------------------------------------------------------ */

async function runGeneration<T, I>(args: {
  system: string;
  user: string;
  /** `finalAttempt` lets a validator soften a rule it can repair only once. */
  validate: (value: unknown, finalAttempt: boolean) => ValidationOutcome<T>;
  payload: I;
  deps: GenerationDeps;
}): Promise<GenerationOutcome<T, I>> {
  const { system, user, validate, payload, deps } = args;
  const model = deps.model ?? DEFAULT_CONFIG.model;

  let provider: ModelProvider;
  try {
    provider =
      deps.provider ??
      (await resolveProvider({
        setting: deps.providerSetting ?? DEFAULT_CONFIG.provider,
        apiKey: deps.apiKey,
        runCli: deps.runCli,
      }));
  } catch (error) {
    const failure = asProviderError(error);
    return {
      ok: false,
      reason: failure.reason,
      error: failure.message,
      violations: [],
      raw: null,
      attempts: 0,
      payload,
    };
  }

  let prompt = user;
  let lastRaw: string | null = null;
  let lastViolations: string[] = [];
  const repairedViolations: string[] = [];

  for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt++) {
    let reply: AskResult;
    try {
      // §5.4: no DB transaction is open across this await — generation happens
      // first, persistence is the caller's separate step.
      reply = await askWithRetries(provider, prompt, system, model, deps);
    } catch (error) {
      const failure = asProviderError(error);
      return {
        ok: false,
        reason: failure.reason,
        error: failure.message,
        violations: [],
        raw: lastRaw,
        attempts: attempt,
        payload,
      };
    }

    lastRaw = reply.text;
    const parsed = parseModelJson(reply.text);
    const outcome: ValidationOutcome<T> = parsed.ok
      ? validate(parsed.value, attempt === MAX_GENERATION_ATTEMPTS)
      : { ok: false, violations: [parsed.error] };

    if (outcome.ok) {
      return {
        ok: true,
        result: outcome.value,
        warnings: outcome.warnings,
        repairedViolations,
        raw: reply.text,
        attempts: attempt,
        usage: reply.usage,
      };
    }

    lastViolations = outcome.violations;
    if (attempt === MAX_GENERATION_ATTEMPTS) break;
    repairedViolations.push(...outcome.violations);

    // §9.6: exactly one repair retry, showing the model its own bad output.
    prompt = `${user}\n\n---\n\n${buildRepairInstruction(outcome.violations, reply.text)}`;
  }

  return {
    ok: false,
    reason: "malformed_output",
    error: `model output violated the output contract after ${MAX_GENERATION_ATTEMPTS} attempts`,
    violations: lastViolations,
    raw: lastRaw,
    attempts: MAX_GENERATION_ATTEMPTS,
    payload,
  };
}

/** §9.1 — one call for a whole live batch, or for one scan section. */
export function generateQuestions(
  input: GenerationInput,
  deps: GenerationDeps = {},
): Promise<GenerationOutcome<GenerationResult, GenerationInput>> {
  return runGeneration({
    system: buildSystemPrompt(),
    user: buildUserMessage(input),
    validate: (value, finalAttempt) => validateGenerationResult(value, input, { finalAttempt }),
    payload: input,
    deps,
  });
}

/** §9.5 — exactly one integration question for a cluster. */
export function generateSynthesisQuestion(
  input: SynthesisGenerationInput,
  deps: GenerationDeps = {},
): Promise<GenerationOutcome<SynthesisResult, SynthesisGenerationInput>> {
  return runGeneration({
    system: buildSynthesisSystemPrompt(),
    user: buildSynthesisUserMessage(input),
    validate: validateSynthesisResult,
    payload: input,
    deps,
  });
}

export { tierForMastery };
