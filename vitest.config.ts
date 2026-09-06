import { defineConfig } from "vitest/config";

// Coverage thresholds are a RELEASE GATE, not a nicety. See DESIGN_BRIEF.md §22.1.
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./test/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      // Overall floor
      thresholds: {
        lines: 85,
        branches: 80,
        // 95% line coverage on modules where a silent bug corrupts user state
        // or spends the user's money (§22.1).
        "src/mastery/**": { lines: 95 },
        "src/synthesis/**": { lines: 95 },
        "src/capture/rateLimit.ts": { lines: 95 },
        "src/gate/gitHook.ts": { lines: 95 },
        "src/generation/**": { lines: 95 },
      },
      // Only source counts. dist/ is compiled output, types/index.ts is
      // type-only (v8 reports 0% for a file with no runtime code), and
      // cli/index.ts is commander wiring plus the only permitted process.exit.
      include: ["src/**/*.ts"],
      exclude: [
        "src/cli/index.ts",
        "src/types/index.ts",
        "**/*.d.ts",
        "dist/**",
        "scripts/**",
        "test/**",
      ],
    },
  },
});
