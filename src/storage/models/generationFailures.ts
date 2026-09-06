/** `generation_failures` CRUD.  GOVERNED BY: §9.6, §19.1, §17
 *
 * `payload_json` holds everything needed to re-run the call without re-deriving
 * it (§19.1) — generation returns that payload rather than persisting it itself,
 * so this is where it lands. `grasp retry` replays them, increments `attempts`,
 * and deletes the row on success. Rows at `attempts >= 5` are reported but not
 * auto-retried.
 */
import type { DatabaseSync } from "node:sqlite";
import { execute, insertReturningId, nowIso, queryAll, queryOne } from "../db.js";
import type { GenerationKind } from "../../types/index.js";

/** Beyond this, `grasp retry` reports the row but stops re-attempting it (§19.1). */
export const MAX_RETRY_ATTEMPTS = 5;

export interface GenerationFailureRow {
  id: number;
  project_id: number | null;
  kind: GenerationKind;
  payload_json: string;
  error: string | null;
  attempts: number;
  failed_at: string;
}

export function recordFailure(
  db: DatabaseSync,
  failure: {
    projectId: number | null;
    kind: GenerationKind;
    payload: unknown;
    error: string | null;
  },
): number {
  return insertReturningId(
    db,
    `INSERT INTO generation_failures (project_id, kind, payload_json, error, attempts, failed_at)
     VALUES (?, ?, ?, ?, 1, ?)`,
    failure.projectId,
    failure.kind,
    JSON.stringify(failure.payload),
    failure.error,
    nowIso(),
  );
}

export function listFailures(db: DatabaseSync): GenerationFailureRow[] {
  return queryAll<GenerationFailureRow>(
    db,
    "SELECT * FROM generation_failures ORDER BY failed_at DESC, id DESC",
  );
}

export function listRetryableFailures(db: DatabaseSync): GenerationFailureRow[] {
  return queryAll<GenerationFailureRow>(
    db,
    "SELECT * FROM generation_failures WHERE attempts < ? ORDER BY failed_at",
    MAX_RETRY_ATTEMPTS,
  );
}

export function countFailures(db: DatabaseSync): number {
  const row = queryOne<{ n: number }>(db, "SELECT COUNT(*) AS n FROM generation_failures");
  return row?.n ?? 0;
}

export function recordRetryAttempt(db: DatabaseSync, id: number, error: string | null): void {
  execute(
    db,
    "UPDATE generation_failures SET attempts = attempts + 1, error = ?, failed_at = ? WHERE id = ?",
    error,
    nowIso(),
    id,
  );
}

export function deleteFailure(db: DatabaseSync, id: number): void {
  execute(db, "DELETE FROM generation_failures WHERE id = ?", id);
}

export function parsePayload<T>(row: GenerationFailureRow): T | null {
  try {
    return JSON.parse(row.payload_json) as T;
  } catch {
    // A corrupt payload cannot be replayed; `grasp retry` reports and skips it.
    return null;
  }
}
