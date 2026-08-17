import { spawnSync } from "child_process";
import { CLI_PATH } from "./env";

/**
 * Direct, non-interactive invocation of the real compiled `grasp` binary —
 * for every command (or command surface) that doesn't need a real pty:
 * `--help`/`--version`, `grasp set/reset/export`, `grasp retry`, and the
 * non-interactive-stdin parts of `grasp init`/`grasp reset history` (both
 * use plain `readline` against stdin, which works correctly over a piped,
 * non-TTY input the same way a real human's line-by-line answers would —
 * see `src/init.ts`'s own doc comment on why a persistent `rl.on("line")`
 * listener was chosen specifically to make this reliable). Reserving the
 * real pty driver for the surfaces that actually need raw-mode TTY input
 * (`grasp review`/`grasp scan`) keeps this harness's overall run time down.
 */
export interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

export function runGraspCli(args: string[], opts: { cwd: string; env: Record<string, string>; input?: string }): CliResult {
  const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: opts.cwd,
    env: opts.env,
    input: opts.input ?? "",
    encoding: "utf-8",
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
