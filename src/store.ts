import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { DB_PATH, GRASP_HOME } from "./paths";
import { CapturedDiff, DiffFile } from "./adapters/agentAdapter";
import { ConceptTagGlobalRow, ConceptTagRecord, EventRecord, EventSource } from "./types";
import { countChunksForLineCount } from "./scanChunking";

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    repo TEXT NOT NULL,
    session_id TEXT,
    diff_hash TEXT,
    diff_summary TEXT,
    question_concept TEXT,
    question_instance TEXT,
    question_type TEXT,
    generation_source TEXT,
    miss_reason TEXT,
    answer_concept TEXT,
    answer_instance TEXT,
    skipped INTEGER NOT NULL DEFAULT 0,
    skip_reason TEXT,
    cost_usd REAL,
    cost_unknown INTEGER NOT NULL DEFAULT 0,
    diff_files_json TEXT,
    sample_answer_concept TEXT,
    sample_answer_instance TEXT,
    concept_explanation TEXT,
    -- 'diff' (an AI-agent change) or 'scan' (grasp scan reading existing
    -- code) — see DECISIONS.md's "grasp scan: storage design" entry. DEFAULT
    -- backfills every pre-scan row to 'diff' for free on migration. For a
    -- scan row, diff_summary is repurposed to hold the scanned file's path
    -- (diff_hash/diff_files_json stay NULL — there's no diff).
    source TEXT NOT NULL DEFAULT 'diff',
    -- The §4 cited-excerpt contract for a scan-sourced instance question,
    -- computed and clamped once at generation time (computeValidatedExcerpt,
    -- generation.ts) and persisted verbatim — never re-derived from disk
    -- later, since a scan question can sit pending across multiple separate
    -- \`grasp scan\` invocations and the file could change in between. All
    -- three are NULL together whenever there's nothing to show.
    scan_excerpt_start_line INTEGER,
    scan_excerpt_end_line INTEGER,
    scan_excerpt_lines_json TEXT
  );

  CREATE TABLE IF NOT EXISTS concept_tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL REFERENCES events(id),
    tag TEXT NOT NULL,
    answered INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_concept_tags_tag ON concept_tags(tag);

  -- idx_events_session_id is NOT created here: on a pre-Phase-5 database,
  -- the events table exists without the session_id column at this point
  -- (CREATE TABLE IF NOT EXISTS above is a no-op for it), and this file
  -- runs unconditionally on every openStore() call — creating an index on
  -- a column that may not exist yet would fail before migrateSchema() gets
  -- a chance to add it. See migrateSchema() below, which creates this
  -- index only after confirming/adding the column, safe for both fresh
  -- and pre-existing databases.

  -- Claude Code turn tracking: bridges hook firings, which are separate
  -- short-lived process invocations with no shared memory, into durable
  -- state keyed by Claude Code's own (session_id, prompt_id). See
  -- DECISIONS.md's "ClaudeCodeAdapter: session-state persistence across
  -- hook invocations" entry.
  CREATE TABLE IF NOT EXISTS cc_turns (
    session_id TEXT NOT NULL,
    prompt_id TEXT NOT NULL,
    repo TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    PRIMARY KEY (session_id, prompt_id)
  );

  -- Diffs captured via PostToolUse during a turn, pending whatever Phase 5
  -- eventually does with them. Not the same table as \`events\` — \`events\`
  -- is reserved for actual question/miss rows (brief §3.5); a raw capture
  -- that never becomes a question doesn't belong there. \`filtered\`/
  -- \`filter_reason\` record Phase 4's mechanical-filter verdict on this
  -- capture — see DECISIONS.md's "Filtered-diff recording" entry: a
  -- filtered-out capture is still recorded here, never silently dropped.
  -- \`resolved\`/\`significant_files_json\` back the Prompt-3 batched-at-Stop
  -- generation redesign (see DECISIONS.md's "Batched-at-Stop generation:
  -- resolved tracking" entry). \`significant_files_json\` is the Phase 4
  -- filter's \`significantFiles\` verdict for this capture, persisted at
  -- capture time (not recomputed later — recomputing at Stop time would mean
  -- re-reading files off disk that may have moved on since, per the
  -- generated-file-detection 4KB-read check) — non-null exactly when
  -- \`filtered = 0\`. \`resolved\` starts 0 and is flipped to 1 only once a
  -- batched generation attempt that covered this row concludes with a real
  -- outcome (a question, a legitimate "not worth asking", or a genuine
  -- question-cap hit) — never on a failed/timed-out attempt, so an
  -- unresolved row is retried by a later batch instead of lost.
  CREATE TABLE IF NOT EXISTS captured_diffs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    prompt_id TEXT NOT NULL,
    repo TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    diff_json TEXT NOT NULL,
    filtered INTEGER NOT NULL DEFAULT 0,
    filter_reason TEXT,
    resolved INTEGER NOT NULL DEFAULT 0,
    significant_files_json TEXT,
    FOREIGN KEY (session_id, prompt_id) REFERENCES cc_turns(session_id, prompt_id)
  );

  CREATE INDEX IF NOT EXISTS idx_captured_diffs_turn ON captured_diffs(session_id, prompt_id);

  -- idx_captured_diffs_pending is NOT created here: on a pre-Prompt-3
  -- database, captured_diffs exists without the resolved column at this
  -- point (CREATE TABLE IF NOT EXISTS above is a no-op for it), and this
  -- file runs unconditionally on every openStore() call — creating an
  -- index on a column that may not exist yet would fail before
  -- migrateSchema() gets a chance to add it. See migrateSchema() below,
  -- which creates this index only after confirming/adding the column,
  -- safe for both fresh and pre-existing databases.

  -- Append-only audit trail of every hook firing Grasp observed. Exists
  -- because hook stdout isn't surfaced to the user, so this is the only
  -- durable, inspectable way to confirm hook behavior (e.g. that Stop
  -- really fired once per turn, not once per tool call).
  CREATE TABLE IF NOT EXISTS hook_invocations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    prompt_id TEXT NOT NULL,
    event_name TEXT NOT NULL,
    invoked_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_hook_invocations_turn ON hook_invocations(session_id, prompt_id, event_name);

  -- One row per (session_id, repo): the tree SHA of the working-tree
  -- snapshot the most recent capture for that session+repo was diffed up
  -- TO — i.e. "everything Grasp has already looked at." Read/advanced by
  -- ClaudeCodeAdapter's checkpoint-based incremental capture, which diffs
  -- each new PostToolUse firing against this instead of always against
  -- HEAD. See DECISIONS.md's "Checkpoint-based incremental capture" entry.
  CREATE TABLE IF NOT EXISTS capture_checkpoints (
    session_id TEXT NOT NULL,
    repo TEXT NOT NULL,
    tree_sha TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (session_id, repo)
  );

  -- At most one open row per session_id: a mutex, not a log. Held for the
  -- duration of one runGeneration call so the cap checks it does (cost +
  -- question count) always see every EARLIER call's already-committed
  -- result for this session, instead of racing them. See DECISIONS.md's
  -- "Atomic cap enforcement: per-session generation reservation" entry.
  CREATE TABLE IF NOT EXISTS generation_reservations (
    session_id TEXT PRIMARY KEY,
    claimed_at TEXT NOT NULL,
    token TEXT NOT NULL
  );

  -- \`grasp scan\`'s file-walk resumability, tracked at CHUNK granularity
  -- (see DECISIONS.md's "grasp scan: chunking for large files" entry) — one
  -- row per (repo, file_path, chunk_index) Grasp has ever looked at during a
  -- scan, permanently — no content hash or mtime tracking, so an
  -- already-covered chunk is never revisited even if the file is edited
  -- later (that's the diff-capture side's job in general, and
  -- \`scan_file_hashes\`'s whole-file-hash re-scan specifically once that's
  -- built). \`is_final_chunk\` marks the row that completes a file's walk —
  -- either the file's genuine last chunk (shorter than a full
  -- MAX_SCAN_CHUNK_LINES, or the file's only chunk) or a mechanically-skipped
  -- file's sole chunk_index=0 row (ignored/generated/binary/oversized — see
  -- scan.ts's classifyFile) — so "is this file's walk complete" is a single
  -- indexed lookup (\`EXISTS ... is_final_chunk = 1\`) that never needs to
  -- re-read the file off disk to answer, for a file that's already fully
  -- covered. A second \`grasp scan\` run continues from whatever chunk index
  -- comes after the highest one already recorded for a file with no
  -- is_final_chunk row yet.
  CREATE TABLE IF NOT EXISTS scan_progress (
    repo TEXT NOT NULL,
    file_path TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    is_final_chunk INTEGER NOT NULL DEFAULT 0,
    scanned_at TEXT NOT NULL,
    PRIMARY KEY (repo, file_path, chunk_index)
  );

  -- idx_scan_progress_final is NOT created here, same reason as
  -- idx_events_session_id/idx_captured_diffs_pending above: on a
  -- pre-chunking database scan_progress already exists without
  -- chunk_index/is_final_chunk at this point (CREATE TABLE IF NOT EXISTS is
  -- a no-op for it), so creating an index on those columns here would fail
  -- before migrateSchema() gets a chance to add them. Created only inside
  -- migrateSchema(), after the migration below runs.
`;

/**
 * Adds columns to tables that already existed before the phase that
 * introduced them, for databases created by an earlier install. `CREATE
 * TABLE IF NOT EXISTS` in SCHEMA_SQL only covers brand-new databases; a
 * table that already exists keeps its original columns until migrated
 * explicitly.
 */
function migrateSchema(db: Database.Database): void {
  const capturedDiffsColumns = db.prepare(`PRAGMA table_info(captured_diffs)`).all() as Array<{
    name: string;
  }>;
  const capturedDiffsColumnNames = new Set(capturedDiffsColumns.map((c) => c.name));
  if (!capturedDiffsColumnNames.has("filtered")) {
    db.exec(`ALTER TABLE captured_diffs ADD COLUMN filtered INTEGER NOT NULL DEFAULT 0`);
  }
  if (!capturedDiffsColumnNames.has("filter_reason")) {
    db.exec(`ALTER TABLE captured_diffs ADD COLUMN filter_reason TEXT`);
  }
  if (!capturedDiffsColumnNames.has("resolved")) {
    db.exec(`ALTER TABLE captured_diffs ADD COLUMN resolved INTEGER NOT NULL DEFAULT 0`);
  }
  if (!capturedDiffsColumnNames.has("significant_files_json")) {
    db.exec(`ALTER TABLE captured_diffs ADD COLUMN significant_files_json TEXT`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_captured_diffs_pending ON captured_diffs(session_id, repo, filtered, resolved)`);

  const eventsColumns = db.prepare(`PRAGMA table_info(events)`).all() as Array<{ name: string }>;
  const eventsColumnNames = new Set(eventsColumns.map((c) => c.name));
  if (!eventsColumnNames.has("session_id")) {
    db.exec(`ALTER TABLE events ADD COLUMN session_id TEXT`);
  }
  if (!eventsColumnNames.has("diff_files_json")) {
    db.exec(`ALTER TABLE events ADD COLUMN diff_files_json TEXT`);
  }
  if (!eventsColumnNames.has("cost_unknown")) {
    db.exec(`ALTER TABLE events ADD COLUMN cost_unknown INTEGER NOT NULL DEFAULT 0`);
  }
  if (!eventsColumnNames.has("sample_answer_concept")) {
    db.exec(`ALTER TABLE events ADD COLUMN sample_answer_concept TEXT`);
  }
  if (!eventsColumnNames.has("sample_answer_instance")) {
    db.exec(`ALTER TABLE events ADD COLUMN sample_answer_instance TEXT`);
  }
  if (!eventsColumnNames.has("concept_explanation")) {
    db.exec(`ALTER TABLE events ADD COLUMN concept_explanation TEXT`);
  }
  if (!eventsColumnNames.has("source")) {
    db.exec(`ALTER TABLE events ADD COLUMN source TEXT NOT NULL DEFAULT 'diff'`);
  }
  if (!eventsColumnNames.has("scan_excerpt_start_line")) {
    db.exec(`ALTER TABLE events ADD COLUMN scan_excerpt_start_line INTEGER`);
  }
  if (!eventsColumnNames.has("scan_excerpt_end_line")) {
    db.exec(`ALTER TABLE events ADD COLUMN scan_excerpt_end_line INTEGER`);
  }
  if (!eventsColumnNames.has("scan_excerpt_lines_json")) {
    db.exec(`ALTER TABLE events ADD COLUMN scan_excerpt_lines_json TEXT`);
  }
  // Unconditional (not just inside the branch above): on a fresh install
  // SCHEMA_SQL's CREATE TABLE already includes session_id, so the ALTER
  // above is skipped, but the index still needs creating exactly once —
  // IF NOT EXISTS makes this safe to run every time regardless of path.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_events_session_id ON events(session_id)`);

  const reservationColumns = db.prepare(`PRAGMA table_info(generation_reservations)`).all() as Array<{
    name: string;
  }>;
  if (!reservationColumns.some((c) => c.name === "token")) {
    // NOT NULL requires a DEFAULT for SQLite's ADD COLUMN on a non-empty
    // table. An empty-string token can never match a real claimer's own
    // (non-empty, randomly generated) token, so any reservation row that
    // predates this migration simply can't be released by ownership check —
    // it can only be reclaimed once genuinely stale, same self-heal path as
    // any other abandoned reservation. See tryClaimGenerationSlot/
    // releaseGenerationSlot's own comments for why ownership matters at all.
    db.exec(`ALTER TABLE generation_reservations ADD COLUMN token TEXT NOT NULL DEFAULT ''`);
  }

  migrateScanProgressToChunkGranularity(db);
}

/**
 * Migrates a pre-chunking `scan_progress` table — one row per (repo,
 * file_path), meaning "this file was already fully scanned" under the old
 * whole-file model — to the chunk-granularity schema. See DECISIONS.md's
 * "grasp scan: chunking for large files" entry for the open design point
 * this resolves: each old row is expanded into every chunk the file
 * CURRENTLY has on disk (not just chunk_index=0), so the schema change
 * doesn't trigger stale reprocessing of a file that was already fully
 * covered. SQLite can't add/change a PRIMARY KEY via ALTER TABLE, so this
 * renames the old table aside, creates the new-shape table fresh (already
 * covered by SCHEMA_SQL's own CREATE TABLE IF NOT EXISTS, but re-asserted
 * here defensively in case this function is ever called out of order), and
 * migrates rows across in one transaction.
 */
function migrateScanProgressToChunkGranularity(db: Database.Database): void {
  const scanProgressColumns = db.prepare(`PRAGMA table_info(scan_progress)`).all() as Array<{ name: string }>;
  const hasChunkIndex = scanProgressColumns.some((c) => c.name === "chunk_index");
  if (!hasChunkIndex) {
    const oldRows = db.prepare(`SELECT repo, file_path, scanned_at FROM scan_progress`).all() as Array<{
      repo: string;
      file_path: string;
      scanned_at: string;
    }>;

    const migrate = db.transaction(() => {
      db.exec(`ALTER TABLE scan_progress RENAME TO scan_progress_pre_chunking`);
      db.exec(`
        CREATE TABLE scan_progress (
          repo TEXT NOT NULL,
          file_path TEXT NOT NULL,
          chunk_index INTEGER NOT NULL,
          is_final_chunk INTEGER NOT NULL DEFAULT 0,
          scanned_at TEXT NOT NULL,
          PRIMARY KEY (repo, file_path, chunk_index)
        )
      `);
      const insert = db.prepare(
        `INSERT INTO scan_progress (repo, file_path, chunk_index, is_final_chunk, scanned_at) VALUES (?, ?, ?, ?, ?)`
      );
      for (const row of oldRows) {
        const chunkCount = countCurrentChunkCountForMigration(row.repo, row.file_path);
        for (let i = 0; i < chunkCount; i++) {
          insert.run(row.repo, row.file_path, i, i === chunkCount - 1 ? 1 : 0, row.scanned_at);
        }
      }
      db.exec(`DROP TABLE scan_progress_pre_chunking`);
    });
    migrate();
  }

  db.exec(`CREATE INDEX IF NOT EXISTS idx_scan_progress_final ON scan_progress(repo, file_path, is_final_chunk)`);
}

/**
 * Reads a migrated file's CURRENT on-disk line count to compute how many
 * chunks it now has — "given its current on-disk size," per the migration's
 * own requirement, not the size it happened to be when originally scanned.
 * Falls back to 1 (a single, already-final chunk) when the file can't be
 * read at all (deleted, moved, or — since this DB is global across every
 * repo Grasp has ever touched, not just ones present on this machine right
 * now — a repo that simply isn't checked out here): the safe, minimal
 * default that still satisfies "don't trigger stale reprocessing" without
 * needing real content to reason about.
 */
function countCurrentChunkCountForMigration(repo: string, filePath: string): number {
  try {
    const content = fs.readFileSync(path.join(repo, filePath), "utf-8");
    const lineCount = content.split(/\r\n|\r|\n/).length;
    return countChunksForLineCount(lineCount);
  } catch {
    return 1;
  }
}

/**
 * How long a connection waits on a lock held by another Grasp process
 * before giving up. WAL mode (below) already lets readers proceed
 * concurrently with a writer, but two WRITERS (e.g. two hook firings for
 * overlapping tool calls, or a hook firing while `grasp review` is
 * mid-answer) can still contend for SQLite's single write lock.
 * better-sqlite3 already defaults its own internal busy-wait to 5000ms even
 * without this — verified by reading its source, not assumed — so this
 * pragma is set explicitly anyway: it makes the timeout an intentional,
 * documented, easily-tunable product decision instead of an implicit
 * dependency default a future reader wouldn't know exists (and one a future
 * major version of better-sqlite3 could silently change), and 10s gives
 * modest extra headroom over that default for a loaded machine. See
 * DECISIONS.md's "SQLite busy_timeout" entry for the full empirical story,
 * including a real edge case this does NOT fully close (many processes
 * racing to create/WAL-ify a brand-new database file simultaneously) and
 * why that gap doesn't matter for Grasp's actual architecture.
 */
const BUSY_TIMEOUT_MS = 10000;

export function openStore(dbPath: string = DB_PATH): Database.Database {
  fs.mkdirSync(GRASP_HOME, { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.exec(SCHEMA_SQL);
  migrateSchema(db);
  return db;
}

function toEventRow(event: EventRecord) {
  return {
    timestamp: event.timestamp,
    repo: event.repo,
    sessionId: event.sessionId,
    diffHash: event.diffHash,
    diffSummary: event.diffSummary,
    questionConcept: event.questionConcept,
    questionInstance: event.questionInstance,
    questionType: event.questionType,
    generationSource: event.generationSource,
    missReason: event.missReason,
    answerConcept: event.answerConcept,
    answerInstance: event.answerInstance,
    skipped: event.skipped ? 1 : 0,
    skipReason: event.skipReason,
    costUsd: event.costUsd,
    costUnknown: event.costUnknown ? 1 : 0,
    diffFilesJson: event.diffFiles ? JSON.stringify(event.diffFiles) : null,
    sampleAnswerConcept: event.sampleAnswerConcept ?? null,
    sampleAnswerInstance: event.sampleAnswerInstance ?? null,
    conceptExplanation: event.conceptExplanation ?? null,
    source: event.source ?? "diff",
    scanExcerptStartLine: event.scanExcerptStartLine ?? null,
    scanExcerptEndLine: event.scanExcerptEndLine ?? null,
    scanExcerptLinesJson: event.scanExcerptLines ? JSON.stringify(event.scanExcerptLines) : null,
  };
}

function fromEventRow(row: any): EventRecord {
  return {
    id: row.id,
    timestamp: row.timestamp,
    repo: row.repo,
    sessionId: row.session_id,
    diffHash: row.diff_hash,
    diffSummary: row.diff_summary,
    questionConcept: row.question_concept,
    questionInstance: row.question_instance,
    questionType: row.question_type,
    generationSource: row.generation_source,
    missReason: row.miss_reason,
    answerConcept: row.answer_concept,
    answerInstance: row.answer_instance,
    skipped: Boolean(row.skipped),
    skipReason: row.skip_reason,
    costUsd: row.cost_usd,
    costUnknown: Boolean(row.cost_unknown),
    diffFiles: row.diff_files_json ? JSON.parse(row.diff_files_json) : null,
    sampleAnswerConcept: row.sample_answer_concept,
    sampleAnswerInstance: row.sample_answer_instance,
    conceptExplanation: row.concept_explanation,
    source: row.source,
    scanExcerptStartLine: row.scan_excerpt_start_line,
    scanExcerptEndLine: row.scan_excerpt_end_line,
    scanExcerptLines: row.scan_excerpt_lines_json ? JSON.parse(row.scan_excerpt_lines_json) : null,
  };
}

/**
 * Inserts one event row plus any linked concept_tags rows, in a single
 * transaction. Returns the new event's id.
 */
export function insertEvent(
  db: Database.Database,
  event: EventRecord,
  tags: Array<Pick<ConceptTagRecord, "tag" | "answered">> = []
): number {
  const insertEventStmt = db.prepare(`
    INSERT INTO events (
      timestamp, repo, session_id, diff_hash, diff_summary,
      question_concept, question_instance, question_type, generation_source,
      miss_reason, answer_concept, answer_instance,
      skipped, skip_reason, cost_usd, cost_unknown, diff_files_json,
      sample_answer_concept, sample_answer_instance, concept_explanation,
      source, scan_excerpt_start_line, scan_excerpt_end_line, scan_excerpt_lines_json
    ) VALUES (
      @timestamp, @repo, @sessionId, @diffHash, @diffSummary,
      @questionConcept, @questionInstance, @questionType, @generationSource,
      @missReason, @answerConcept, @answerInstance,
      @skipped, @skipReason, @costUsd, @costUnknown, @diffFilesJson,
      @sampleAnswerConcept, @sampleAnswerInstance, @conceptExplanation,
      @source, @scanExcerptStartLine, @scanExcerptEndLine, @scanExcerptLinesJson
    )
  `);
  const insertTagStmt = db.prepare(
    `INSERT INTO concept_tags (event_id, tag, answered) VALUES (?, ?, ?)`
  );

  const runInTransaction = db.transaction(
    (evt: EventRecord, tagList: Array<Pick<ConceptTagRecord, "tag" | "answered">>) => {
      const info = insertEventStmt.run(toEventRow(evt));
      const eventId = Number(info.lastInsertRowid);
      for (const tag of tagList) {
        insertTagStmt.run(eventId, tag.tag, tag.answered ? 1 : 0);
      }
      return eventId;
    }
  );

  return runInTransaction(event, tags);
}

export function getEventById(db: Database.Database, id: number): EventRecord | undefined {
  const row = db.prepare(`SELECT * FROM events WHERE id = ?`).get(id);
  return row ? fromEventRow(row) : undefined;
}

export function getEventsByRepo(db: Database.Database, repo: string): EventRecord[] {
  const rows = db
    .prepare(`SELECT * FROM events WHERE repo = ? ORDER BY timestamp ASC`)
    .all(repo);
  return rows.map(fromEventRow);
}

/**
 * Every event row across every repo, oldest first — the "everything in the
 * events table" query `grasp export`'s three shapes all start from (see
 * export.ts). Distinct from `getEventsByRepo` (one repo) and
 * `getPendingQuestions` (only unanswered/unskipped) — export intentionally
 * wants every row regardless of repo or answered/skipped/miss status, each
 * shape then narrows/reshapes it independently.
 */
export function getAllEvents(db: Database.Database): EventRecord[] {
  const rows = db.prepare(`SELECT * FROM events ORDER BY timestamp ASC`).all();
  return rows.map(fromEventRow);
}

/**
 * Every column of every `events` row, completely unmapped/uncurated —
 * exactly what `grasp export --raw` promises ("the escape hatch for anyone
 * who wants everything"). Deliberately bypasses `fromEventRow` (which
 * reshapes/renames columns for the rest of the codebase's convenience) so
 * the raw export's column names match the actual schema 1:1.
 */
export function getAllEventsRawRows(db: Database.Database): Record<string, unknown>[] {
  return db.prepare(`SELECT * FROM events ORDER BY timestamp ASC`).all() as Record<string, unknown>[];
}

/**
 * All concept_tags rows for every event, grouped by event_id — the batch
 * counterpart to `getConceptTagsByEventId` (single event) used by
 * `grasp export`'s default/`--anki` shapes so they don't run one query per
 * event row.
 */
export function getConceptTagsGroupedByEvent(db: Database.Database): Map<number, string[]> {
  const rows = db.prepare(`SELECT event_id, tag FROM concept_tags ORDER BY id ASC`).all() as Array<{
    event_id: number;
    tag: string;
  }>;
  const grouped = new Map<number, string[]>();
  for (const row of rows) {
    const existing = grouped.get(row.event_id);
    if (existing) {
      existing.push(row.tag);
    } else {
      grouped.set(row.event_id, [row.tag]);
    }
  }
  return grouped;
}

export function getConceptTagsByEventId(
  db: Database.Database,
  eventId: number
): ConceptTagRecord[] {
  const rows = db
    .prepare(`SELECT * FROM concept_tags WHERE event_id = ?`)
    .all(eventId) as any[];
  return rows.map((row) => ({
    id: row.id,
    eventId: row.event_id,
    tag: row.tag,
    answered: Boolean(row.answered),
  }));
}

/**
 * Marks every concept_tags row linked to this event as answered, and
 * records the answer text on the event itself. Originally written to back
 * `debug:answer` (Phase 5) as a stand-in for real answering; Phase 7's
 * `grasp review` now calls this directly for genuine user answers too —
 * same function, not duplicated, per DECISIONS.md's memoization-wiring
 * note. Returns the tags that were updated (empty if the event had none,
 * e.g. a miss row — though `review` never calls this on a miss).
 */
export function markEventAnswered(
  db: Database.Database,
  eventId: number,
  answers: { answerConcept: string | null; answerInstance: string | null }
): string[] {
  const tags = getConceptTagsByEventId(db, eventId);

  const runInTransaction = db.transaction(() => {
    db.prepare(`UPDATE concept_tags SET answered = 1 WHERE event_id = ?`).run(eventId);
    db.prepare(`UPDATE events SET answer_concept = ?, answer_instance = ? WHERE id = ?`).run(
      answers.answerConcept,
      answers.answerInstance,
      eventId
    );
  });
  runInTransaction();

  return tags.map((t) => t.tag);
}

/**
 * Marks a concept tag learned the moment the CONCEPT phase specifically
 * concludes with a real, non-blank answer — independent of what happens to
 * the instance phase afterward (it may still end up declined). Also writes
 * `answer_concept` immediately, so a partial answer survives even if the
 * event later ends up recorded skipped (e.g. instance declined twice) — see
 * DECISIONS.md's "grasp review: explain-then-retry skip flow" entry for why
 * concept-tag memoization and the event's overall skipped/answered
 * disposition are no longer the same moment now that each phase can resolve
 * independently via its own retry attempt.
 */
export function markConceptAnswered(db: Database.Database, eventId: number, answerConcept: string): void {
  const runInTransaction = db.transaction(() => {
    db.prepare(`UPDATE concept_tags SET answered = 1 WHERE event_id = ?`).run(eventId);
    db.prepare(`UPDATE events SET answer_concept = ? WHERE id = ?`).run(answerConcept, eventId);
  });
  runInTransaction();
}

/**
 * Writes a real, non-blank instance answer. This is what actually takes an
 * event out of "pending" (see `PENDING_QUESTION_WHERE`'s `answer_instance IS
 * NULL` check) — the instance phase is always the last phase in `grasp
 * review`'s concept-then-instance sequence, so this is called once, at most,
 * per event.
 */
export function markInstanceAnswered(db: Database.Database, eventId: number, answerInstance: string): void {
  db.prepare(`UPDATE events SET answer_instance = ? WHERE id = ?`).run(answerInstance, eventId);
}

/**
 * Marks an event skipped — called once, when the instance phase (always the
 * last phase) is declined for good, whether that's an old-style immediate
 * decline (legacy event, no explanation to retry against) or the terminal
 * decline after a retry attempt. Does not touch `answer_concept`: if the
 * concept phase was separately answered for real first, `markConceptAnswered`
 * already persisted it, and this call must not clobber that partial answer.
 * `skip_reason` is deliberately never written here — the interactive
 * "why are you skipping?" free-text prompt was removed in favor of the
 * explain-then-retry flow (see DECISIONS.md's "grasp review: explain-then-
 * retry skip flow" entry); the column stays in the schema only so existing
 * historical rows that already have a reason keep it.
 */
export function markEventSkipped(db: Database.Database, eventId: number): void {
  db.prepare(`UPDATE events SET skipped = 1 WHERE id = ?`).run(eventId);
}

const PENDING_QUESTION_WHERE = `
  question_type IS NOT NULL
  AND skipped = 0
  AND answer_instance IS NULL
`;

/**
 * Every real (non-miss), unanswered, unskipped question, optionally narrowed
 * to one repo and/or one `source`. `repoRoot` omitted (or undefined)
 * preserves the original all-repos behavior `grasp review --all` now relies
 * on; passed, it adds a `repo = ?` condition on top of the same
 * `PENDING_QUESTION_WHERE` definition — this does NOT change what counts as
 * "pending" (concept-tag memoization stays global, untouched by this — see
 * DECISIONS.md's `grasp scan` entries), only which already-pending rows get
 * returned. See DECISIONS.md's "grasp review defaults to the current repo"
 * entry, which supersedes the earlier "query scope: global" entry now that a
 * real dogfooding session showed the global default actively confusing
 * users. `answer_instance IS NULL` alone is a reliable "not yet answered"
 * check: every real question (question_type "both" or "instance") always
 * has a non-null question_instance and gets it answered last in `review`'s
 * concept-then-instance sequence, so it's null iff the event is still
 * pending regardless of question_type.
 *
 * `source` omitted (or undefined) returns pending questions of EVERY source
 * — what `grasp export` wants. `grasp review` always passes `"diff"` and
 * `grasp scan` always passes `"scan"`, so each command only ever surfaces
 * its own kind of pending question, per DECISIONS.md's "grasp scan:
 * presentation model" entry — the underlying storage stays fully shared,
 * this only narrows what a given command's own query returns.
 */
export function getPendingQuestions(db: Database.Database, repoRoot?: string, source?: EventSource): EventRecord[] {
  const conditions = [PENDING_QUESTION_WHERE];
  const params: string[] = [];
  if (repoRoot !== undefined) {
    conditions.push(`repo = ?`);
    params.push(repoRoot);
  }
  if (source !== undefined) {
    conditions.push(`source = ?`);
    params.push(source);
  }
  const rows = db
    .prepare(`SELECT * FROM events WHERE ${conditions.join(" AND ")} ORDER BY timestamp ASC`)
    .all(...params);
  return rows.map(fromEventRow);
}

/**
 * Same "pending question" definition, scoped to one Claude Code
 * `session_id` — what the `Stop` nudge uses (see DECISIONS.md's
 * "gate-check scope" entry): whether *this session's own* work has an
 * unanswered question outstanding, not whether the user has anything
 * pending anywhere. The nudge is informational only (never blocks), so it
 * intentionally counts everything regardless of age — see
 * `getBlockingPendingQuestionsForSession` below for the narrower,
 * age-limited definition the hard-gate check itself uses.
 */
export function getPendingQuestionsForSession(
  db: Database.Database,
  sessionId: string
): EventRecord[] {
  const rows = db
    .prepare(
      `SELECT * FROM events WHERE ${PENDING_QUESTION_WHERE} AND session_id = ? ORDER BY timestamp ASC`
    )
    .all(sessionId);
  return rows.map(fromEventRow);
}

/**
 * How old a pending question can be and still actively deny a tool call
 * under hard-gate mode. README/TESTING_GUIDE both document hard-gate as
 * scoped to "that specific session" and explicitly promise it "never
 * blocks you over something left over from a different day" — but a Claude
 * Code `session_id` can genuinely be resumed days or weeks later (e.g.
 * `claude --resume`), so `session_id` scoping alone doesn't actually
 * guarantee that. This is Grasp's own gap-filling choice (not settled by
 * the brief): 24 hours is a deliberately generous, simple "still basically
 * the same sitting" cutoff — long enough to never interrupt a same-day
 * session picked back up after a break, short enough that a session
 * abandoned and resumed on a different calendar day reliably falls outside
 * it. See DECISIONS.md's "Stale pending question cutoff" entry.
 */
export const HARD_GATE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * The narrower definition of "pending" the `PreToolUse` hard-gate check
 * uses: real, unanswered, unskipped questions for this session AND recent
 * enough (within `HARD_GATE_MAX_AGE_MS`) to still actively block. An old
 * question outside that window remains fully visible and answerable in
 * `grasp review` and still counts toward the `Stop` nudge
 * (`getPendingQuestionsForSession` above) — this function only narrows
 * what's allowed to DENY a tool call, never what's shown or answerable.
 */
export function getBlockingPendingQuestionsForSession(
  db: Database.Database,
  sessionId: string,
  now: Date = new Date()
): EventRecord[] {
  const cutoff = new Date(now.getTime() - HARD_GATE_MAX_AGE_MS).toISOString();
  const rows = db
    .prepare(
      `SELECT * FROM events WHERE ${PENDING_QUESTION_WHERE} AND session_id = ? AND timestamp >= ? ORDER BY timestamp ASC`
    )
    .all(sessionId, cutoff);
  return rows.map(fromEventRow);
}

/**
 * Looks up a concept tag across ALL repos for the current user — deliberately
 * not scoped to one repo. This is what the future memoization check
 * ("has this concept been taught before, anywhere") reads from; nothing
 * calls it yet in Phase 1.
 */
export function getConceptTagGlobal(
  db: Database.Database,
  tag: string,
  onlyAnswered = true
): ConceptTagGlobalRow[] {
  const sql = `
    SELECT concept_tags.*, events.repo AS repo, events.timestamp AS event_timestamp
    FROM concept_tags
    JOIN events ON events.id = concept_tags.event_id
    WHERE concept_tags.tag = ?
    ${onlyAnswered ? "AND concept_tags.answered = 1" : ""}
    ORDER BY events.timestamp ASC
  `;
  const rows = db.prepare(sql).all(tag) as any[];
  return rows.map((row) => ({
    id: row.id,
    eventId: row.event_id,
    tag: row.tag,
    answered: Boolean(row.answered),
    repo: row.repo,
    eventTimestamp: row.event_timestamp,
  }));
}

/**
 * Every distinct concept tag answered (not skipped) anywhere, globally —
 * the "already-answered" list Phase 5 puts in the judge prompt so the
 * model can avoid proposing a concept question for something the user has
 * already demonstrated understanding of. Complements `getConceptTagGlobal`
 * (a point lookup for one tag); this is the "list them all" counterpart.
 */
export function getAllAnsweredConceptTags(db: Database.Database): string[] {
  const rows = db
    .prepare(`SELECT DISTINCT tag FROM concept_tags WHERE answered = 1 ORDER BY tag ASC`)
    .all() as Array<{ tag: string }>;
  return rows.map((row) => row.tag);
}

/**
 * Sums `cost_usd` across every `events` row for one Claude Code
 * `session_id` — the cost-cap accounting boundary resolved in
 * DECISIONS.md's "Resolving Phase 3's flagged consequence" entry: session-
 * wide, not per-turn. NULL `cost_usd` (e.g. a cap_reached miss that never
 * invoked the model) contributes 0.
 */
export function getSessionCostUsd(db: Database.Database, sessionId: string): number {
  const row = db
    .prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS total FROM events WHERE session_id = ?`)
    .get(sessionId) as { total: number };
  return row.total;
}

/**
 * Counts real, individual questions — not event rows — for one Claude Code
 * `session_id`, across every turn sharing it. A real (non-miss,
 * `question_type IS NOT NULL`) event carries ONE question when only
 * `question_instance` is set (the concept was already memoized) or TWO when
 * both `question_concept` and `question_instance` are set (a "both" pair) —
 * see DECISIONS.md's "question caps count real questions, not event-rows"
 * entry for why counting rows instead let a cap of N silently admit up to
 * 2N actual questions. This is the questions-per-session cap's accounting
 * boundary (Phase 8): session-wide, the same boundary `getSessionCostUsd`
 * already uses for the cost cap, per DECISIONS.md's "Resolving Phase 3's
 * flagged consequence" entry — a per-turn cap would let a long multi-turn
 * session generate a fresh batch on every turn, defeating the cap's
 * purpose.
 */
export function getSessionQuestionCount(db: Database.Database, sessionId: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(
         (CASE WHEN question_concept IS NOT NULL THEN 1 ELSE 0 END) +
         (CASE WHEN question_instance IS NOT NULL THEN 1 ELSE 0 END)
       ), 0) AS n
       FROM events
       WHERE session_id = ? AND question_type IS NOT NULL`
    )
    .get(sessionId) as { n: number };
  return row.n;
}

export interface TurnKey {
  sessionId: string;
  promptId: string;
}

/**
 * Ensures a `cc_turns` row exists for (sessionId, promptId). Safe to call
 * repeatedly across separate hook-invocation processes — `INSERT OR IGNORE`
 * makes the first caller for a given turn the one that sets `started_at`;
 * every later caller for the same turn is a no-op.
 */
export function upsertTurn(
  db: Database.Database,
  key: TurnKey & { repo: string }
): void {
  db.prepare(
    `INSERT OR IGNORE INTO cc_turns (session_id, prompt_id, repo, started_at) VALUES (?, ?, ?, ?)`
  ).run(key.sessionId, key.promptId, key.repo, new Date().toISOString());
}

/**
 * Marks a turn complete. Returns true only if THIS call was the one that
 * transitioned it from incomplete -> complete (the `WHERE completed_at IS
 * NULL` makes this atomic and idempotent at the DB level) — so a second
 * Stop firing for the same turn, however it happened, safely no-ops
 * instead of re-running completion side effects.
 */
export function completeTurn(db: Database.Database, key: TurnKey): boolean {
  const info = db
    .prepare(
      `UPDATE cc_turns SET completed_at = ? WHERE session_id = ? AND prompt_id = ? AND completed_at IS NULL`
    )
    .run(new Date().toISOString(), key.sessionId, key.promptId);
  return info.changes > 0;
}

export function getTurn(
  db: Database.Database,
  key: TurnKey
): { sessionId: string; promptId: string; repo: string; startedAt: string; completedAt: string | null } | undefined {
  const row = db
    .prepare(`SELECT * FROM cc_turns WHERE session_id = ? AND prompt_id = ?`)
    .get(key.sessionId, key.promptId) as any;
  if (!row) return undefined;
  return {
    sessionId: row.session_id,
    promptId: row.prompt_id,
    repo: row.repo,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

/**
 * The checkpoint tree SHA the most recent capture for this (session, repo)
 * was diffed up to — null if no capture has happened yet for this pair
 * (i.e. this hook firing is the first Grasp has ever seen for it).
 */
export function getCheckpointTree(db: Database.Database, sessionId: string, repo: string): string | null {
  const row = db
    .prepare(`SELECT tree_sha FROM capture_checkpoints WHERE session_id = ? AND repo = ?`)
    .get(sessionId, repo) as { tree_sha: string } | undefined;
  return row ? row.tree_sha : null;
}

/**
 * Advances (or first-establishes) the checkpoint for a (session, repo)
 * pair to `treeSha`. Always overwrites — a checkpoint only ever moves
 * forward to "the state as of the capture that just ran," never backward.
 */
export function setCheckpointTree(
  db: Database.Database,
  sessionId: string,
  repo: string,
  treeSha: string
): void {
  db.prepare(
    `INSERT INTO capture_checkpoints (session_id, repo, tree_sha, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(session_id, repo) DO UPDATE SET tree_sha = excluded.tree_sha, updated_at = excluded.updated_at`
  ).run(sessionId, repo, treeSha, new Date().toISOString());
}

/**
 * Seeds a checkpoint only if none exists yet for this (session, repo) pair
 * — an `INSERT OR IGNORE`, not an upsert. Used specifically where clobbering
 * a checkpoint some other, possibly-racing process already advanced would be
 * wrong (initial seeding, and the "no previous checkpoint at all" branch of
 * an atomic claim) — see `ClaudeCodeAdapter.ensureCheckpointSeeded`/
 * `claimTransition` for the call sites and DECISIONS.md's "Atomic checkpoint
 * claiming" entry.
 */
export function insertCheckpointTreeIfAbsent(
  db: Database.Database,
  sessionId: string,
  repo: string,
  treeSha: string
): void {
  db.prepare(
    `INSERT OR IGNORE INTO capture_checkpoints (session_id, repo, tree_sha, updated_at) VALUES (?, ?, ?, ?)`
  ).run(sessionId, repo, treeSha, new Date().toISOString());
}

/**
 * Persists a captured diff for a turn, along with Phase 4's mechanical
 * filter verdict — `filtered: false, filterReason: null` for a diff that
 * passed, `filtered: true, filterReason: <reason>` for one that didn't.
 * Every capture gets a row here regardless of verdict; nothing is silently
 * dropped (see DECISIONS.md's "Filtered-diff recording" entry).
 * `upsertTurn` must have been called first (FK).
 *
 * `significantFiles` is the filter's own verdict for a passed diff (null for
 * a filtered-out one, which never reaches generation) — persisted verbatim
 * at capture time so a later batched-at-Stop generation attempt (see
 * `getUnresolvedCapturedDiffs`) uses exactly what the filter actually saw,
 * not a re-run against a working tree that may have moved on since. New rows
 * always start unresolved (`resolved = 0`); see `markCapturedDiffsResolved`.
 */
export function insertCapturedDiff(
  db: Database.Database,
  key: TurnKey & {
    repo: string;
    capturedAt: string;
    diff: CapturedDiff;
    filtered: boolean;
    filterReason: string | null;
    significantFiles: DiffFile[] | null;
  }
): number {
  const info = db
    .prepare(
      `INSERT INTO captured_diffs (session_id, prompt_id, repo, captured_at, diff_json, filtered, filter_reason, significant_files_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      key.sessionId,
      key.promptId,
      key.repo,
      key.capturedAt,
      JSON.stringify(key.diff),
      key.filtered ? 1 : 0,
      key.filterReason,
      key.significantFiles ? JSON.stringify(key.significantFiles) : null
    );
  return Number(info.lastInsertRowid);
}

export interface CapturedDiffRecord {
  id: number;
  capturedAt: string;
  diff: CapturedDiff;
  filtered: boolean;
  filterReason: string | null;
  resolved: boolean;
  significantFiles: DiffFile[] | null;
}

function fromCapturedDiffRow(row: any): CapturedDiffRecord {
  return {
    id: row.id,
    capturedAt: row.captured_at,
    diff: JSON.parse(row.diff_json),
    filtered: Boolean(row.filtered),
    filterReason: row.filter_reason,
    resolved: Boolean(row.resolved),
    significantFiles: row.significant_files_json ? JSON.parse(row.significant_files_json) : null,
  };
}

export function getCapturedDiffsForTurn(
  db: Database.Database,
  key: TurnKey
): CapturedDiffRecord[] {
  const rows = db
    .prepare(
      `SELECT * FROM captured_diffs WHERE session_id = ? AND prompt_id = ? ORDER BY captured_at ASC`
    )
    .all(key.sessionId, key.promptId) as any[];
  return rows.map(fromCapturedDiffRow);
}

/**
 * Every captured diff for a (session, repo) pair that passed the mechanical
 * filter (`filtered = 0`) and hasn't yet been resolved by a generation
 * attempt (`resolved = 0`) — what a `Stop`-triggered batch generation
 * attempt gathers and covers in one judge call. Scoped to (session, repo),
 * not session alone — see DECISIONS.md's "Batched-at-Stop generation" entry
 * for why: a `Stop` firing only ever resolves one repo root (from its own
 * `cwd`), matching every other per-firing resolution (config, gate-check)
 * already scoped that way, and it avoids an ill-defined "which repo does
 * this combined event belong to" for the rare session that touches more
 * than one repo.
 */
export function getUnresolvedCapturedDiffs(
  db: Database.Database,
  sessionId: string,
  repo: string
): CapturedDiffRecord[] {
  const rows = db
    .prepare(
      `SELECT * FROM captured_diffs WHERE session_id = ? AND repo = ? AND filtered = 0 AND resolved = 0 ORDER BY captured_at ASC`
    )
    .all(sessionId, repo) as any[];
  return rows.map(fromCapturedDiffRow);
}

/**
 * Same shape as `getUnresolvedCapturedDiffs`, but scoped to `repo` alone,
 * across every `session_id` — for `grasp retry`, which has no live session
 * to scope itself to (a diff's originating Claude Code session may have
 * ended long ago). `Stop`-triggered batch generation stays session-scoped
 * (see `getUnresolvedCapturedDiffs`'s own comment for why); this is the
 * deliberately broader sibling for the one caller that actually needs it.
 */
export function getUnresolvedCapturedDiffsForRepo(
  db: Database.Database,
  repo: string
): CapturedDiffRecord[] {
  const rows = db
    .prepare(
      `SELECT * FROM captured_diffs WHERE repo = ? AND filtered = 0 AND resolved = 0 ORDER BY captured_at ASC`
    )
    .all(repo) as any[];
  return rows.map(fromCapturedDiffRow);
}

/**
 * Marks a set of `captured_diffs` rows resolved — called once a batched
 * generation attempt that covered them concludes with a real outcome (see
 * `getUnresolvedCapturedDiffs`'s comment). A no-op on an empty list so
 * callers don't need to special-case "nothing to mark."
 */
export function markCapturedDiffsResolved(db: Database.Database, ids: number[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(",");
  db.prepare(`UPDATE captured_diffs SET resolved = 1 WHERE id IN (${placeholders})`).run(...ids);
}

/**
 * How long a claimed generation reservation is honored before a later
 * claimer is allowed to steal it. Must exceed the generation subprocess's
 * own timeout (`GENERATION_TIMEOUT_MS`, src/generation.ts) with real margin
 * — this is what makes the reservation self-healing after a hook process
 * that dies (killed session, machine sleep, etc.) mid-call instead of
 * releasing normally, matching this codebase's existing self-heal posture
 * for the checkpoint tables. Defined here (not in generation.ts) so store.ts
 * has no dependency on generation.ts; generation.ts's own timeout constant
 * is required by convention to stay comfortably under this value — see
 * DECISIONS.md's reservation entry.
 */
export const GENERATION_RESERVATION_STALE_MS = 45_000;

/**
 * Attempts to claim the single generation slot for `sessionId`. Returns a
 * fresh, randomly generated ownership token if claimed (no other process
 * holds it, or the holder's claim is older than
 * `GENERATION_RESERVATION_STALE_MS` and gets stolen), or null if another
 * process currently holds a live claim. The read-check-write is one `BEGIN
 * IMMEDIATE` transaction so two processes racing this call can't both see
 * "no live claim" and both write — only the loser sees SQLite's own
 * write-lock contention, not a logic race.
 *
 * The caller must hold onto this token and pass the SAME one back to
 * `releaseGenerationSlot` — see that function's comment for why a bare
 * "delete whatever's there for this session_id" isn't safe.
 */
export function tryClaimGenerationSlot(db: Database.Database, sessionId: string): string | null {
  const token = randomUUID();
  const run = db.transaction(() => {
    const now = new Date();
    const existing = db
      .prepare(`SELECT claimed_at FROM generation_reservations WHERE session_id = ?`)
      .get(sessionId) as { claimed_at: string } | undefined;
    if (existing) {
      const age = now.getTime() - new Date(existing.claimed_at).getTime();
      if (age < GENERATION_RESERVATION_STALE_MS) {
        return null;
      }
    }
    db.prepare(
      `INSERT INTO generation_reservations (session_id, claimed_at, token) VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET claimed_at = excluded.claimed_at, token = excluded.token`
    ).run(sessionId, now.toISOString(), token);
    return token;
  });
  return run.immediate();
}

/**
 * Releases this session's generation slot, but ONLY if it's still held by
 * `token` — the exact value this caller got back from its own
 * `tryClaimGenerationSlot` call. Without this check, a worker that pauses
 * (machine sleep, process suspension) past `GENERATION_RESERVATION_STALE_MS`
 * and then resumes could find its reservation already stolen by a second
 * worker; its own (unconditional, "just delete whatever's there") release
 * would then delete that second worker's ACTIVE reservation out from under
 * it, letting a third worker claim the slot while the second is still
 * genuinely running — defeating the whole point of the mutex. Found by an
 * independent test pass. Matching on token makes a stale worker's release a
 * no-op once it no longer owns the row, which is exactly what should
 * happen — see DECISIONS.md's "Generation reservation ownership token"
 * entry.
 */
export function releaseGenerationSlot(db: Database.Database, sessionId: string, token: string): void {
  db.prepare(`DELETE FROM generation_reservations WHERE session_id = ? AND token = ?`).run(sessionId, token);
}

/** Append-only audit row — every observed hook firing, regardless of what (if anything) it did. */
export function recordHookInvocation(
  db: Database.Database,
  key: TurnKey & { eventName: string }
): void {
  db.prepare(
    `INSERT INTO hook_invocations (session_id, prompt_id, event_name, invoked_at) VALUES (?, ?, ?, ?)`
  ).run(key.sessionId, key.promptId, key.eventName, new Date().toISOString());
}

/**
 * Row counts for `grasp reset history`'s pre-delete confirmation prompt and
 * post-delete summary — read separately from the delete itself so the
 * caller can show "about to delete N/M rows" before asking for
 * confirmation, not just after.
 */
export function getHistoryRowCounts(db: Database.Database): { events: number; conceptTags: number; scanProgress: number } {
  const events = (db.prepare(`SELECT COUNT(*) AS n FROM events`).get() as { n: number }).n;
  const conceptTags = (db.prepare(`SELECT COUNT(*) AS n FROM concept_tags`).get() as { n: number }).n;
  const scanProgress = (db.prepare(`SELECT COUNT(*) AS n FROM scan_progress`).get() as { n: number }).n;
  return { events, conceptTags, scanProgress };
}

/**
 * Wipes stored question/answer history: `events`, `concept_tags` (a
 * separate table, `event_id`-linked — clearing only one would leave the
 * other stale/orphaned, see this file's schema comment), AND
 * `scan_progress`. Irreversible; callers are responsible for confirming
 * with the user first (see `grasp reset history` in reset.ts). Deliberately
 * does NOT touch `cc_turns`/`captured_diffs`/`capture_checkpoints`/
 * `hook_invocations`/`generation_reservations` — those are session/turn
 * bookkeeping, not "history" in the question/answer sense this command
 * promises to reset, and clearing them isn't needed for `events`/
 * `concept_tags` to be consistent with each other. `scan_progress` IS
 * cleared here, as a deliberate exception to that rule: `grasp scan`'s own
 * "nothing left to scan" message points at `grasp reset history` as the way
 * to scan from scratch (see DECISIONS.md's `grasp scan` entries), so this is
 * the one bookkeeping table reset history is explicitly documented to also
 * reset — leaving it untouched would make that pointer a dead end.
 */
export function clearHistory(db: Database.Database): { events: number; conceptTags: number; scanProgress: number } {
  const counts = getHistoryRowCounts(db);
  const run = db.transaction(() => {
    db.prepare(`DELETE FROM concept_tags`).run();
    db.prepare(`DELETE FROM events`).run();
    db.prepare(`DELETE FROM scan_progress`).run();
  });
  run();
  return counts;
}

// --- grasp scan: file-walk resumability, at chunk granularity ---------------

/**
 * Every file path whose walk is COMPLETE for `repo` — i.e. has a recorded
 * `is_final_chunk` row — as a `Set` for cheap membership checks against a
 * potentially large tracked-file list. A single indexed query, no disk
 * reads: a file that's already fully covered never needs to be re-read just
 * to confirm it's done. Permanent — see `scan_progress`'s own schema
 * comment for why there's no hash/mtime invalidation.
 */
export function getScanCompletedFilePaths(db: Database.Database, repo: string): Set<string> {
  const rows = db
    .prepare(`SELECT file_path FROM scan_progress WHERE repo = ? AND is_final_chunk = 1`)
    .all(repo) as Array<{ file_path: string }>;
  return new Set(rows.map((r) => r.file_path));
}

/**
 * Every chunk index already recorded for (repo, filePath) — used to resume a
 * partially-covered multi-chunk file from the right chunk, and to detect
 * (via the caller) whether the file's walk is already complete without a
 * second, separate query.
 */
export function getScannedChunkIndexes(db: Database.Database, repo: string, filePath: string): Set<number> {
  const rows = db
    .prepare(`SELECT chunk_index FROM scan_progress WHERE repo = ? AND file_path = ?`)
    .all(repo, filePath) as Array<{ chunk_index: number }>;
  return new Set(rows.map((r) => r.chunk_index));
}

/**
 * Marks one chunk scanned for `repo`/`filePath` — idempotent (a re-scan
 * attempt, which shouldn't happen given the resumability filtering, would
 * just no-op rather than error). `isFinal` marks the row that completes the
 * file's walk (see this table's own schema comment) — the file's genuine
 * last chunk, or a mechanically-skipped file's sole chunk_index=0 row.
 */
export function markChunkScanned(
  db: Database.Database,
  repo: string,
  filePath: string,
  chunkIndex: number,
  isFinal: boolean
): void {
  db.prepare(
    `INSERT INTO scan_progress (repo, file_path, chunk_index, is_final_chunk, scanned_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(repo, file_path, chunk_index) DO UPDATE SET is_final_chunk = excluded.is_final_chunk, scanned_at = excluded.scanned_at`
  ).run(repo, filePath, chunkIndex, isFinal ? 1 : 0, new Date().toISOString());
}

export function countHookInvocations(
  db: Database.Database,
  key: TurnKey & { eventName: string }
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) as n FROM hook_invocations WHERE session_id = ? AND prompt_id = ? AND event_name = ?`
    )
    .get(key.sessionId, key.promptId, key.eventName) as any;
  return row.n as number;
}
