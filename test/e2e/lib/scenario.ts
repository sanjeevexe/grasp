import { E2ELogger } from "./log";

/**
 * The "never stop on a failure" runner contract: each scenario is an
 * independent, self-contained unit (its own scratch home/repo, per the
 * task brief) run inside a try/catch here — a thrown assertion (or any
 * other error) is caught, logged as a BUG finding plus a scenario-failure
 * record, and the runner moves on to the next scenario. This is what makes
 * one run surface as many real issues as possible instead of stopping at
 * the first one.
 */

export interface ScenarioContext {
  logger: E2ELogger;
}

export type ScenarioFn = (ctx: ScenarioContext) => Promise<void>;

export interface Scenario {
  name: string;
  run: ScenarioFn;
}

export function scenario(name: string, run: ScenarioFn): Scenario {
  return { name, run };
}

export interface ScenarioRunOutcome {
  name: string;
  passed: boolean;
  ms: number;
}

export async function runScenario(s: Scenario, logger: E2ELogger): Promise<ScenarioRunOutcome> {
  const start = Date.now();
  try {
    await s.run({ logger });
    const ms = Date.now() - start;
    logger.recordPass(s.name, `${ms}ms`);
    process.stdout.write(`  PASS  ${s.name}  (${ms}ms)\n`);
    return { name: s.name, passed: true, ms };
  } catch (err) {
    const ms = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error && err.stack ? err.stack : "";
    logger.recordFail(s.name, `${message}${stack ? `\n${stack}` : ""}`);
    logger.bug(`Scenario did not complete: ${s.name}`, {
      area: s.name,
      steps: "See test/e2e/scenarios source for this scenario's exact steps.",
      expected: "The scenario runs to completion without throwing.",
      actual: `${message}${stack ? `\n\n\`\`\`\n${stack}\n\`\`\`` : ""}`,
      notes:
        "Could be a real Grasp bug the scenario's own assertion caught, or a bug in the harness itself — check whether the failure is a plain assert.* mismatch against Grasp's real output (a product finding) or an exception from the harness's own plumbing (a harness bug) before triaging.",
    });
    process.stdout.write(`  FAIL  ${s.name}  (${ms}ms): ${message}\n`);
    return { name: s.name, passed: false, ms };
  }
}
