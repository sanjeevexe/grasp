/**
 * Storage: pragmas, migrations, transactions, models.  GOVERNED BY: §5.4, §19, §19.2
 */
import fs, { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import {
  MIGRATIONS,
  SCHEMA_VERSION,
  closeDatabase,
  openDatabase,
  openDatabaseWithResult,
  queryOne,
  withTransaction,
} from "../src/storage/db.js";
import {
  getProjectByPath,
  insertProject,
  listProjects,
  setGateMode,
  upsertProject,
} from "../src/storage/models/projects.js";
import {
  ensureConcept,
  getConcept,
  listTagsByRecency,
  setTier,
} from "../src/storage/models/concepts.js";
import {
  countQuestionsForTag,
  countQuestionsSince,
  findQuestionsForFiles,
  getQuestion,
  getQuestionFiles,
  insertQuestion,
  listPendingQuestions,
  parseScaffold,
  questionExistsForHash,
  recordAnswer,
} from "../src/storage/models/questions.js";
import {
  ensureCluster,
  getCluster,
  recordCheckpointOutcome,
  setEligible,
} from "../src/storage/models/synthesisClusters.js";
import {
  getScanProgress,
  recordScanProgress,
  listScanProgress,
} from "../src/storage/models/scanProgress.js";
import {
  MAX_RETRY_ATTEMPTS,
  listFailures,
  listRetryableFailures,
  parsePayload,
  recordFailure,
  recordRetryAttempt,
  deleteFailure,
} from "../src/storage/models/generationFailures.js";

let db: DatabaseSync;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "grasp-db-"));
  db = openDatabase({ file: path.join(tempDir, "history.db") });
});

afterEach(() => {
  closeDatabase(db);
  rmSync(tempDir, { recursive: true, force: true });
});

function seedProject(p = "/repo/one"): number {
  return insertProject(db, p).id;
}

function seedQuestion(projectId: number, over: Partial<Parameters<typeof insertQuestion>[1]> = {}) {
  return insertQuestion(db, {
    project_id: projectId,
    type: "trace",
    concept_tag: "debouncing",
    origin: "live",
    question_text: "q",
    sample_answer: "a",
    files: ["src/a.ts"],
    ...over,
  });
}

describe("connection and pragmas (§5.4)", () => {
  it("enables WAL, busy_timeout, and foreign keys on every connection", () => {
    expect(queryOne<{ journal_mode: string }>(db, "PRAGMA journal_mode")?.journal_mode).toBe("wal");
    expect(queryOne<{ timeout: number }>(db, "PRAGMA busy_timeout")?.timeout).toBe(5000);
    expect(queryOne<{ foreign_keys: number }>(db, "PRAGMA foreign_keys")?.foreign_keys).toBe(1);
  });

  it("applies pragmas to a second connection to the same file too", () => {
    const second = openDatabase({ file: path.join(tempDir, "history.db") });
    expect(queryOne<{ foreign_keys: number }>(second, "PRAGMA foreign_keys")?.foreign_keys).toBe(1);
    closeDatabase(second);
  });

  it("enforces foreign keys — a question needs a real project", () => {
    expect(() => seedQuestion(9999)).toThrow();
  });

  it("cascades deletes from projects", () => {
    const projectId = seedProject();
    const id = seedQuestion(projectId);
    db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
    expect(getQuestion(db, id)).toBeUndefined();
    expect(getQuestionFiles(db, id)).toEqual([]);
  });
});

describe("migrations (§19.2)", () => {
  it("creates the schema at version 1 and is idempotent on reopen", () => {
    expect(
      queryOne<{ version: number }>(db, "SELECT MAX(version) AS version FROM schema_meta")?.version,
    ).toBe(SCHEMA_VERSION);
    closeDatabase(db);
    db = openDatabase({ file: path.join(tempDir, "history.db") });
    const rows = db.prepare("SELECT version FROM schema_meta").all();
    expect(rows).toHaveLength(1);
  });

  it("creates every table §19 specifies", () => {
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(names).toEqual(
      expect.arrayContaining([
        "concepts",
        "generation_failures",
        "projects",
        "question_files",
        "questions",
        "scan_progress",
        "schema_meta",
        "synthesis_clusters",
      ]),
    );
  });

  it("ships an ordered migration runner even with one migration", () => {
    expect(MIGRATIONS.map((m) => m.to)).toEqual(
      [...MIGRATIONS.map((m) => m.to)].sort((a, b) => a - b),
    );
    expect(MIGRATIONS.at(-1)?.to).toBe(SCHEMA_VERSION);
  });
});

describe("a foreign or older database (§16.3's rule, applied to storage)", () => {
  it("moves it aside and starts fresh instead of crash-looping", () => {
    const file = path.join(tempDir, "legacy.db");
    // Shaped like an older Grasp: real tables, no schema_meta, and one name
    // that collides with the v1 schema so migration would throw.
    const legacy = openDatabase({ file, migrate: false });
    legacy.exec("CREATE TABLE scan_progress (id INTEGER PRIMARY KEY)");
    legacy.exec("CREATE TABLE cc_turns (id INTEGER PRIMARY KEY)");
    closeDatabase(legacy);

    const result = openDatabaseWithResult({ file });

    expect(result.replacedForeign).toBe(`${file}.pre-v${SCHEMA_VERSION}`);
    // The old file is preserved, never deleted.
    expect(fs.existsSync(`${file}.pre-v${SCHEMA_VERSION}`)).toBe(true);
    // ...and the new one is a working v1 database.
    expect(
      queryOne<{ version: number }>(result.db, "SELECT MAX(version) AS version FROM schema_meta")
        ?.version,
    ).toBe(SCHEMA_VERSION);
    insertProject(result.db, "/repo/after-recovery");
    closeDatabase(result.db);
  });

  it("leaves a healthy database alone", () => {
    const file = path.join(tempDir, "healthy.db");
    closeDatabase(openDatabase({ file }));
    const result = openDatabaseWithResult({ file });
    expect(result.replacedForeign).toBeUndefined();
    closeDatabase(result.db);
  });
});

describe("withTransaction (§5.4)", () => {
  it("commits on success", () => {
    withTransaction(db, () => insertProject(db, "/repo/tx"));
    expect(getProjectByPath(db, "/repo/tx")).toBeDefined();
  });

  it("rolls back every statement when one throws", () => {
    expect(() =>
      withTransaction(db, () => {
        insertProject(db, "/repo/a");
        insertProject(db, "/repo/b");
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(listProjects(db)).toHaveLength(0);
  });

  it("leaves no transaction open after a throw — the connection stays usable", () => {
    expect(() =>
      withTransaction(db, () => {
        throw new Error("boom");
      }),
    ).toThrow();
    expect(db.isTransaction).toBe(false);
    expect(() => insertProject(db, "/repo/after")).not.toThrow();
  });

  it("nests without a second BEGIN", () => {
    const result = withTransaction(db, () =>
      withTransaction(db, () => {
        insertProject(db, "/repo/nested");
        return 42;
      }),
    );
    expect(result).toBe(42);
    expect(getProjectByPath(db, "/repo/nested")).toBeDefined();
  });

  it("returns the callback's value", () => {
    expect(withTransaction(db, () => "value")).toBe("value");
  });
});

describe("projects", () => {
  it("upsert is idempotent — §6.1 step 3 registers once, exits 0 twice", () => {
    const first = upsertProject(db, "/repo/x");
    const second = upsertProject(db, "/repo/x");
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.row.id).toBe(first.row.id);
    expect(listProjects(db)).toHaveLength(1);
  });

  it("stores gate_mode as NULL until set, so config supplies the default (§13)", () => {
    const id = seedProject("/repo/gate");
    expect(getProjectByPath(db, "/repo/gate")?.gate_mode).toBeNull();
    setGateMode(db, id, "hard");
    expect(getProjectByPath(db, "/repo/gate")?.gate_mode).toBe("hard");
  });
});

describe("concepts (§11.1)", () => {
  it("starts a concept at none with nothing demonstrated", () => {
    const row = ensureConcept(db, "debouncing");
    expect(row.tier).toBe("none");
    expect(row.last_demonstrated_at).toBeNull();
    expect(row.first_seen_at).toBeTruthy();
  });

  it("is global — no project column exists at all (§11.1)", () => {
    const columns = db
      .prepare("PRAGMA table_info(concepts)")
      .all()
      .map((c) => (c as { name: string }).name);
    expect(columns).not.toContain("project_id");
  });

  it("stores tier and demonstration time without computing anything", () => {
    setTier(db, "debouncing", "trace", "2026-01-01T00:00:00.000Z");
    const row = getConcept(db, "debouncing");
    expect(row?.tier).toBe("trace");
    expect(row?.last_demonstrated_at).toBe("2026-01-01T00:00:00.000Z");
  });

  it("orders known tags most-recently-demonstrated first, undemonstrated last (§9.3)", () => {
    ensureConcept(db, "never-shown");
    setTier(db, "older", "trace", "2026-01-01T00:00:00.000Z");
    setTier(db, "newer", "trace", "2026-06-01T00:00:00.000Z");
    expect(listTagsByRecency(db, 60)).toEqual(["newer", "older", "never-shown"]);
  });

  it("caps the tag list at the limit it is given (§9.3)", () => {
    for (let i = 0; i < 70; i++)
      setTier(db, `tag-${i}`, "trace", `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`);
    expect(listTagsByRecency(db, 60)).toHaveLength(60);
  });
});

describe("questions", () => {
  it("writes the row and its file attributions atomically (§13.3)", () => {
    const projectId = seedProject();
    const id = seedQuestion(projectId, { files: ["src/a.ts", "src/b.ts"] });
    expect(getQuestionFiles(db, id)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("round-trips the scaffold as JSON and survives a corrupt one", () => {
    const projectId = seedProject();
    const id = seedQuestion(projectId, { scaffold: ["one", "two"] });
    expect(parseScaffold(getQuestion(db, id)!)).toEqual(["one", "two"]);

    db.prepare("UPDATE questions SET scaffold_json = 'not json' WHERE id = ?").run(id);
    expect(parseScaffold(getQuestion(db, id)!)).toEqual([]);
  });

  it("defaults to pending with no assistance and no answer (§19)", () => {
    const row = getQuestion(db, seedQuestion(seedProject()))!;
    expect(row.status).toBe("pending");
    expect(row.assistance_level).toBe("none");
    expect(row.self_assessment).toBeNull();
    expect(row.answered_at).toBeNull();
  });

  it("records an answer with its assistance level and timestamp", () => {
    const id = seedQuestion(seedProject());
    recordAnswer(db, id, {
      status: "answered",
      self_assessment: "nailed_it",
      assistance_level: "scaffolded",
      user_answer: "my answer",
    });
    const row = getQuestion(db, id)!;
    expect(row.status).toBe("answered");
    expect(row.self_assessment).toBe("nailed_it");
    expect(row.assistance_level).toBe("scaffolded");
    expect(row.user_answer).toBe("my answer");
    expect(row.answered_at).toBeTruthy();
  });

  it("dedups by diff_hash and file_hash (§19)", () => {
    const projectId = seedProject();
    seedQuestion(projectId, { diff_hash: "abc" });
    expect(questionExistsForHash(db, projectId, "diff_hash", "abc")).toBe(true);
    expect(questionExistsForHash(db, projectId, "diff_hash", "other")).toBe(false);
    // Dedup is per project: the same diff in another repo is a new question.
    const other = seedProject("/repo/two");
    expect(questionExistsForHash(db, other, "diff_hash", "abc")).toBe(false);
  });

  it("counts questions per tag excluding synthesis (§11.6 condition 1)", () => {
    const projectId = seedProject();
    seedQuestion(projectId);
    seedQuestion(projectId);
    seedQuestion(projectId, { type: "synthesis", origin: "synthesis" });
    expect(countQuestionsForTag(db, "debouncing")).toBe(2);
  });

  it("counts a rolling window for the hourly cap (§8.1)", () => {
    const projectId = seedProject();
    seedQuestion(projectId);
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    expect(countQuestionsSince(db, hourAgo)).toBe(1);
    expect(countQuestionsSince(db, new Date(Date.now() + 1000).toISOString())).toBe(0);
  });

  it("finds pending questions by staged file, scoped to the project (§13.3)", () => {
    const projectId = seedProject();
    const other = seedProject("/repo/two");
    const staged = seedQuestion(projectId, { files: ["src/auth/mw.ts"] });
    seedQuestion(projectId, { files: ["src/unrelated.ts"] });
    seedQuestion(other, { files: ["src/auth/mw.ts"] });

    const found = findQuestionsForFiles(db, projectId, ["src/auth/mw.ts"]);
    expect(found.map((q) => q.id)).toEqual([staged]);
  });

  it("returns nothing for an empty staged list rather than everything", () => {
    const projectId = seedProject();
    seedQuestion(projectId);
    expect(findQuestionsForFiles(db, projectId, [])).toEqual([]);
  });

  it("excludes answered questions from the pending queue", () => {
    const projectId = seedProject();
    const answered = seedQuestion(projectId);
    recordAnswer(db, answered, {
      status: "answered",
      self_assessment: "mostly_there",
      assistance_level: "none",
      user_answer: null,
    });
    const pending = seedQuestion(projectId);
    expect(listPendingQuestions(db, projectId).map((q) => q.id)).toEqual([pending]);
  });
});

describe("synthesis_clusters (§11.7)", () => {
  it("has no diff_count column — the count is derived (§11.6)", () => {
    const columns = db
      .prepare("PRAGMA table_info(synthesis_clusters)")
      .all()
      .map((c) => (c as { name: string }).name);
    expect(columns).not.toContain("diff_count");
  });

  it("starts not_yet_attempted and ineligible", () => {
    ensureConcept(db, "auth-flow"); // the FK target; §11.6 guarantees it exists first
    const row = ensureCluster(db, "auth-flow");
    expect(row.status).toBe("not_yet_attempted");
    expect(row.eligible).toBe(0);
    expect(row.last_checkpoint_at).toBeNull();
  });

  it("records an outcome and clears eligibility", () => {
    ensureConcept(db, "auth-flow");
    ensureCluster(db, "auth-flow");
    setEligible(db, "auth-flow", true);
    recordCheckpointOutcome(db, "auth-flow", "struggled", 3);
    const row = getCluster(db, "auth-flow")!;
    expect(row.status).toBe("struggled");
    expect(row.count_at_last_checkpoint).toBe(3);
    expect(row.eligible).toBe(0);
    expect(row.last_checkpoint_at).toBeTruthy();
  });

  it("NEVER touches concept mastery — the row is byte-identical after (§11.7)", () => {
    ensureConcept(db, "auth-flow");
    setTier(db, "auth-flow", "predict_break", "2026-01-01T00:00:00.000Z");
    const before = JSON.stringify(getConcept(db, "auth-flow"));

    ensureCluster(db, "auth-flow");
    setEligible(db, "auth-flow", true);
    recordCheckpointOutcome(db, "auth-flow", "passed", 5);

    expect(JSON.stringify(getConcept(db, "auth-flow"))).toBe(before);
  });
});

describe("scan_progress (§12.2)", () => {
  it("upserts progress per file and survives a re-run", () => {
    const projectId = seedProject();
    recordScanProgress(db, {
      project_id: projectId,
      file_path: "src/a.ts",
      file_hash: "h1",
      sections_completed: 1,
      sections_total: 3,
    });
    recordScanProgress(db, {
      project_id: projectId,
      file_path: "src/a.ts",
      file_hash: "h1",
      sections_completed: 3,
      sections_total: 3,
    });
    const row = getScanProgress(db, projectId, "src/a.ts")!;
    expect(row.sections_completed).toBe(3);
    expect(listScanProgress(db, projectId)).toHaveLength(1);
  });
});

describe("generation_failures (§9.6, §19.1)", () => {
  it("stores a replayable payload verbatim", () => {
    const projectId = seedProject();
    const payload = {
      kind: "live",
      projectId,
      files: ["src/a.ts"],
      diff: "@@",
      masteryContext: {},
      knownTags: [],
    };
    const id = recordFailure(db, { projectId, kind: "live", payload, error: "boom" });
    const row = listFailures(db).find((f) => f.id === id)!;
    expect(parsePayload<typeof payload>(row)).toEqual(payload);
    expect(row.attempts).toBe(1);
  });

  it("stops auto-retrying at the attempt ceiling but still reports the row (§19.1)", () => {
    const id = recordFailure(db, { projectId: null, kind: "scan", payload: {}, error: null });
    for (let i = 1; i < MAX_RETRY_ATTEMPTS; i++) recordRetryAttempt(db, id, "again");
    expect(listRetryableFailures(db)).toHaveLength(0);
    expect(listFailures(db)).toHaveLength(1);
  });

  it("deletes on success", () => {
    const id = recordFailure(db, { projectId: null, kind: "live", payload: {}, error: null });
    deleteFailure(db, id);
    expect(listFailures(db)).toHaveLength(0);
  });

  it("returns null for a corrupt payload rather than throwing", () => {
    const id = recordFailure(db, { projectId: null, kind: "live", payload: {}, error: null });
    db.prepare("UPDATE generation_failures SET payload_json = 'not json' WHERE id = ?").run(id);
    expect(parsePayload(listFailures(db)[0])).toBeNull();
  });
});
