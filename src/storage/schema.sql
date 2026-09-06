-- Canonical schema. GOVERNED BY: DESIGN_BRIEF.md §19.
-- Copied from §19 verbatim; if you change it, add a migration in db.ts
-- and bump schema_meta.version (§19.2).
--
-- PRAGMAs live in db.ts, not here: §5.4 requires them on EVERY connection,
-- and this file only runs on first creation.

CREATE TABLE schema_meta (
  version INTEGER NOT NULL          -- bump + migrate on any schema change
);

CREATE TABLE projects (
  id INTEGER PRIMARY KEY,
  path TEXT UNIQUE NOT NULL,        -- absolute, resolved, symlink-free
  registered_at TEXT NOT NULL,
  gate_mode TEXT                    -- soft|warn|hard, NULL = use global default
);

-- GLOBAL, not per-project: mastery transfers across repos.
CREATE TABLE concepts (
  tag TEXT PRIMARY KEY,
  tier TEXT NOT NULL DEFAULT 'none',   -- none|trace|predict_break|reconstruct
  last_demonstrated_at TEXT,           -- drives lazy decay; NEVER store computed decay
  first_seen_at TEXT NOT NULL
);

CREATE TABLE questions (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL,                  -- trace|predict_break|reconstruct|synthesis
  concept_tag TEXT REFERENCES concepts(tag),
  origin TEXT NOT NULL,                -- 'live' | 'scan' | 'synthesis'
  batch_id TEXT,                       -- groups questions from one generation call
  diff_hash TEXT,                      -- live dedup
  file_hash TEXT,                      -- scan dedup
  question_text TEXT NOT NULL,
  sample_answer TEXT NOT NULL,
  teaching_card_text TEXT,             -- NULL if none generated
  teaching_card_deeper TEXT,           -- optional depth, shown on request only
  hint TEXT,
  scaffold_json TEXT,                  -- JSON array of sub-questions
  code_snippet TEXT,                   -- diff/section; needed for review + anki export
  author_confidence REAL,              -- 0..1 from §7.6; ordering signal ONLY
  status TEXT NOT NULL DEFAULT 'pending',   -- pending|answered|skipped
  self_assessment TEXT,                -- nailed_it|mostly_there|way_off|NULL
  assistance_level TEXT NOT NULL DEFAULT 'none', -- none|hint|retry|scaffolded
  user_answer TEXT,                    -- retained for `grasp history`; never evaluated
  created_at TEXT NOT NULL,
  answered_at TEXT
);
CREATE INDEX idx_questions_status ON questions(status, created_at);
CREATE INDEX idx_questions_tag ON questions(concept_tag);
CREATE INDEX idx_questions_project ON questions(project_id, status);

-- Join table, not a serialized array: the hard gate queries this against staged
-- filenames on every commit, so it must be indexable.
CREATE TABLE question_files (
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,             -- POSIX-style, relative to project root
  PRIMARY KEY (question_id, file_path)
);
CREATE INDEX idx_question_files_path ON question_files(file_path);

-- Deliberately separate from `concepts`. NEVER joined for scoring.
CREATE TABLE synthesis_clusters (
  tag TEXT PRIMARY KEY REFERENCES concepts(tag) ON DELETE CASCADE,
  eligible INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'not_yet_attempted', -- not_yet_attempted|struggled|passed
  count_at_last_checkpoint INTEGER NOT NULL DEFAULT 0,
  last_checkpoint_at TEXT
  -- diff_count intentionally absent — derive it (§11.6).
);

CREATE TABLE scan_progress (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,             -- POSIX-style, relative to project root
  file_hash TEXT NOT NULL,
  sections_completed INTEGER NOT NULL DEFAULT 0,
  sections_total INTEGER NOT NULL DEFAULT 1,
  last_scanned_at TEXT NOT NULL,
  PRIMARY KEY (project_id, file_path)
);

CREATE TABLE generation_failures (
  id INTEGER PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                  -- 'live' | 'scan' | 'synthesis'
  payload_json TEXT NOT NULL,          -- full re-attemptable input (§19.1)
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 1,
  failed_at TEXT NOT NULL
);
