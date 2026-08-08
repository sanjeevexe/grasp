import Database from "better-sqlite3";
import * as fs from "fs";
import { randomUUID } from "crypto";
import { DB_PATH, GRASP_HOME } from "./paths";
import { CapturedDiff, DiffFile } from "./adapters/agentAdapter";
import { ConceptTagGlobalRow, ConceptTagRecord, EventRecord } from "./types";

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
    concept_explanation TEXT
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
  CREATE TABLE IF NOT EXISTS captured_diffs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    prompt_id TEXT NOT NULL,
    repo TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    diff_json TEXT NOT NULL,
    filtered INTEGER NOT NULL DEFAULT 0,
    filter_reason TEXT,
    FOREIGN KEY (session_id, prompt_id) REFERENCES cc_turns(session_id, prompt_id)
  );

  CREATE INDEX IF NOT EXISTS idx_captured_diffs_turn ON captured_diffs(session_id, prompt_id);

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
      sample_answer_concept, sample_answer_instance, concept_explanation
    ) VALUES (
      @timestamp, @repo, @sessionId, @diffHash, @diffSummary,
      @questionConcept, @questionInstance, @questionType, @generationSource,
      @missReason, @answerConcept, @answerInstance,
      @skipped, @skipReason, @costUsd, @costUnknown, @diffFilesJson,
      @sampleAnswerConcept, @sampleAnswerInstance, @conceptExplanation
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
 * Every real (non-miss), unanswered, unskipped question across ALL repos —
 * deliberately global, matching the project's existing concept-tag
 * memoization precedent, not scoped to the current working directory's
 * repo. See DECISIONS.md's "grasp review query scope" entry for why.
 * `answer_instance IS NULL` alone is a reliable "not yet answered" check:
 * every real question (question_type "both" or "instance") always has a
 * non-null question_instance and gets it answered last in `review`'s
 * concept-then-instance sequence, so it's null iff the event is still
 * pending regardless of question_type.
 */
export function getPendingQuestions(db: Database.Database): EventRecord[] {
  const rows = db
    .prepare(`SELECT * FROM events WHERE ${PENDING_QUESTION_WHERE} ORDER BY timestamp ASC`)
    .all();
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
 * True if this session has already recorded a miss whose real `claude -p`
 * cost genuinely could not be determined (`cost_unknown = 1` — see
 * `EventRecord.costUnknown`'s comment). `getSessionCostUsd` sums NULL as 0,
 * which is correct for rows where no call was ever attempted
 * (`cap_reached`, slot-wait timeout) but would silently let an attempted-
 * but-uncosted call look "free" and leave the session's cap enforcement
 * bypassable by repeating it — this is the separate signal `runGeneration`
 * checks to close that gap. See DECISIONS.md's "Unknown-cost failures halt
 * further generation for the session" entry.
 */
export function hasUnknownCostFailure(db: Database.Database, sessionId: string): boolean {
  const row = db
    .prepare(`SELECT 1 AS found FROM events WHERE session_id = ? AND cost_unknown = 1 LIMIT 1`)
    .get(sessionId) as { found: number } | undefined;
  return row !== undefined;
}

/**
 * Counts real (non-miss) questions — `question_type IS NOT NULL` — for one
 * Claude Code `session_id`, across every turn sharing it. This is the
 * questions-per-session cap's accounting boundary (Phase 8): session-wide,
 * the same boundary `getSessionCostUsd` already uses for the cost cap, per
 * DECISIONS.md's "Resolving Phase 3's flagged consequence" entry — a
 * per-turn cap would let a long multi-turn session generate a fresh batch
 * on every turn, defeating the cap's purpose.
 */
export function getSessionQuestionCount(db: Database.Database, sessionId: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND question_type IS NOT NULL`)
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
 */
export function insertCapturedDiff(
  db: Database.Database,
  key: TurnKey & {
    repo: string;
    capturedAt: string;
    diff: CapturedDiff;
    filtered: boolean;
    filterReason: string | null;
  }
): number {
  const info = db
    .prepare(
      `INSERT INTO captured_diffs (session_id, prompt_id, repo, captured_at, diff_json, filtered, filter_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      key.sessionId,
      key.promptId,
      key.repo,
      key.capturedAt,
      JSON.stringify(key.diff),
      key.filtered ? 1 : 0,
      key.filterReason
    );
  return Number(info.lastInsertRowid);
}

export interface CapturedDiffRecord {
  id: number;
  capturedAt: string;
  diff: CapturedDiff;
  filtered: boolean;
  filterReason: string | null;
}

export function getCapturedDiffsForTurn(
  db: Database.Database,
  key: TurnKey
): CapturedDiffRecord[] {
  const rows = db
    .prepare(
      `SELECT id, captured_at, diff_json, filtered, filter_reason FROM captured_diffs
       WHERE session_id = ? AND prompt_id = ? ORDER BY captured_at ASC`
    )
    .all(key.sessionId, key.promptId) as any[];
  return rows.map((row) => ({
    id: row.id,
    capturedAt: row.captured_at,
    diff: JSON.parse(row.diff_json),
    filtered: Boolean(row.filtered),
    filterReason: row.filter_reason,
  }));
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
