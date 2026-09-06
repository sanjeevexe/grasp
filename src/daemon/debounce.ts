/**
 * Per-project quiet-period timers.  GOVERNED BY: §7.2
 *
 * A filesystem watcher cannot know when an AI is "done" — it can only notice
 * writes stopping. Debounce is the primary signal; the syntax check (§7.3) is
 * the corrective one.
 *
 * The batch closes early when it exceeds `maxFilesPerBatch` or `maxDiffLines`,
 * so a mass refactor or a dependency install cannot produce one enormous call.
 */
export interface DebounceSettings {
  debounceMs: number;
  maxFilesPerBatch: number;
}

export type BatchCloseReason = "quiet" | "file_cap";

export interface PendingBatch {
  files: Map<string, { bytes: number; at: number }>;
  openedAt: number;
}

export class Debouncer {
  private timer: NodeJS.Timeout | undefined;
  private batch: PendingBatch = { files: new Map(), openedAt: Date.now() };

  constructor(
    private readonly settings: DebounceSettings,
    private readonly onClose: (batch: PendingBatch, reason: BatchCloseReason) => void,
  ) {}

  /** Any event in the project resets the timer (§7.2). */
  add(filePath: string, bytes: number, at = Date.now()): void {
    if (this.batch.files.size === 0) this.batch.openedAt = at;
    this.batch.files.set(filePath, { bytes, at });

    if (this.batch.files.size >= this.settings.maxFilesPerBatch) {
      this.close("file_cap");
      return;
    }

    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.close("quiet"), this.settings.debounceMs);
    // A pending batch must not hold the process open on its own.
    this.timer.unref?.();
  }

  /** Extend the quiet period — used when the syntax check says mid-write (§7.3). */
  extend(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.close("quiet"), this.settings.debounceMs);
    this.timer.unref?.();
  }

  close(reason: BatchCloseReason): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.batch.files.size === 0) return;
    const closed = this.batch;
    this.batch = { files: new Map(), openedAt: Date.now() };
    this.onClose(closed, reason);
  }

  get size(): number {
    return this.batch.files.size;
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
