/** Default global config.  GOVERNED BY: §18.1 (canonical values live there). */
export const DEFAULT_CONFIG = {
  apiKey: null as string | null,
  // §6.3: "auto" prefers the Claude Code CLI (subscription auth, no API credits)
  // and falls back to the API key. Pin it to force one transport.
  provider: "auto" as "auto" | "claude-cli" | "api",
  model: "claude-sonnet-4-6",
  gateMode: "soft" as "soft" | "warn" | "hard",
  debounceMs: 4000,
  maxFilesPerBatch: 25,
  maxDiffLines: 800,
  maxQuestionsPerHour: 12,
  questionStaleDays: 14 as number | null,
  scanQuestionsCap: 15,
  decayWindows: { trace: 90, predictBreak: 60, reconstruct: 45 },
  synthesisTrigger: { minDiffCount: 3, minMasteryTier: "predict_break" as const },
  notifications: {
    batching: "per_turn" as "per_turn" | "per_question",
    quietHours: null as [string, string] | null,
    snoozeUntil: null as string | null,
  },
  // §14.4 — review keybindings, configurable because collisions are
  // machine-specific: a terminal, a multiplexer, or the OS itself may claim a
  // combination before Grasp ever sees it.
  review: {
    keys: {
      hint: "ctrl+t",
      explain: "ctrl+e",
      deeper: "ctrl+r",
      breakdown: "ctrl+k",
      skip: "ctrl+n",
      quit: "ctrl+c",
    },
  },
  ignorePatterns: [
    "**/node_modules/**",
    "**/dist/**",
    "**/build/**",
    "**/.next/**",
    "**/vendor/**",
    "**/generated/**",
    "**/*.min.js",
    "**/*.map",
    "**/package-lock.json",
    "**/yarn.lock",
    "**/pnpm-lock.yaml",
    "**/*.lock",
    "**/__snapshots__/**",
    "**/*.generated.*",
  ],
  diffSizeThreshold: { minLines: 3 },
};
