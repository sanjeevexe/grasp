/**
 * Directory walking under `ignorePatterns`.  GOVERNED BY: §7.1, §7.5, §12.2
 *
 * One walker shared by `grasp init` (snapshot population) and `grasp scan`, so
 * both see exactly the same file set — a scan that covered files init never
 * snapshotted would produce questions about code the checkpoint does not know.
 */
import fs from "node:fs";
import path from "node:path";
import picomatch from "picomatch";
import { toProjectRelative } from "./paths.js";

export function collectSourceFiles(
  root: string,
  ignorePatterns: string[],
  isSource: (filePath: string) => boolean,
): string[] {
  const isIgnored = picomatch(ignorePatterns);
  const found: string[] = [];

  const visit = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory: skip rather than fail the whole walk
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      // .git is always excluded, whatever the patterns say (§7.1).
      if (entry.name === ".git") continue;
      const relative = toProjectRelative(root, full);
      if (relative === "" || isIgnored(relative)) continue;
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && isSource(full)) found.push(full);
    }
  };

  visit(root);
  return found.sort();
}
