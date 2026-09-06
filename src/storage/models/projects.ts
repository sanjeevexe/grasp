/** `projects` CRUD.  GOVERNED BY: §19, §5.3, §16.4
 *
 * `path` is absolute, resolved, and symlink-free — normalized by the caller
 * through util/paths.ts before it reaches here (§16.4). The daemon polls this
 * table every 5s to reconcile watchers (§5.3), so writes must be complete rows,
 * never partial updates the poller could observe mid-flight.
 */
import type { DatabaseSync } from "node:sqlite";
import { execute, nowIso, queryAll, queryOne } from "../db.js";
import type { GateMode } from "../../types/index.js";

export interface ProjectRow {
  id: number;
  path: string;
  registered_at: string;
  gate_mode: GateMode | null;
}

export function insertProject(
  db: DatabaseSync,
  path: string,
  gateMode: GateMode | null = null,
): ProjectRow {
  execute(
    db,
    "INSERT INTO projects (path, registered_at, gate_mode) VALUES (?, ?, ?)",
    path,
    nowIso(),
    gateMode,
  );
  return getProjectByPath(db, path) as ProjectRow;
}

/**
 * §6.1 step 3: registering an already-registered repo reports and exits 0 — no
 * duplicate, no error. Returns the existing row unchanged in that case.
 */
export function upsertProject(
  db: DatabaseSync,
  path: string,
): { row: ProjectRow; created: boolean } {
  const existing = getProjectByPath(db, path);
  if (existing) return { row: existing, created: false };
  return { row: insertProject(db, path), created: true };
}

export function getProjectByPath(db: DatabaseSync, path: string): ProjectRow | undefined {
  return queryOne<ProjectRow>(db, "SELECT * FROM projects WHERE path = ?", path);
}

export function getProjectById(db: DatabaseSync, id: number): ProjectRow | undefined {
  return queryOne<ProjectRow>(db, "SELECT * FROM projects WHERE id = ?", id);
}

export function listProjects(db: DatabaseSync): ProjectRow[] {
  return queryAll<ProjectRow>(db, "SELECT * FROM projects ORDER BY path");
}

export function setGateMode(db: DatabaseSync, id: number, gateMode: GateMode | null): void {
  execute(db, "UPDATE projects SET gate_mode = ? WHERE id = ?", gateMode, id);
}

/** Cascades to questions, question_files, scan_progress, generation_failures. */
export function deleteProject(db: DatabaseSync, id: number): void {
  execute(db, "DELETE FROM projects WHERE id = ?", id);
}
