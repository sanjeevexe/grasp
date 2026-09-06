/** `concepts` CRUD.  GOVERNED BY: §11.1, §11.2, §19
 *
 * GLOBAL across projects: understanding `debouncing` transfers between repos
 * (§11.1). There is no project_id here and there must never be one.
 *
 * `last_demonstrated_at` drives lazy decay (§11.2). NEVER store a computed
 * decayed tier — decay is derived at read time by mastery/decay.ts, so that
 * nothing has to run on a schedule (§2.4).
 */
import type { DatabaseSync } from "node:sqlite";
import { execute, nowIso, queryAll, queryOne } from "../db.js";
import type { Tier } from "../../types/index.js";

export interface ConceptRow {
  tag: string;
  tier: Tier;
  last_demonstrated_at: string | null;
  first_seen_at: string;
}

export function getConcept(db: DatabaseSync, tag: string): ConceptRow | undefined {
  return queryOne<ConceptRow>(db, "SELECT * FROM concepts WHERE tag = ?", tag);
}

/** First sighting of a tag. Mastery starts at `none` and nothing is demonstrated yet. */
export function ensureConcept(db: DatabaseSync, tag: string): ConceptRow {
  const existing = getConcept(db, tag);
  if (existing) return existing;
  execute(
    db,
    "INSERT INTO concepts (tag, tier, last_demonstrated_at, first_seen_at) VALUES (?, 'none', NULL, ?)",
    tag,
    nowIso(),
  );
  return getConcept(db, tag) as ConceptRow;
}

/**
 * Write the STORED tier. Callers must pass the result of a transition computed
 * from the EFFECTIVE tier (§10.3) — this function does not compute anything.
 */
export function setTier(
  db: DatabaseSync,
  tag: string,
  tier: Tier,
  lastDemonstratedAt: string | null,
): void {
  ensureConcept(db, tag);
  execute(
    db,
    "UPDATE concepts SET tier = ?, last_demonstrated_at = ? WHERE tag = ?",
    tier,
    lastDemonstratedAt,
    tag,
  );
}

export function listConcepts(db: DatabaseSync): ConceptRow[] {
  return queryAll<ConceptRow>(db, "SELECT * FROM concepts ORDER BY tag");
}

/**
 * §9.3 — the known-tags context for generation: most-recently-demonstrated
 * first, capped by the caller at MAX_KNOWN_TAGS. Never-demonstrated tags sort
 * last but still appear, so a freshly-minted tag can still be reused.
 */
export function listTagsByRecency(db: DatabaseSync, limit: number): string[] {
  const rows = db
    .prepare(
      `SELECT tag FROM concepts
       ORDER BY last_demonstrated_at IS NULL, last_demonstrated_at DESC, first_seen_at DESC
       LIMIT ?`,
    )
    .all(limit) as { tag: string }[];
  return rows.map((row) => row.tag);
}
