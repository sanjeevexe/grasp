/**
 * Stage-1 iteration harness.  GOVERNED BY: DESIGN_BRIEF.md §9.7, §23
 *
 * Takes a file path or a diff and prints BOTH the raw model output and the
 * parsed/validated result — without touching the daemon, the DB, or any config.
 *
 * This exists because question quality IS the product (§9.7). Build order §23
 * gates every other stage on this producing genuinely good questions against
 * real diffs. Expect the prompt to be rewritten many times using this harness.
 *
 * Usage:
 *   npm run dev:generate -- path/to/file.ts
 *   npm run dev:generate -- --diff path/to/change.diff        (- reads stdin)
 *   npm run dev:generate -- path/to/file.ts --mastery debouncing=trace
 *   npm run dev:generate -- path/to/file.ts --tags auth-flow,debouncing
 *   npm run dev:generate -- --dir src/capture
 *   npm run dev:generate -- --synthesis --tag auth-flow a.ts b.ts
 *   ... --model <id> --provider <p> --print-prompt
 *
 * Transport comes from the same §6.3 resolution the daemon uses: the Claude Code
 * CLI when it is installed and logged in, otherwise an API key. --provider pins
 * one so both paths can be exercised deliberately.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import chalk from "chalk";
import picomatch from "picomatch";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import {
  generateQuestions,
  generateSynthesisQuestion,
} from "../src/generation/generateQuestion.js";
import type { AskResult, ProviderSetting } from "../src/generation/provider.js";
import { buildSystemPrompt, buildUserMessage } from "../src/generation/prompts/systemPrompt.js";
import {
  buildSynthesisSystemPrompt,
  buildSynthesisUserMessage,
} from "../src/generation/prompts/synthesisPrompt.js";
import { toPosix } from "../src/util/paths.js";
import type {
  GeneratedQuestion,
  GenerationInput,
  SynthesisGenerationInput,
  Tier,
} from "../src/types/index.js";

const TIERS: readonly Tier[] = ["none", "trace", "predict_break", "reconstruct"];

interface Options {
  paths: string[];
  diffPath: string | null;
  mastery: Record<string, Tier>;
  tags: string[];
  model: string;
  printPrompt: boolean;
  synthesis: boolean;
  tag: string | null;
  provider: ProviderSetting;
  dir: string | null;
}

const USAGE = `dev-generate — stage-1 prompt harness (DESIGN_BRIEF.md §9.7)

  npm run dev:generate -- <file>                       scan mode: existing code
  npm run dev:generate -- --diff <file|->              live mode: a unified diff
  npm run dev:generate -- --synthesis --tag <t> <f...> synthesis checkpoint

  --mastery <tag>=<tier>   effective mastery, repeatable (none|trace|predict_break|reconstruct)
  --tags <a,b,c>           known concept tags, most-recently-demonstrated first
  --dir <path>             scan every eligible file under <path>, one call each
  --model <id>             default: ${DEFAULT_CONFIG.model}
  --provider <p>           auto|claude-cli|api (default: ${DEFAULT_CONFIG.provider})
  --print-prompt           also print the assembled system + user prompt`;

function fail(message: string): never {
  process.stderr.write(`${chalk.red("error:")} ${message}\n`);
  process.exit(2);
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    paths: [],
    diffPath: null,
    mastery: {},
    tags: [],
    model: DEFAULT_CONFIG.model,
    printPrompt: false,
    synthesis: false,
    tag: null,
    provider: DEFAULT_CONFIG.provider,
    dir: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) fail(`${arg} needs a value`);
      return value;
    };

    switch (arg) {
      case "-h":
      case "--help":
        process.stdout.write(`${USAGE}\n`);
        process.exit(0);
        break;
      case "--diff":
        options.diffPath = next();
        break;
      case "--dir":
        options.dir = next();
        break;
      case "--mastery": {
        const [tag, tier] = next().split("=");
        if (!tag || !tier) fail("--mastery expects <tag>=<tier>");
        if (!TIERS.includes(tier as Tier)) fail(`unknown tier "${tier}" (${TIERS.join("|")})`);
        options.mastery[tag] = tier as Tier;
        break;
      }
      case "--tags":
        options.tags.push(
          ...next()
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean),
        );
        break;
      case "--model":
        options.model = next();
        break;
      case "--provider": {
        const value = next();
        if (value !== "auto" && value !== "claude-cli" && value !== "api") {
          fail("--provider expects auto|claude-cli|api");
        }
        options.provider = value;
        break;
      }
      case "--print-prompt":
        options.printPrompt = true;
        break;
      case "--synthesis":
        options.synthesis = true;
        break;
      case "--tag":
        options.tag = next();
        break;
      default:
        if (arg.startsWith("-")) fail(`unknown flag ${arg}\n\n${USAGE}`);
        options.paths.push(arg);
    }
  }

  return options;
}

/**
 * Distinguish the failure modes. "cannot read" for a directory, a typo, and an
 * unsupported extension alike is the kind of error message that costs ten
 * minutes to diagnose.
 */
function read(target: string): string {
  if (target === "-") return readFileSync(0, "utf8");

  let stats;
  try {
    stats = statSync(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return fail(`no such file: ${target}`);
    if (code === "EACCES") return fail(`permission denied: ${target}`);
    return fail(`cannot stat ${target}: ${code ?? "unknown error"}`);
  }

  if (stats.isDirectory()) {
    return fail(`${target} is a directory — use --dir ${target} to walk it`);
  }
  if (!stats.isFile()) return fail(`${target} is not a regular file`);

  try {
    return readFileSync(target, "utf8");
  } catch (error) {
    return fail(
      `cannot read ${target}: ${(error as NodeJS.ErrnoException).code ?? "unknown error"}`,
    );
  }
}

/**
 * §7.1's source-extension gate, mirrored here so --dir behaves like the pipeline
 * rather than sending the model a PNG. The daemon owns the canonical set from
 * stage 6; this list is the harness's own.
 */
const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".rb",
  ".php",
  ".java",
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

/** Walk a directory, applying config.ignorePatterns exactly as §7.5 does. */
function walkDirectory(root: string): string[] {
  let stats;
  try {
    stats = statSync(root);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return fail(`no such directory: ${root}`);
    return fail(`cannot stat ${root}: ${code ?? "unknown error"}`);
  }
  if (!stats.isDirectory()) {
    return fail(`${root} is not a directory — pass it as a positional argument instead`);
  }

  const isIgnored = picomatch(DEFAULT_CONFIG.ignorePatterns);
  const found: string[] = [];

  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const relative = relativePath(full);
      if (entry.name === ".git" || isIgnored(relative)) continue;
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) found.push(full);
    }
  };

  visit(root);
  return found.sort();
}

/** Project-relative, POSIX-style — the same shape the pipeline stores (§16.4). */
function relativePath(target: string): string {
  return toPosix(path.relative(process.cwd(), path.resolve(target)) || path.basename(target));
}

const rule = (label: string): string =>
  chalk.dim(`${"─".repeat(3)} ${label} ${"─".repeat(Math.max(0, 72 - label.length))}`);

function printQuestion(q: GeneratedQuestion, index: number): void {
  const tier = { trace: chalk.blue, predict_break: chalk.yellow, reconstruct: chalk.magenta }[
    q.tier
  ];
  process.stdout.write(
    `\n${chalk.bold(`[${index + 1}]`)} ${tier.bold(q.tier)}  ${chalk.cyan(q.concept_tag)}` +
      `${q.reframe ? chalk.dim("  (reframe)") : ""}  ${chalk.dim(q.files.join(", "))}\n`,
  );

  if (q.teaching_card) {
    process.stdout.write(`\n${chalk.green("┃ TEACHING CARD")}\n`);
    for (const line of q.teaching_card.body.split("\n")) {
      process.stdout.write(`${chalk.green("┃")} ${line}\n`);
    }
    if (q.teaching_card.deeper) {
      process.stdout.write(
        `${chalk.green("┃")} ${chalk.dim("[deeper]")} ${q.teaching_card.deeper}\n`,
      );
    }
  }

  process.stdout.write(`\n${chalk.bold.white("QUESTION")}\n${q.question}\n`);
  if (q.tier === "reconstruct") {
    process.stdout.write(
      chalk.dim("(reconstruct: the code is hidden while the user answers — check for leaks)\n"),
    );
  }
  process.stdout.write(`\n${chalk.dim("HINT")}      ${chalk.dim(q.hint)}\n`);
  process.stdout.write(`\n${chalk.yellow("SAMPLE ANSWER")}\n${chalk.yellow(q.sample_answer)}\n`);
  if (q.scaffold.length > 0) {
    process.stdout.write(`\n${chalk.dim("SCAFFOLD")}\n`);
    q.scaffold.forEach((step, i) => process.stdout.write(chalk.dim(`  ${i + 1}. ${step}\n`)));
  }
}

function printPrompt(system: string, user: string): void {
  process.stdout.write(`\n${rule("SYSTEM PROMPT")}\n${system}\n`);
  process.stdout.write(`\n${rule("USER MESSAGE")}\n${user}\n`);
}

function printMeta(label: string, attempts: number, ms: number, usage: AskResult["usage"]): void {
  const tokens = usage ? ` · ${usage.input_tokens} in / ${usage.output_tokens} out` : "";
  process.stdout.write(chalk.dim(`\n${label} · ${attempts} attempt(s) · ${ms}ms${tokens}\n`));
}

function scanInputFor(file: string, options: Options): GenerationInput {
  return {
    kind: "scan",
    files: [relativePath(file)],
    masteryContext: options.mastery,
    knownTags: options.tags,
    section: read(file),
  };
}

/** One generation call, printed. Returns false if it failed. */
async function runOne(input: GenerationInput, options: Options): Promise<boolean> {
  const started = Date.now();
  const masteryLine =
    Object.entries(options.mastery)
      .map(([t, v]) => `${t}=${v}`)
      .join(" ") || "(all none)";
  process.stdout.write(
    `${rule("INPUT")}\n${input.kind} · ${input.files.join(", ")}\n` +
      `mastery: ${masteryLine}\nknown tags: ${options.tags.join(", ") || "(none)"}\n`,
  );

  if (options.printPrompt) printPrompt(buildSystemPrompt(), buildUserMessage(input));

  const outcome = await generateQuestions(input, {
    model: options.model,
    providerSetting: options.provider,
  });

  process.stdout.write(`\n${rule("RAW MODEL OUTPUT")}\n${outcome.raw ?? "(none)"}\n`);

  if (!outcome.ok) {
    process.stdout.write(`\n${rule("FAILED")}\n${chalk.red(outcome.reason)}: ${outcome.error}\n`);
    for (const v of outcome.violations) process.stdout.write(chalk.red(`  violation: ${v}\n`));
    process.stdout.write(
      chalk.dim("\ncheckpoint would NOT advance; payload would go to generation_failures (§8.3)\n"),
    );
    return false;
  }

  process.stdout.write(`\n${rule("PARSED")}\n`);
  for (const v of outcome.repairedViolations) {
    process.stdout.write(chalk.red(`  repaired: ${v}\n`));
  }
  for (const w of outcome.warnings) process.stdout.write(chalk.yellow(`  warning: ${w}\n`));

  if (outcome.result.skip) {
    process.stdout.write(`\n${chalk.dim("SKIP")} — ${outcome.result.skip_reason}\n`);
    process.stdout.write(chalk.dim("checkpoint WOULD advance: nothing worth asking (§8.3)\n"));
  } else {
    outcome.result.questions.forEach(printQuestion);
  }

  printMeta(options.model, outcome.attempts, Date.now() - started, outcome.usage);
  return true;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.synthesis && !options.tag) fail("--synthesis requires --tag <concept-tag>");
  if (options.dir && (options.diffPath || options.synthesis)) {
    fail("--dir cannot be combined with --diff or --synthesis");
  }
  if (!options.synthesis && !options.diffPath && !options.dir && options.paths.length !== 1) {
    fail(
      options.paths.length === 0
        ? `scan mode needs a file — pass one, or use --dir to walk a directory\n\n${USAGE}`
        : `scan mode takes exactly one file (got ${options.paths.length}); use --dir to walk a directory\n\n${USAGE}`,
    );
  }

  const started = Date.now();

  if (options.synthesis) {
    const input: SynthesisGenerationInput = {
      kind: "synthesis",
      tag: options.tag as string,
      files: options.paths.map(relativePath),
      bundle: options.paths.map((p) => ({ files: [relativePath(p)], code: read(p) })),
    };
    process.stdout.write(
      `${rule("INPUT")}\nsynthesis · tag ${chalk.cyan(input.tag)} · ${input.bundle.length} piece(s)\n`,
    );
    if (options.printPrompt) {
      printPrompt(buildSynthesisSystemPrompt(), buildSynthesisUserMessage(input));
    }

    const outcome = await generateSynthesisQuestion(input, {
      model: options.model,
      providerSetting: options.provider,
    });
    process.stdout.write(`\n${rule("RAW MODEL OUTPUT")}\n${outcome.raw ?? "(none)"}\n`);
    if (!outcome.ok) {
      process.stdout.write(`\n${rule("FAILED")}\n${chalk.red(outcome.reason)}: ${outcome.error}\n`);
      for (const v of outcome.violations) process.stdout.write(chalk.red(`  - ${v}\n`));
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`\n${rule("PARSED")}\n`);
    process.stdout.write(`\n${chalk.bold.white("QUESTION")}\n${outcome.result.question}\n`);
    process.stdout.write(`\n${chalk.dim("HINT")}      ${chalk.dim(outcome.result.hint)}\n`);
    process.stdout.write(
      `\n${chalk.yellow("SAMPLE ANSWER")}\n${chalk.yellow(outcome.result.sample_answer)}\n`,
    );
    printMeta(options.model, outcome.attempts, Date.now() - started, outcome.usage);
    return;
  }

  if (options.dir) {
    const files = walkDirectory(options.dir);
    if (files.length === 0) {
      fail(`no eligible source files under ${options.dir} (after ignorePatterns)`);
    }
    process.stdout.write(
      `${rule("DIRECTORY")}\n${options.dir} · ${files.length} eligible file(s)\n`,
    );
    let failures = 0;
    for (const [index, file] of files.entries()) {
      process.stdout.write(
        `\n${chalk.bold(`[${index + 1}/${files.length}]`)} ${chalk.cyan(relativePath(file))}\n`,
      );
      const ok = await runOne(scanInputFor(file, options), options);
      if (!ok) failures += 1;
    }
    if (failures > 0) process.exitCode = 1;
    return;
  }

  const base = {
    files: [] as string[],
    masteryContext: options.mastery,
    knownTags: options.tags,
  };

  let input: GenerationInput;
  if (options.diffPath) {
    const diff = read(options.diffPath);
    // Files come from the diff's own +++ headers, so attribution matches what
    // the pipeline would store; fall back to any paths given positionally.
    const fromHeaders = [...diff.matchAll(/^\+\+\+ [ab]?\/?(.+)$/gm)]
      .map((m) => toPosix(m[1].trim()))
      .filter((p) => p !== "/dev/null");
    const files =
      fromHeaders.length > 0 ? [...new Set(fromHeaders)] : options.paths.map(relativePath);
    if (files.length === 0) fail("no file paths found in the diff — pass them positionally");
    input = { ...base, kind: "live", files, diff };
  } else {
    const target = options.paths[0];
    const extension = path.extname(target);
    if (!SOURCE_EXTENSIONS.has(extension)) {
      fail(
        extension
          ? `unsupported extension "${extension}" — ${relativePath(target)} would never enter the pipeline (§7.1)`
          : `${relativePath(target)} has no extension — only source files enter the pipeline (§7.1)`,
      );
    }
    input = { ...base, kind: "scan", files: [relativePath(target)], section: read(target) };
  }

  await runOne(input, options);
}

main().catch((error: unknown) => {
  process.stderr.write(`${chalk.red("unexpected error:")} ${String(error)}\n`);
  process.exit(1);
});
