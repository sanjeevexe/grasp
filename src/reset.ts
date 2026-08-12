import * as path from "path";
import * as readline from "readline";
import Database from "better-sqlite3";
import { GLOBAL_CONFIG_PATH, REPO_CONFIG_FILENAME } from "./paths";
import { resetGlobalConfigFile, resetRepoConfigFile } from "./config";
import { clearHistory, getHistoryRowCounts } from "./store";

export interface ResetCommandDeps {
  repoRoot: string;
  globalConfigPath?: string;
}

/**
 * `grasp reset config [--global]`. `--global` overwrites
 * `~/.grasp/config.json` with `DEFAULT_CONFIG` (same shape
 * `ensureGlobalConfigFile` writes on first run). The local case DELETES
 * `.grasp.json` if present rather than writing back an empty override file
 * — see DECISIONS.md's "grasp reset config (local): delete vs empty-out"
 * entry for the reasoning.
 */
export function runResetConfig(args: string[], deps: ResetCommandDeps): void {
  const global = args.includes("--global");
  const globalConfigPath = deps.globalConfigPath ?? GLOBAL_CONFIG_PATH;

  if (global) {
    resetGlobalConfigFile(globalConfigPath);
    process.stdout.write(`Reset global config to defaults (${globalConfigPath})\n`);
    return;
  }

  const repoConfigPath = path.join(deps.repoRoot, REPO_CONFIG_FILENAME);
  const deleted = resetRepoConfigFile(repoConfigPath);
  if (deleted) {
    process.stdout.write(`Removed ${repoConfigPath} — this repo now fully falls back to global config.\n`);
  } else {
    process.stdout.write(`No ${repoConfigPath} found — this repo was already using global config only.\n`);
  }
}

/**
 * Reads a single y/N line from stdin. Only ever called when `--yes` was NOT
 * passed — `runResetHistory` below skips this entirely in that case, so a
 * non-interactive/scripted invocation (including this overnight run's own
 * verification steps) can never hang waiting on stdin that will never
 * arrive.
 */
function askYesNo(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

export interface ResetHistoryDeps {
  openDb: () => Database.Database;
}

/**
 * `grasp reset history` — irreversibly clears both `events` and
 * `concept_tags`. Requires confirmation: an interactive y/N prompt by
 * default, or `--yes` to skip it for scripting/automation. `--yes`
 * genuinely bypasses the readline prompt (never even constructs it), so it
 * can't hang on a non-TTY stdin.
 */
export async function runResetHistory(args: string[], deps: ResetHistoryDeps): Promise<void> {
  const skipConfirm = args.includes("--yes");

  const db = deps.openDb();
  try {
    const counts = getHistoryRowCounts(db);

    if (!skipConfirm) {
      const confirmed = await askYesNo(
        `This will permanently delete ${counts.events} event row(s) and ${counts.conceptTags} concept_tags row(s) from your Grasp history. This cannot be undone. Continue? [y/N] `
      );
      if (!confirmed) {
        process.stdout.write("Aborted — no history was deleted.\n");
        return;
      }
    }

    const deleted = clearHistory(db);
    process.stdout.write(
      `Deleted ${deleted.events} event row(s) and ${deleted.conceptTags} concept_tags row(s). History is now empty.\n`
    );
  } finally {
    db.close();
  }
}
