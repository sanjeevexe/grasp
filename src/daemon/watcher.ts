/**
 * Per-project watcher and pipeline orchestration.  GOVERNED BY: §7.1, §7.2, §7.3, §8.3
 *
 * One chokidar watcher per registered project, all inside the single daemon
 * (§5.1). Events feed a debouncer; when the batch closes, the files are
 * syntax-checked, diffed against the checkpoint, and handed to the shared
 * pipeline.
 *
 * The checkpoint advances ONLY when the pipeline says the batch was terminal
 * (§8.3) — this file never decides that for itself.
 */
import fs from "node:fs";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import picomatch from "picomatch";
import type { DatabaseSync } from "node:sqlite";
import { advanceSnapshot, diffAgainstSnapshot, type FileDiff } from "../capture/snapshot.js";
import { estimateAuthorConfidence, type WriteEvent } from "../capture/authorHeuristics.js";
import { Debouncer, type PendingBatch } from "./debounce.js";
import {
  checkSyntax,
  isSourceFile,
  MAX_SYNTAX_RETRIES,
  type CommandRunner,
} from "./parsers/index.js";
import { runPipeline, type PipelineOutcome, type PipelineSettings } from "./pipeline.js";
import { toProjectRelative } from "../util/paths.js";
import type { GenerationDeps } from "../generation/generateQuestion.js";
import type { Logger } from "./logger.js";

export interface WatcherSettings extends PipelineSettings {
  debounceMs: number;
  maxFilesPerBatch: number;
}

export interface WatcherDeps extends GenerationDeps {
  logger?: Logger;
  runCommand?: CommandRunner;
  /** Test/compatibility escape hatch for environments where native watch handles are unavailable. */
  usePolling?: boolean;
  /** Fired once per closed batch that produced questions (§15 batching). */
  onQuestions?: (count: number, projectPath: string) => void;
}

export class ProjectWatcher {
  private watcher: FSWatcher | undefined;
  private readonly debouncer: Debouncer;
  private readonly events: WriteEvent[] = [];
  private syntaxRetries = 0;
  private processing: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: DatabaseSync,
    private readonly projectId: number,
    private readonly projectPath: string,
    private readonly settings: WatcherSettings,
    private readonly deps: WatcherDeps = {},
  ) {
    this.debouncer = new Debouncer(settings, (batch) => {
      // Serialize batches: two overlapping generation calls for one project
      // would race on the same checkpoint.
      this.processing = this.processing.then(async () => {
        await this.processBatch(batch);
      });
    });
  }

  start(): Promise<void> {
    const ignored = picomatch([
      "**/.git/**",
      "**/node_modules/**",
      ...this.settings.ignorePatterns,
    ]);

    this.watcher = chokidar.watch(this.projectPath, {
      // §7.1 — startup must not fire events for existing files.
      ignoreInitial: true,
      // Cheap first-line protection against reading a file mid-write, working
      // with the syntax check rather than instead of it (§7.1).
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
      usePolling: this.deps.usePolling,
      ignored: (target: string) => {
        const relative = toProjectRelative(this.projectPath, target);
        if (relative.startsWith("..")) return false;
        return relative !== "" && ignored(relative);
      },
    });

    const onChange = (filePath: string): void => {
      // §7.1 — only plausible source extensions ever enter the pipeline.
      if (!isSourceFile(filePath)) return;
      let bytes = 0;
      try {
        bytes = fs.statSync(filePath).size;
      } catch {
        return; // deleted between the event and the stat
      }
      const relative = toProjectRelative(this.projectPath, filePath);
      this.events.push({ path: relative, at: Date.now(), bytes });
      this.debouncer.add(relative, bytes);
    };

    this.watcher.on("add", onChange);
    this.watcher.on("change", onChange);

    // A newly-created file can otherwise be swallowed by chokidar's initial
    // scan when ignoreInitial is enabled. Callers that need a hard readiness
    // boundary (tests and lifecycle coordination) can await start().
    return new Promise((resolve) => {
      this.watcher?.once("ready", resolve);
    });
  }

  async stop(): Promise<void> {
    this.debouncer.dispose();
    await this.watcher?.close();
    await this.processing;
  }

  /** Exposed for tests: process one batch without waiting on the filesystem. */
  async processBatch(batch: PendingBatch): Promise<PipelineOutcome | null> {
    const relativePaths = [...batch.files.keys()];
    const contents = new Map<string, string>();

    for (const relative of relativePaths) {
      try {
        contents.set(relative, fs.readFileSync(path.join(this.projectPath, relative), "utf8"));
      } catch {
        // Deleted before we got to it; nothing to ask about.
      }
    }
    if (contents.size === 0) return null;

    // §7.3 — a file that does not parse is probably mid-write. Extend and
    // re-check, up to three times, then proceed anyway: the code may simply be
    // broken, and Grasp is not a linter.
    for (const [relative, content] of contents) {
      const result = await checkSyntax(
        path.join(this.projectPath, relative),
        content,
        this.deps.runCommand,
      );
      if (result === "invalid" && this.syntaxRetries < MAX_SYNTAX_RETRIES) {
        this.syntaxRetries += 1;
        this.deps.logger?.debug("file did not parse, extending the batch", {
          projectId: this.projectId,
          path: relative,
          attempt: this.syntaxRetries,
        });
        // Put the batch back and wait for the writer to finish.
        for (const [file, meta] of batch.files) this.debouncer.add(file, meta.bytes, meta.at);
        this.debouncer.extend();
        return null;
      }
    }
    this.syntaxRetries = 0;

    const diffs: FileDiff[] = [];
    for (const [relative, content] of contents) {
      const diff = diffAgainstSnapshot(this.projectPath, relative, content);
      if (diff) diffs.push(diff);
    }
    if (diffs.length === 0) return null;

    const outcome = await runPipeline(
      this.db,
      {
        projectId: this.projectId,
        files: diffs,
        origin: "live",
        // §7.6 — ordering signal only, never a suppression.
        authorConfidence: estimateAuthorConfidence(this.events.splice(0)),
      },
      this.settings,
      this.deps,
    );

    // §8.3 — the one rule, applied in one place.
    if (outcome.advanceCheckpoint) {
      for (const diff of diffs) advanceSnapshot(this.projectPath, diff.path, diff.content);
    }

    if (outcome.kind === "questions" && outcome.ids.length > 0) {
      this.deps.onQuestions?.(outcome.ids.length, this.projectPath);
    }

    return outcome;
  }
}
