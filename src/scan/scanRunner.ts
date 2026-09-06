/**
 * `grasp scan` — the onboarding walk.  GOVERNED BY: §12
 *
 * Only the trigger and the input differ from live capture; everything
 * downstream is the SHARED pipeline (§4.3, §12.1).
 *
 * `ignorePatterns` is the cheap first pass and the ONLY local filter here: §12.2
 * says NOT to apply the line-count threshold, because coverage is the goal in
 * scan mode and small files may matter. The generation call makes the real
 * "worth a question?" judgment (§9.2 step 1).
 */
import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { hashContent, type FileDiff } from "../capture/snapshot.js";
import { runPipeline, type PipelineSettings } from "../daemon/pipeline.js";
import { isSourceFile } from "../daemon/parsers/index.js";
import { getScanProgress, recordScanProgress } from "../storage/models/scanProgress.js";
import { listEligibleClusters } from "../storage/models/synthesisClusters.js";
import { collectSourceFiles } from "../util/walk.js";
import { toProjectRelative } from "../util/paths.js";
import { describeSection, splitIntoSections } from "./sections.js";
import type { GenerationDeps } from "../generation/generateQuestion.js";
import type { Logger } from "../daemon/logger.js";

export interface ScanSettings extends PipelineSettings {
  /** §8.4 — per-run cap; `--full` bypasses it with a warning. */
  scanQuestionsCap: number;
}

export interface ScanOptions {
  projectId: number;
  projectPath: string;
  /** §8.4 — bypasses the cap. The caller must already have confirmed. */
  full?: boolean;
  /** Live progress output (§12.2). */
  onProgress?: (line: string) => void;
  logger?: Logger;
}

export interface ScanResult {
  filesConsidered: number;
  filesScanned: number;
  filesSkippedUnchanged: number;
  questionsCreated: number;
  cappedOut: boolean;
  eligibleSynthesisTags: string[];
}

export async function runScan(
  db: DatabaseSync,
  options: ScanOptions,
  settings: ScanSettings,
  deps: GenerationDeps = {},
): Promise<ScanResult> {
  const files = collectSourceFiles(options.projectPath, settings.ignorePatterns, isSourceFile);
  const result: ScanResult = {
    filesConsidered: files.length,
    filesScanned: 0,
    filesSkippedUnchanged: 0,
    questionsCreated: 0,
    cappedOut: false,
    eligibleSynthesisTags: [],
  };

  // §12.2 — a capped run should end on a synthesis payoff rather than stranded
  // mid-file, so an already-eligible cluster is surfaced to the caller first.
  result.eligibleSynthesisTags = listEligibleClusters(db).map((cluster) => cluster.tag);

  const cap = options.full ? Number.POSITIVE_INFINITY : settings.scanQuestionsCap;

  for (const absolute of files) {
    if (result.questionsCreated >= cap) {
      result.cappedOut = true;
      break;
    }

    const relative = toProjectRelative(options.projectPath, absolute);
    let content: string;
    try {
      content = fs.readFileSync(absolute, "utf8");
    } catch {
      continue;
    }

    // §12.2 — an unchanged file_hash generates nothing; an edited file re-triggers.
    const hash = hashContent(content);
    const progress = getScanProgress(db, options.projectId, relative);
    const sections = splitIntoSections(content, absolute);

    if (progress?.file_hash === hash && progress.sections_completed >= sections.length) {
      result.filesSkippedUnchanged += 1;
      continue;
    }

    // Resumable: pick up at the first section this file has not completed (§12.2).
    const startAt = progress?.file_hash === hash ? progress.sections_completed : 0;

    for (let index = startAt; index < sections.length; index++) {
      if (result.questionsCreated >= cap) {
        result.cappedOut = true;
        break;
      }
      const section = sections[index];
      const label = describeSection(section);
      options.onProgress?.(
        `[${result.questionsCreated}/${options.full ? "∞" : settings.scanQuestionsCap}] ${relative}${label ? ` (${label})` : ""}`,
      );

      // The section is presented to the shared pipeline as one "file".
      const asFile: FileDiff = {
        path: relative,
        diff: section.content,
        content,
        added: section.content.split("\n").length,
        removed: 0,
        isNew: true,
      };

      // §12.2 — the pipeline applies only ignorePatterns for a scan origin.
      const outcome = await runPipeline(
        db,
        { projectId: options.projectId, files: [asFile], origin: "scan" },
        settings,
        deps,
      );

      if (outcome.kind === "questions") result.questionsCreated += outcome.ids.length;

      // Only record progress when the section reached a terminal state — the
      // same rule as the checkpoint (§8.3). A deferred or failed section must be
      // re-attempted on the next run, not skipped.
      if (outcome.advanceCheckpoint) {
        recordScanProgress(db, {
          project_id: options.projectId,
          file_path: relative,
          file_hash: hash,
          sections_completed: index + 1,
          sections_total: sections.length,
        });
      } else {
        options.logger?.info("scan section deferred", { path: relative, kind: outcome.kind });
        // Stop this file: a rate-limit deferral will hit the next section too.
        break;
      }
    }

    result.filesScanned += 1;
  }

  return result;
}
