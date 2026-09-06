/**
 * `grasp uninstall-hooks`.  GOVERNED BY: §6.5, §13.2
 *
 * Removes Grasp's pre-commit hook from every registered repo and restores any
 * chained original. Without this, removing the package leaves dead hooks behind
 * that break commits (§6.5).
 */
import fs from "node:fs";
import chalk from "chalk";
import { closeDatabase, openDatabase } from "../../storage/db.js";
import { listProjects } from "../../storage/models/projects.js";
import { removeHook } from "../../gate/gitHook.js";

export interface UninstallHooksOptions {
  dbFile?: string;
}

export function runUninstallHooks(options: UninstallHooksOptions = {}): {
  exitCode: number;
  removed: number;
  restored: number;
} {
  const db = openDatabase(options.dbFile ? { file: options.dbFile } : {});
  try {
    let removed = 0;
    let restored = 0;

    for (const project of listProjects(db)) {
      // A repo may have been deleted since it was registered.
      if (!fs.existsSync(project.path)) continue;
      const result = removeHook(project.path);
      if (result.removed) removed += 1;
      if (result.restoredForeign) restored += 1;
      if (result.removed) {
        process.stdout.write(
          chalk.dim(
            `removed hook from ${project.path}${result.restoredForeign ? " (restored original)" : ""}\n`,
          ),
        );
      }
    }

    process.stdout.write(
      `${chalk.green(`${removed} hook(s) removed`)}${restored > 0 ? `, ${restored} original(s) restored` : ""}.\n`,
    );
    return { exitCode: 0, removed, restored };
  } finally {
    closeDatabase(db);
  }
}
