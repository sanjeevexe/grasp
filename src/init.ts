import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";

const HOOK_COMMAND = "grasp internal:hook";
// PostToolUse now runs Phase 5's synchronous `claude -p` judge+generate
// call inline, which the original Phase 3 default (15s) didn't anticipate
// and could plausibly cut off before a real headless call completes. This
// is the outer Claude Code hook timeout, distinct from the inner subprocess
// timeout on the `claude -p` call itself (`GENERATION_TIMEOUT_MS`,
// src/generation.ts) — both exist, sized with margin against each other and
// against this value; see generation.ts's `TOTAL_CALL_BUDGET_MS` comment for
// how a single generation call's whole wall-clock budget, including time
// spent waiting on another overlapping call for the same session, is kept
// under this number.
const HOOK_TIMEOUT_SECONDS = 45;
const HOOK_EVENTS = ["PreToolUse", "PostToolUse", "Stop"] as const;
type HookEventName = (typeof HOOK_EVENTS)[number];

interface HookEntry {
  matcher?: string;
  hooks: Array<{ type: string; command: string; timeout?: number }>;
}

interface HooksSection {
  [eventName: string]: HookEntry[] | undefined;
}

interface ClaudeSettings {
  hooks?: HooksSection;
  [key: string]: unknown;
}

function desiredEntry(matcher: "*" | null): HookEntry {
  const entry: HookEntry = {
    hooks: [{ type: "command", command: HOOK_COMMAND, timeout: HOOK_TIMEOUT_SECONDS }],
  };
  if (matcher !== null) entry.matcher = matcher;
  return entry;
}

// PreToolUse/PostToolUse need a matcher (every tool); Stop isn't tool-scoped,
// matching the shape Claude Code's own docs example uses for non-tool events.
const DESIRED: Record<HookEventName, HookEntry> = {
  PreToolUse: desiredEntry("*"),
  PostToolUse: desiredEntry("*"),
  Stop: desiredEntry(null),
};

/** Index of the entry containing a Grasp hook command, or -1 if this event has no Grasp entry at all yet. */
function findGraspEntryIndex(entries: HookEntry[] | undefined): number {
  return (entries ?? []).findIndex((entry) => entry.hooks?.some((h) => h.command === HOOK_COMMAND));
}

/**
 * Structural (not JSON.stringify-string) comparison — an existing entry's
 * keys could be in any order depending on how/when it was originally
 * written, so string equality would false-positive "stale" on nothing more
 * than key ordering.
 */
function entriesEqual(a: HookEntry, b: HookEntry): boolean {
  if (a.matcher !== b.matcher) return false;
  if (a.hooks.length !== b.hooks.length) return false;
  return a.hooks.every((h, i) => h.type === b.hooks[i].type && h.command === b.hooks[i].command && h.timeout === b.hooks[i].timeout);
}

function askConfirmation(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

/**
 * Installs Grasp's Claude Code hooks into `<repoRoot>/.claude/settings.local.json`
 * — project-scoped and local-only (gitignored by Claude Code convention), not
 * `~/.claude/settings.json` (all projects) or the committed `.claude/settings.json`.
 * See DECISIONS.md's "Hook config location" entry for why: per-repo opt-in
 * matches how `grasp init` is meant to be run (once per repo the user wants
 * monitored), and a committed file would silently enable Grasp for every
 * teammate who clones the repo without their own confirmation.
 */
export async function runInit(repoRoot: string): Promise<void> {
  const settingsPath = path.join(repoRoot, ".claude", "settings.local.json");

  let existing: ClaudeSettings = {};
  if (fs.existsSync(settingsPath)) {
    const raw = fs.readFileSync(settingsPath, "utf-8");
    try {
      existing = JSON.parse(raw);
    } catch (err) {
      // Consistent with the Phase 1 config-loading policy: fail loudly,
      // never silently overwrite a file we can't parse.
      throw new Error(
        `Grasp: ${settingsPath} exists but is not valid JSON (${(err as Error).message}). ` +
          `Fix or remove it manually — Grasp will not overwrite a file it can't parse.`
      );
    }
  }

  const hooks: HooksSection = { ...(existing.hooks ?? {}) };

  // Every event falls into exactly one bucket: no Grasp entry yet (missing),
  // a Grasp entry present but not what a fresh install would write today
  // (stale — e.g. an old timeout value from before the Phase 5 15s->45s
  // bump), or already correct. See DECISIONS.md's "grasp init stale-hook
  // detection" entry — this used to only check bucket 1, so anyone who ran
  // `grasp init` against an older version of Grasp kept whatever was
  // written back then forever, with no way short of manually editing the
  // file to notice or fix it.
  const missing: HookEventName[] = [];
  const stale: HookEventName[] = [];
  for (const eventName of HOOK_EVENTS) {
    const idx = findGraspEntryIndex(hooks[eventName]);
    if (idx === -1) {
      missing.push(eventName);
    } else if (!entriesEqual((hooks[eventName] as HookEntry[])[idx], DESIRED[eventName])) {
      stale.push(eventName);
    }
  }

  if (missing.length === 0 && stale.length === 0) {
    process.stdout.write(`Grasp hooks already installed and up to date in ${settingsPath} — nothing to do.\n`);
    return;
  }

  // Snapshot the "before" shape of stale entries for the confirmation
  // message before mutating the working copy.
  const staleBefore = new Map<HookEventName, HookEntry>();
  for (const eventName of stale) {
    const idx = findGraspEntryIndex(hooks[eventName]);
    staleBefore.set(eventName, (hooks[eventName] as HookEntry[])[idx]);
  }

  for (const eventName of missing) {
    hooks[eventName] = [...(hooks[eventName] ?? []), DESIRED[eventName]];
  }
  for (const eventName of stale) {
    const idx = findGraspEntryIndex(hooks[eventName]);
    const updated = [...(hooks[eventName] as HookEntry[])];
    updated[idx] = DESIRED[eventName];
    hooks[eventName] = updated;
  }

  const updatedSettings: ClaudeSettings = { ...existing, hooks };

  const messageLines: string[] = [];
  if (missing.length > 0) {
    messageLines.push(
      `Grasp will add the following hook(s) to ${settingsPath}:`,
      "",
      JSON.stringify({ hooks: Object.fromEntries(missing.map((e) => [e, DESIRED[e]])) }, null, 2),
      ""
    );
  }
  if (stale.length > 0) {
    messageLines.push(
      `Grasp will UPDATE the following existing hook(s) in ${settingsPath} — they were installed`,
      "by an older version of `grasp init` and are out of date (e.g. a stale timeout value):",
      ""
    );
    for (const eventName of stale) {
      messageLines.push(
        `  ${eventName}:`,
        `    before: ${JSON.stringify(staleBefore.get(eventName))}`,
        `    after:  ${JSON.stringify(DESIRED[eventName])}`,
        ""
      );
    }
  }
  messageLines.push(
    `This registers \`${HOOK_COMMAND}\` for ${[...missing, ...stale].join(", ")} so Grasp can observe file`,
    "changes and turn completions during your Claude Code sessions in this repo. It never",
    "modifies a tool call's own input or output. In the default gate mode (soft), it never",
    "blocks anything either — it only reads and records, and nudges you toward",
    "`grasp review` when a question is waiting. If you opt into gateMode: \"hard\" in your",
    "config, it will deny the next tool call while a question from this session is still",
    "unanswered, until you answer or explicitly skip it via `grasp review`.",
    "",
    "This draws from your existing Claude plan/usage when Grasp later generates",
    "questions (subscription rate-limit headroom, or small API cost if API-billed).",
    ""
  );

  process.stdout.write(messageLines.join("\n"));

  const confirmed = await askConfirmation("Apply these changes? [y/N] ");
  if (!confirmed) {
    process.stdout.write("Aborted — no changes made.\n");
    return;
  }

  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(updatedSettings, null, 2) + "\n", "utf-8");
  process.stdout.write(`Wrote ${settingsPath}\n`);
  process.stdout.write(
    "Note: settings.local.json is meant to stay on your machine only — if this repo doesn't\n" +
      "already gitignore it, consider adding .claude/settings.local.json to .gitignore.\n"
  );
}
