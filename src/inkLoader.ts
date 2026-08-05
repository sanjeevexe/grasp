import type * as InkTypes from "ink";
import type { default as TextInputComponent } from "ink-text-input";

/**
 * Loads `ink` and `ink-text-input` at runtime via a genuine ESM dynamic
 * `import()`, wrapped in `eval` so TypeScript's CommonJS emit doesn't
 * downlevel it into a `require()` call (which fails for these ESM-only
 * packages) — see DECISIONS.md's "ink version and CommonJS/ESM interop"
 * entry for the empirical verification behind this. Type imports above are
 * `import type` — erased at compile time, so they never trigger a runtime
 * require/import of their own; only this function's `eval` calls do.
 *
 * Only ever call this from `grasp review`'s own entry point, which has a
 * real controlling terminal to render to — hooks do not (see the TTY
 * finding entry) and must never attempt this.
 */
export interface InkModules {
  ink: typeof InkTypes;
  TextInput: typeof TextInputComponent;
}

let cached: InkModules | null = null;

export async function loadInk(): Promise<InkModules> {
  if (cached) return cached;
  const ink = (await eval('import("ink")')) as typeof InkTypes;
  const textInputModule = (await eval('import("ink-text-input")')) as {
    default: typeof TextInputComponent;
  };
  cached = { ink, TextInput: textInputModule.default };
  return cached;
}
