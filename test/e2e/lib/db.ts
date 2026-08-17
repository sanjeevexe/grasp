import * as fs from "fs";
import * as path from "path";
import Database from "better-sqlite3";
import { openStore } from "../../../src/store";

/**
 * Direct store access for the parts of each scenario that are "database
 * inspection," not "drive the real interface" — per the task brief's own
 * split ("drive every interaction through the real pty ... use direct CLI
 * invocation + database inspection for anything that isn't"). Every
 * scenario's isolated `$HOME` gets its own `~/.grasp/history.db`
 * (`src/paths.ts`'s `DB_PATH`, resolved against whatever `HOME` env var a
 * given subprocess was launched with) — these helpers open that exact same
 * file directly, using the real `src/store.ts` DAL (not hand-rolled SQL),
 * so a schema change there is automatically reflected here too.
 */

export function dbPathFor(home: string): string {
  return path.join(home, ".grasp", "history.db");
}

/** Must be called before seeding data directly (via `openStore`/`insertEvent`) against a `home` no `grasp` invocation has touched yet — `openStore` only ever mkdir's the DEFAULT `~/.grasp`, not an arbitrary custom path's parent. */
export function ensureHomeDir(home: string): void {
  fs.mkdirSync(path.join(home, ".grasp"), { recursive: true });
}

/** Opens (or creates) `home`'s history.db via the real store module — safe to call concurrently with a separate `grasp` subprocess that also has it open (WAL mode, busy_timeout — see `openStore`'s own pragmas). */
export function openHomeDb(home: string): Database.Database {
  ensureHomeDir(home);
  return openStore(dbPathFor(home));
}
