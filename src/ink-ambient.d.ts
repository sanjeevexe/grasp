/**
 * Hand-written ambient type declarations for `ink` and `ink-text-input`,
 * covering only the API surface `grasp review` actually uses.
 *
 * Why hand-written rather than importing the packages' own .d.ts files:
 * both packages publish types only via a package.json `"exports"` map
 * (no legacy top-level `"types"`/`"main"` fallback `moduleResolution:
 * "node"` — this project's classic resolver — can follow). The fix that
 * actually works, `moduleResolution: "bundler"`, requires `module` to be
 * `"preserve"`/`"es2015"+`, which conflicts with this project's deliberate
 * `"module": "CommonJS"` (see DECISIONS.md's "TypeScript compiler target
 * and module system" entry) — not worth reopening for one dependency's
 * type resolution. These declarations are intentionally narrow and
 * somewhat loosely typed (not a full re-statement of ink's real types) —
 * they exist to unblock compilation for the specific components/hooks
 * used here, not to be a complete type-fidelity shim.
 */

declare module "ink" {
  import type { ReactNode } from "react";

  export type Key = {
    upArrow: boolean;
    downArrow: boolean;
    leftArrow: boolean;
    rightArrow: boolean;
    pageDown: boolean;
    pageUp: boolean;
    return: boolean;
    escape: boolean;
    ctrl: boolean;
    shift: boolean;
    tab: boolean;
    backspace: boolean;
    delete: boolean;
    meta: boolean;
  };

  export interface BoxProps {
    flexDirection?: "row" | "column" | "row-reverse" | "column-reverse";
    flexGrow?: number;
    flexShrink?: number;
    width?: number | string;
    height?: number | string;
    minHeight?: number;
    borderStyle?: "single" | "double" | "round" | "bold" | "classic";
    borderColor?: string;
    padding?: number;
    paddingX?: number;
    paddingY?: number;
    marginTop?: number;
    marginBottom?: number;
    gap?: number;
    children?: ReactNode;
  }
  export function Box(props: BoxProps): JSX.Element;

  export interface TextProps {
    color?: string;
    dimColor?: boolean;
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    wrap?: "wrap" | "truncate" | "truncate-start" | "truncate-middle" | "truncate-end";
    children?: ReactNode;
  }
  export function Text(props: TextProps): JSX.Element;

  export interface RenderOptions {
    stdout?: NodeJS.WriteStream;
    stdin?: NodeJS.ReadStream;
    exitOnCtrlC?: boolean;
  }
  export interface Instance {
    unmount: () => void;
    waitUntilExit: () => Promise<void>;
    clear: () => void;
  }
  export function render(node: ReactNode, options?: RenderOptions): Instance;

  export function useInput(
    handler: (input: string, key: Key) => void,
    options?: { isActive?: boolean }
  ): void;

  export function useApp(): { exit: (error?: Error) => void };
}

declare module "ink-text-input" {
  export interface TextInputProps {
    value: string;
    onChange: (value: string) => void;
    onSubmit?: (value: string) => void;
    placeholder?: string;
    focus?: boolean;
  }
  const TextInput: (props: TextInputProps) => JSX.Element;
  export default TextInput;
}
