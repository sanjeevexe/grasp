/** `scan_progress` CRUD.  GOVERNED BY: §12.2, §19
 *
 * Makes `grasp scan` resumable: interrupt it and a re-run picks up where it
 * left off. An unchanged `file_hash` generates nothing; a genuinely edited file
 * re-triggers. `file_path` is POSIX-style and project-relative (§16.4).
 */
import type { DatabaseSync } from "node:sqlite";
import { execute, nowIso, queryAll, queryOne } from "../db.js";

export interface ScanProgressRow {
  project_id: number;
  file_path: string;
  file_hash: string;
  sections_completed: number;
  sections_total: number;
  last_scanned_at: string;
}

export function getScanProgress(
  db: DatabaseSync,
  projectId: number,
  filePath: string,
): ScanProgressRow | undefined {
  return queryOne<ScanProgressRow>(
    db,
    "SELECT * FROM scan_progress WHERE project_id = ? AND file_path = ?",
    projectId,
    filePath,
  );
}

export function recordScanProgress(
  db: DatabaseSync,
  row: Omit<ScanProgressRow, "last_scanned_at">,
): void {
  execute(
    db,
    `INSERT INTO scan_progress
       (project_id, file_path, file_hash, sections_completed, sections_total, last_scanned_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (project_id, file_path) DO UPDATE SET
       file_hash = excluded.file_hash,
       sections_completed = excluded.sections_completed,
       sections_total = excluded.sections_total,
       last_scanned_at = excluded.last_scanned_at`,
    row.project_id,
    row.file_path,
    row.file_hash,
    row.sections_completed,
    row.sections_total,
    nowIso(),
  );
}

export function listScanProgress(db: DatabaseSync, projectId: number): ScanProgressRow[] {
  return queryAll<ScanProgressRow>(
    db,
    "SELECT * FROM scan_progress WHERE project_id = ? ORDER BY file_path",
    projectId,
  );
}

export function clearScanProgress(db: DatabaseSync, projectId: number): void {
  execute(db, "DELETE FROM scan_progress WHERE project_id = ?", projectId);
}
