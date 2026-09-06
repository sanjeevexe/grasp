/** `synthesis_clusters` CRUD.  GOVERNED BY: §11.6, §11.7, §11.8, §19
 *
 * DELIBERATELY SEPARATE FROM `concepts`, and never joined to it for scoring
 * (§11.7). Concept mastery answers "do you understand this piece"; synthesis
 * answers "can you connect the pieces". Nothing in this file may read or write
 * `concepts.tier` — the FK on `tag` exists for referential integrity only.
 *
 * `diff_count` is intentionally absent from the schema: derive it with a COUNT
 * (§11.6), because a stored counter drifts on partial writes.
 */
import type { DatabaseSync } from "node:sqlite";
import { execute, nowIso, queryAll, queryOne } from "../db.js";
import type { SynthesisStatus } from "../../types/index.js";

export interface SynthesisClusterRow {
  tag: string;
  eligible: number;
  status: SynthesisStatus;
  count_at_last_checkpoint: number;
  last_checkpoint_at: string | null;
}

export function getCluster(db: DatabaseSync, tag: string): SynthesisClusterRow | undefined {
  return queryOne<SynthesisClusterRow>(db, "SELECT * FROM synthesis_clusters WHERE tag = ?", tag);
}

/**
 * Deliberately does NOT create the concept row the FK requires. §11.7 keeps this
 * table out of `concepts` entirely, and in real flow the concept always exists
 * first: a cluster only forms once questions have landed under the tag (§11.6),
 * and inserting a question creates its concept. A foreign-key error here means a
 * caller invented a cluster for a tag nothing has ever asked about.
 */
export function ensureCluster(db: DatabaseSync, tag: string): SynthesisClusterRow {
  const existing = getCluster(db, tag);
  if (existing) return existing;
  execute(db, "INSERT INTO synthesis_clusters (tag) VALUES (?)", tag);
  return getCluster(db, tag) as SynthesisClusterRow;
}

export function setEligible(db: DatabaseSync, tag: string, eligible: boolean): void {
  ensureCluster(db, tag);
  execute(db, "UPDATE synthesis_clusters SET eligible = ? WHERE tag = ?", eligible ? 1 : 0, tag);
}

/**
 * §11.7 — the outcome of a synthesis checkpoint. `nailed_it` maps to `passed`;
 * `mostly_there` and `way_off` both map to `struggled`. This function MUST NOT
 * touch concept mastery.
 */
export function recordCheckpointOutcome(
  db: DatabaseSync,
  tag: string,
  status: SynthesisStatus,
  countAtCheckpoint: number,
): void {
  ensureCluster(db, tag);
  execute(
    db,
    `UPDATE synthesis_clusters
        SET status = ?, count_at_last_checkpoint = ?, last_checkpoint_at = ?, eligible = 0
      WHERE tag = ?`,
    status,
    countAtCheckpoint,
    nowIso(),
    tag,
  );
}

export function listClusters(db: DatabaseSync): SynthesisClusterRow[] {
  return queryAll<SynthesisClusterRow>(db, "SELECT * FROM synthesis_clusters ORDER BY tag");
}

export function listEligibleClusters(db: DatabaseSync): SynthesisClusterRow[] {
  return queryAll<SynthesisClusterRow>(
    db,
    "SELECT * FROM synthesis_clusters WHERE eligible = 1 ORDER BY tag",
  );
}
