export type Tier = "none" | "trace" | "predict_break" | "reconstruct";
export type SelfAssessment = "nailed_it" | "mostly_there" | "way_off";
export type QuestionType = "trace" | "predict_break" | "reconstruct" | "synthesis";
export type QuestionStatus = "pending" | "answered" | "skipped";
export type AssistanceLevel = "none" | "hint" | "retry" | "scaffolded";
export type GateMode = "soft" | "warn" | "hard";
export type SynthesisStatus = "not_yet_attempted" | "struggled" | "passed";
export type QuestionOrigin = "live" | "scan" | "synthesis";
export type GenerationKind = "live" | "scan" | "synthesis";

/** Structured output contract from the generation call. See DESIGN_BRIEF.md §9.4. */
export interface GeneratedQuestion {
  concept_tag: string;
  reframe: boolean;
  tier: Exclude<Tier, "none">;
  files: string[];
  teaching_card: { body: string; deeper: string | null } | null;
  question: string;
  sample_answer: string;
  hint: string;
  scaffold: string[];
}

export interface GenerationResult {
  skip: boolean;
  skip_reason: string | null;
  questions: GeneratedQuestion[]; // 1-3 when skip=false; NEVER more than 3
}

export interface SynthesisResult {
  question: string;
  sample_answer: string;
  hint: string;
}

/* ------------------------------------------------------------------ *
 * Generation inputs (§9.2, §9.3, §19.1)
 *
 * These double as `generation_failures.payload_json` (§19.1): everything
 * needed to re-run the call without re-deriving it. `grasp retry` (§17)
 * replays a stored payload straight back into the same entry point.
 * ------------------------------------------------------------------ */

export interface GenerationInputBase {
  /** NULL in the dev harness, which has no project. */
  projectId?: number | null;
  /** POSIX-style, relative to the project root (§16.4). */
  files: string[];
  /** EFFECTIVE (post-decay) tier per concept tag (§11.2). Absent tag ⇒ "none". */
  masteryContext: Record<string, Tier>;
  /** Most-recently-demonstrated first; capped at MAX_KNOWN_TAGS at assembly (§9.3). */
  knownTags: string[];
}

export interface LiveGenerationInput extends GenerationInputBase {
  kind: "live";
  /** Standard unified diff, ~3 lines of context, may span several files (§5.5). */
  diff: string;
}

export interface ScanGenerationInput extends GenerationInputBase {
  kind: "scan";
  /** Existing code — a whole file or one section of a split file (§12.2). */
  section: string;
  /** e.g. "section 2 of 4, lines 380-780" — set when a file was split (§12.2). */
  sectionLabel?: string | null;
}

export type GenerationInput = LiveGenerationInput | ScanGenerationInput;

/** One previously-captured piece of code under the synthesis tag (§9.5). */
export interface SynthesisBundleItem {
  files: string[];
  /** The stored `questions.code_snippet` for that piece. */
  code: string;
  /** The question already asked about it, so the checkpoint does not repeat it. */
  question?: string;
}

export interface SynthesisGenerationInput {
  kind: "synthesis";
  projectId?: number | null;
  /** The concept tag this cluster is built from (§11.5). */
  tag: string;
  /** Union of the files across the bundle, POSIX-style and project-relative. */
  files: string[];
  bundle: SynthesisBundleItem[];
}

export type AnyGenerationInput = GenerationInput | SynthesisGenerationInput;

/* ------------------------------------------------------------------ *
 * Generation outcomes (§9.6)
 * ------------------------------------------------------------------ */

export type GenerationFailureReason =
  /** Model returned non-JSON or schema-violating output twice (§9.6). */
  | "malformed_output"
  /** 429/5xx after retries, a non-retryable 4xx, or a transport error. */
  | "api_error"
  /** 401/403 — "check your API key", never a crash and never a notification. */
  | "auth_error";

export interface GenerationSuccess<T> {
  ok: true;
  result: T;
  /** Rule violations that are NOT schema violations — see §9.6 handling notes. */
  warnings: string[];
  /**
   * What the earlier attempt got wrong, when a repair retry was spent (§9.6).
   * Empty on a first-attempt success. Without this, a two-attempt success is
   * indistinguishable from a one-attempt success, and §9.7's iteration loop
   * cannot see which prompt rule is not landing.
   */
  repairedViolations: string[];
  /** Raw model text of the accepted response, for `dev-generate` inspection. */
  raw: string;
  /** Generation attempts spent (1, or 2 when the JSON-repair retry was used). */
  attempts: number;
  usage: { input_tokens: number; output_tokens: number } | null;
}

export interface GenerationFailureOutcome<I> {
  ok: false;
  reason: GenerationFailureReason;
  /** Safe to persist and log: never contains the API key or any file content. */
  error: string;
  /** Schema violations, when `reason` is "malformed_output". */
  violations: string[];
  raw: string | null;
  attempts: number;
  /** §19.1 — the re-attemptable input, verbatim. */
  payload: I;
}

export type GenerationOutcome<T, I> = GenerationSuccess<T> | GenerationFailureOutcome<I>;

/** Result of validating raw model output against the §9.4 contract. */
export type ValidationOutcome<T> =
  { ok: true; value: T; warnings: string[] } | { ok: false; violations: string[] };
