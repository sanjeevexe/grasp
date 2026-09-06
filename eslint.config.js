import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";

export default [
  {
    files: ["src/**/*.ts", "test/**/*.ts", "scripts/**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: { ecmaVersion: 2022, sourceType: "module" },
    },
    plugins: { "@typescript-eslint": tseslint },
    rules: {
      ...tseslint.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "error",
      // §7.4: shell-outs must use execFile with argv arrays, never string
      // interpolation — file paths contain spaces and shell metacharacters.
      "no-restricted-properties": [
        "error",
        {
          object: "child_process",
          property: "exec",
          message: "Use execFile (DESIGN_BRIEF.md §7.4)",
        },
      ],
    },
  },
  { ignores: ["dist/**", "coverage/**", "node_modules/**"] },
];
