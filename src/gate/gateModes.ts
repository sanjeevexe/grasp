/**
 * Gate mode resolution.  GOVERNED BY: §13
 *
 * Per project: `projects.gate_mode` if set, else `config.gateMode`. `warn` and
 * `hard` install a pre-commit hook; switching to `soft` removes it.
 */
import type { DatabaseSync } from "node:sqlite";
import { getProjectByPath } from "../storage/models/projects.js";
import { installHook, removeHook } from "./gitHook.js";
import type { GateMode } from "../types/index.js";

export function resolveGateMode(
  projectGateMode: GateMode | null,
  configGateMode: GateMode,
): GateMode {
  return projectGateMode ?? configGateMode;
}

export function gateModeFor(
  db: DatabaseSync,
  projectPath: string,
  configGateMode: GateMode,
): GateMode {
  return resolveGateMode(getProjectByPath(db, projectPath)?.gate_mode ?? null, configGateMode);
}

/** §13.1 — the hook exists only for `warn` and `hard`. */
export function syncHookForMode(repoRoot: string, mode: GateMode): { hookPresent: boolean } {
  if (mode === "soft") {
    removeHook(repoRoot);
    return { hookPresent: false };
  }
  installHook(repoRoot);
  return { hookPresent: true };
}
