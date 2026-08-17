import * as fs from "fs";
import * as path from "path";

/**
 * The run log — same entry format the prior TEST_LOG.md retest pass
 * established (see `git show test/full-retest:TEST_LOG.md`), written once
 * per run to `test/e2e/logs/run-<timestamp>.md` (gitignored — see this
 * repo's `.gitignore`; generated run output isn't committed, matching how
 * `prompts/logs/` and `loop_logs/*.log` are already handled).
 */

export type Severity = "BUG" | "DOC" | "NEEDS-HUMAN";

export interface LogEntryInput {
  severity: Severity;
  title: string;
  area: string;
  steps: string;
  expected: string;
  actual: string;
  notes?: string;
}

export interface ScenarioPassRecord {
  name: string;
  detail?: string;
}

export interface ScenarioFailRecord {
  name: string;
  error: string;
}

export class E2ELogger {
  private entries: LogEntryInput[] = [];
  private passes: ScenarioPassRecord[] = [];
  private fails: ScenarioFailRecord[] = [];
  private readonly startedAt = new Date();

  log(entry: LogEntryInput): void {
    this.entries.push(entry);
  }

  bug(title: string, details: Omit<LogEntryInput, "severity" | "title">): void {
    this.log({ severity: "BUG", title, ...details });
  }

  doc(title: string, details: Omit<LogEntryInput, "severity" | "title">): void {
    this.log({ severity: "DOC", title, ...details });
  }

  needsHuman(title: string, details: Omit<LogEntryInput, "severity" | "title">): void {
    this.log({ severity: "NEEDS-HUMAN", title, ...details });
  }

  recordPass(name: string, detail?: string): void {
    this.passes.push({ name, detail });
  }

  recordFail(name: string, error: string): void {
    this.fails.push({ name, error });
  }

  counts(): { bug: number; doc: number; needsHuman: number; scenariosPassed: number; scenariosFailed: number } {
    return {
      bug: this.entries.filter((e) => e.severity === "BUG").length,
      doc: this.entries.filter((e) => e.severity === "DOC").length,
      needsHuman: this.entries.filter((e) => e.severity === "NEEDS-HUMAN").length,
      scenariosPassed: this.passes.length,
      scenariosFailed: this.fails.length,
    };
  }

  /** Writes the full markdown log to `filePath`, creating its directory if needed. Returns the path for convenience. */
  write(filePath: string, meta: { branch: string; commit: string; claudeMode: string }): string {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    const counts = this.counts();
    const durationSec = ((Date.now() - this.startedAt.getTime()) / 1000).toFixed(1);

    const lines: string[] = [];
    lines.push(`# Grasp — PTY E2E Harness Run Log`, "");
    lines.push(
      `Run at ${this.startedAt.toISOString()}, branch \`${meta.branch}\` at \`${meta.commit}\`, claude mode: \`${meta.claudeMode}\`, duration ${durationSec}s.`,
      ""
    );
    lines.push(
      `**Summary:** ${counts.scenariosPassed} scenario(s) passed, ${counts.scenariosFailed} scenario(s) failed to run to completion, ` +
        `${counts.bug} \`BUG\`, ${counts.doc} \`DOC\`, ${counts.needsHuman} \`NEEDS-HUMAN\` finding(s) logged.`,
      ""
    );
    lines.push("---", "");

    if (this.entries.length > 0) {
      lines.push("## Findings", "");
      for (const entry of this.entries) {
        lines.push(`## [${entry.severity}] ${entry.title}`, "");
        lines.push(`**Area:** ${entry.area}`, "");
        lines.push(`**Steps to reproduce:** ${entry.steps}`, "");
        lines.push(`**Expected:** ${entry.expected}`, "");
        lines.push(`**Actual:** ${entry.actual}`, "");
        if (entry.notes) lines.push(`**Notes:** ${entry.notes}`, "");
        lines.push("");
      }
      lines.push("---", "");
    }

    if (this.fails.length > 0) {
      lines.push("## Scenarios that did not run to completion (harness caught the error, moved on)", "");
      for (const fail of this.fails) {
        lines.push(`- **${fail.name}**: ${fail.error}`);
      }
      lines.push("", "---", "");
    }

    lines.push("## Clean passes", "", "Logged explicitly per this harness's own logging convention — a scenario finishing", "with no findings is a real, recorded result, not an implicit non-event.", "");
    for (const pass of this.passes) {
      lines.push(`- **${pass.name}**${pass.detail ? ` — ${pass.detail}` : ""}`);
    }
    lines.push("");

    const content = lines.join("\n");
    fs.writeFileSync(filePath, content, "utf-8");
    return filePath;
  }
}
