/**
 * Connection, pragmas, migrations, transactions.  GOVERNED BY: §5.4, §19, §19.2
 *
 * `node:sqlite`, never `better-sqlite3`: a native addon that compiles on the
 * user's machine is the most common `npm install -g` failure (§3). That module
 * is still Stability 1.2, so this file uses only `DatabaseSync`, `StatementSync`,
 * and `exec` — no session, backup, or extension APIs.
 *
 * No connection is opened at import time (§3). Callers open one and close it.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { graspDbPath } from "../util/home.js";

/**
 * `node:sqlite` is deliberately absent from Node's `builtinModules` list, so
 * bundlers that resolve builtins from that list — Vite, which vitest runs on —
 * strip the `node:` prefix and then fail to find a package called "sqlite".
 * A runtime require resolves the real builtin and never reaches the bundler.
 * The type import above is erased at compile time, so it costs nothing.
 */
let sqliteModule: typeof import("node:sqlite") | undefined;
function sqlite(): typeof import("node:sqlite") {
  sqliteModule ??= createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
  return sqliteModule;
}

/** §19.2 — starts at 1; bump with every schema change and add a migration. */
export const SCHEMA_VERSION = 1;

export interface Migration {
  /** The version this migration brings the database TO. */
  to: number;
  apply: (db: DatabaseSync) => void;
}

/**
 * Ordered migrations. v1 is the initial schema, applied from schema.sql; later
 * versions append here. §19.2 ships the mechanism even while it is unused —
 * retrofitting migrations onto live user data is much worse than an empty list.
 */
export const MIGRATIONS: Migration[] = [
  {
    to: 1,
    apply: (db) => {
      db.exec(readSchemaSql());
      db.prepare("INSERT INTO schema_meta (version) VALUES (?)").run(1);
    },
  },
];

/** schema.sql sits next to this file in both src/ and dist/ (see copy-schema.mjs). */
export function readSchemaSql(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return fs.readFileSync(path.join(here, "schema.sql"), "utf8");
}

/**
 * §5.4 — on EVERY connection, not once at creation. The daemon and a review
 * session write concurrently; without WAL plus a busy timeout, one of them
 * surfaces SQLITE_BUSY to the user.
 */
export function applyPragmas(db: DatabaseSync): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
}

/** Any table at all, ignoring SQLite's own bookkeeping. */
function hasAnyTable(db: DatabaseSync): boolean {
  const row = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1",
    )
    .get();
  return row !== undefined;
}

function currentVersion(db: DatabaseSync): number {
  const tableExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'")
    .get();
  if (!tableExists) return 0;
  const row = db.prepare("SELECT version FROM schema_meta ORDER BY version DESC LIMIT 1").get() as
    { version: number } | undefined;
  return row?.version ?? 0;
}

/** Run every migration the database has not seen yet, in order. */
export function migrate(db: DatabaseSync): number {
  let version = currentVersion(db);
  for (const migration of MIGRATIONS) {
    if (migration.to <= version) continue;
    withTransaction(db, () => {
      migration.apply(db);
      if (migration.to > 1) {
        db.prepare("INSERT INTO schema_meta (version) VALUES (?)").run(migration.to);
      }
    });
    version = migration.to;
  }
  return version;
}

export interface OpenOptions {
  /** Defaults to ~/.grasp/history.db. Tests pass ":memory:" or a temp path. */
  file?: string;
  /** Skip migrations — only for inspecting a database you did not create. */
  migrate?: boolean;
}

export interface OpenResult {
  db: DatabaseSync;
  /** Set when a foreign database was moved aside; the caller should warn. */
  replacedForeign?: string;
}

/**
 * A database with tables but no `schema_meta` was not written by this version of
 * Grasp — an older release, or an unrelated file that landed on the path. It is
 * moved aside rather than migrated into.
 *
 * DECISION: mirror §16.3's rule for a corrupt config — back it up, start fresh,
 * warn loudly, continue. Found the hard way: an earlier Grasp's `history.db` was
 * still on disk, migration v1 hit `table scan_progress already exists`, rolled
 * back, and the daemon threw on EVERY start. A background service that
 * crash-loops on a leftover file is the worst of the options; losing an old
 * version's unreadable rows is the least bad, and the file is never deleted.
 */
function setAsideForeignDatabase(file: string): string {
  const backup = `${file}.pre-v${SCHEMA_VERSION}`;
  fs.renameSync(file, backup);
  for (const suffix of ["-wal", "-shm"]) {
    try {
      fs.rmSync(`${file}${suffix}`, { force: true });
    } catch {
      // Nothing to clean up.
    }
  }
  return backup;
}

export function openDatabase(options: OpenOptions = {}): DatabaseSync {
  return openDatabaseWithResult(options).db;
}

export function openDatabaseWithResult(options: OpenOptions = {}): OpenResult {
  const file = options.file ?? graspDbPath();
  if (file !== ":memory:") {
    // ~/.grasp may not exist yet on a first-ever run.
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  let db = new (sqlite().DatabaseSync)(file);
  applyPragmas(db);
  if (options.migrate === false) return { db };

  let replacedForeign: string | undefined;
  if (file !== ":memory:" && currentVersion(db) === 0 && hasAnyTable(db)) {
    db.close();
    replacedForeign = setAsideForeignDatabase(file);
    db = new (sqlite().DatabaseSync)(file);
    applyPragmas(db);
  }

  migrate(db);
  return { db, replacedForeign };
}

export function closeDatabase(db: DatabaseSync): void {
  db.close();
}

/**
 * The only way to write more than one statement.  GOVERNED BY: §5.4
 *
 * `node:sqlite` has no `better-sqlite3`-style `db.transaction()` wrapper, and
 * hand-rolled BEGIN/COMMIT pairs across eleven stages eventually leave a
 * connection stuck mid-transaction when something throws between them. Route
 * every multi-statement write through here.
 *
 * NEVER hold one of these open across an `await` on network I/O (§5.4):
 * generate first, then write. The callback is deliberately synchronous so that
 * is impossible to express.
 */
export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  // Nested calls reuse the outer transaction: SQLite has no nested BEGIN, and
  // a savepoint here would buy nothing v1 needs.
  if (db.isTransaction) return fn();

  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // A failed rollback must not mask the original error.
    }
    throw error;
  }
}

/**
 * Typed query helpers.
 *
 * `node:sqlite` returns `Record<string, SQLOutputValue>`, so every call site
 * would otherwise need its own `as unknown as Row` cast. One cast here, checked
 * once, beats forty scattered through the models.
 */
export type SqlParam = null | number | bigint | string | Uint8Array;

export function queryAll<T>(db: DatabaseSync, sql: string, ...params: SqlParam[]): T[] {
  return db.prepare(sql).all(...params) as unknown as T[];
}

export function queryOne<T>(db: DatabaseSync, sql: string, ...params: SqlParam[]): T | undefined {
  return db.prepare(sql).get(...params) as unknown as T | undefined;
}

export function execute(db: DatabaseSync, sql: string, ...params: SqlParam[]): void {
  db.prepare(sql).run(...params);
}

/** The rowid SQLite assigned to the row just inserted by `sql`. */
export function insertReturningId(db: DatabaseSync, sql: string, ...params: SqlParam[]): number {
  const result = db.prepare(sql).run(...params);
  return Number(result.lastInsertRowid);
}

/** ISO-8601 UTC, the only timestamp format in the schema (§19). */
export function nowIso(): string {
  return new Date().toISOString();
}
