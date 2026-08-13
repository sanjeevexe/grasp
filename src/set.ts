import * as path from "path";
import { GLOBAL_CONFIG_PATH, REPO_CONFIG_FILENAME } from "./paths";
import { setConfigValue } from "./config";

/**
 * Resolves which config file a `grasp set ...` invocation should write to:
 * `~/.grasp/config.json` under `--global`, otherwise `<repoRoot>/.grasp.json`
 * — the same local/global split every `grasp set` subcommand shares.
 */
function targetConfigPath(repoRoot: string, global: boolean, globalConfigPath: string): string {
  return global ? globalConfigPath : path.join(repoRoot, REPO_CONFIG_FILENAME);
}

function scopeLabel(global: boolean, targetPath: string): string {
  return global ? `global config (${targetPath})` : `this repo's config (${targetPath})`;
}

export interface SetCommandDeps {
  repoRoot: string;
  globalConfigPath?: string;
}

/**
 * `grasp set mode --easy/--medium/--hard [--global]` — writes the
 * `difficultyMode` field via the shared read-modify-write config path (see
 * `setConfigValue`, config.ts), preserving any other keys already in the
 * target file.
 */
export function runSetMode(args: string[], deps: SetCommandDeps): void {
  const global = args.includes("--global");
  const wantsEasy = args.includes("--easy");
  const wantsMedium = args.includes("--medium");
  const wantsHard = args.includes("--hard");
  const flagCount = [wantsEasy, wantsMedium, wantsHard].filter(Boolean).length;

  if (flagCount !== 1) {
    process.stderr.write("Usage: grasp set mode --easy|--medium|--hard [--global]\n");
    process.exitCode = 1;
    return;
  }

  const difficultyMode = wantsEasy ? "easy" : wantsMedium ? "medium" : "hard";
  const targetPath = targetConfigPath(deps.repoRoot, global, deps.globalConfigPath ?? GLOBAL_CONFIG_PATH);
  setConfigValue(targetPath, "difficultyMode", difficultyMode);
  process.stdout.write(`Set difficultyMode="${difficultyMode}" in ${scopeLabel(global, targetPath)}\n`);
}

/** `grasp set gate soft/hard [--global]` — writes the existing `gateMode` field. */
export function runSetGate(args: string[], deps: SetCommandDeps): void {
  const global = args.includes("--global");
  const positional = args.filter((a) => !a.startsWith("--"));
  const mode = positional[0];

  if (mode !== "soft" && mode !== "hard") {
    process.stderr.write("Usage: grasp set gate soft|hard [--global]\n");
    process.exitCode = 1;
    return;
  }

  const targetPath = targetConfigPath(deps.repoRoot, global, deps.globalConfigPath ?? GLOBAL_CONFIG_PATH);
  setConfigValue(targetPath, "gateMode", mode);
  process.stdout.write(`Set gateMode="${mode}" in ${scopeLabel(global, targetPath)}\n`);
}

/** `grasp set questions-cap <n> [--global]` — writes the existing `questionsPerSessionCap` field. */
export function runSetQuestionsCap(args: string[], deps: SetCommandDeps): void {
  const global = args.includes("--global");
  const positional = args.filter((a) => !a.startsWith("--"));
  const raw = positional[0];
  const n = Number(raw);

  // Same validation `validateConfigOverride` already applies to
  // `questionsPerSessionCap` (config.ts) — kept in sync deliberately so a
  // value this command rejects up front is never one that would also fail
  // the write-back's own re-validation with a more confusing error.
  if (!raw || !Number.isInteger(n) || n < 1) {
    process.stderr.write("Usage: grasp set questions-cap <positive-integer> [--global]\n");
    process.exitCode = 1;
    return;
  }

  const targetPath = targetConfigPath(deps.repoRoot, global, deps.globalConfigPath ?? GLOBAL_CONFIG_PATH);
  setConfigValue(targetPath, "questionsPerSessionCap", n);
  process.stdout.write(`Set questionsPerSessionCap=${n} in ${scopeLabel(global, targetPath)}\n`);
}

/**
 * `grasp set scan-cap <n> [--global]` — writes `scanQuestionsCap`, `grasp
 * scan`'s own independent question-count cap. Deliberately a SEPARATE
 * command/field from `questions-cap`/`questionsPerSessionCap` above, which
 * governs live, hook-driven Claude Code sessions — see DECISIONS.md's
 * `grasp scan` entries for why the two caps must stay isolated.
 */
export function runSetScanCap(args: string[], deps: SetCommandDeps): void {
  const global = args.includes("--global");
  const positional = args.filter((a) => !a.startsWith("--"));
  const raw = positional[0];
  const n = Number(raw);

  // Same validation `validateConfigOverride` already applies to
  // `scanQuestionsCap` (config.ts) — kept in sync for the same reason
  // `questions-cap` above does.
  if (!raw || !Number.isInteger(n) || n < 1) {
    process.stderr.write("Usage: grasp set scan-cap <positive-integer> [--global]\n");
    process.exitCode = 1;
    return;
  }

  const targetPath = targetConfigPath(deps.repoRoot, global, deps.globalConfigPath ?? GLOBAL_CONFIG_PATH);
  setConfigValue(targetPath, "scanQuestionsCap", n);
  process.stdout.write(`Set scanQuestionsCap=${n} in ${scopeLabel(global, targetPath)}\n`);
}
