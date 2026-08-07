/**
 * Baseline ignore patterns that exist independently of user config.
 * Consumed by `classifyIgnoreExclusion` in src/filter.ts (Phase 4's
 * mechanical pre-filter) on every captured diff.
 */
export const BASELINE_IGNORE_PATTERNS: readonly string[] = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.lock",
  "poetry.lock",
  "Gemfile.lock",
  "node_modules/",
  "dist/",
  "build/",
  ".git/",
  // Grasp's own per-repo config file — not part of the AI agent's work, so
  // it should never itself become a diff a question gets generated about.
  // Found via Phase 9's real end-to-end ignorePatterns test: an untracked
  // .grasp.json (Phase 2's capture unions in untracked files) was the only
  // significant file in a diff and passed the filter, producing a
  // nonsensical question about Grasp's own config. See DECISIONS.md's
  // "config completeness audit" entry.
  ".grasp.json",
  // Same class of bug, same fix, for the hook config file `grasp init`
  // itself writes (src/init.ts) — an untracked, uncommitted
  // .claude/settings.local.json can be swept into capture exactly like
  // .grasp.json was, and a question about Grasp's own hook registration is
  // just as nonsensical as one about its own config file. Flagged by an
  // independent test pass (Codex) after Phase 9 shipped the .grasp.json
  // fix without generalizing it to this file too — see DECISIONS.md's
  // "Codex fix pass" entries.
  ".claude/settings.local.json",
];
