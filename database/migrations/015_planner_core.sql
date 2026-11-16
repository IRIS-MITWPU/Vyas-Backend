-- Migration 015: Timetable Planner core schema (Phase 1).
--
-- Adds every planner_* table: terms, term room pool, global faculty, divisions,
-- batches, subjects, offerings (+ faculty per offering), versions, sessions
-- (+ session faculty), occupancy (exclusion-constrained, unused until Phase 2)
-- and per-term rule config. Nothing existing is altered; room_timetable_templates
-- and bookings are untouched. Idempotent (IF NOT EXISTS / DROP TRIGGER IF EXISTS):
-- safe on top of the current DB, twice in a row, and on a fresh DB where
-- schema.sql (which contains the same DDL) was already applied.
--
-- Conventions: TEXT + CHECK instead of Postgres enums; *_min = minutes since
-- midnight; weekday 0=Mon .. 6=Sun (same as room_timetable_templates.weekday).
-- Relies on: btree_gist (schema.sql), update_updated_at_column() (schema.sql),
-- profiles and rooms.

-- BEGIN PLANNER DDL
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ------------------------------------------------------------
-- planner_terms
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS planner_terms (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  academic_year  TEXT        NOT NULL,                       -- e.g. '2026-27'
  half           TEXT        NOT NULL,
  branch         TEXT        NOT NULL DEFAULT 'CSE',
  start_date     DATE,
  end_date       DATE,
  working_days   SMALLINT[]  NOT NULL DEFAULT '{0,1,2,3,4}',
  day_start_min  INT         NOT NULL DEFAULT 510,
  day_end_min    INT         NOT NULL DEFAULT 1065,
  grid_minutes   INT         NOT NULL DEFAULT 15,
  theory_minutes INT         NOT NULL DEFAULT 60,
  lab_minutes    INT         NOT NULL DEFAULT 120,
  breaks         JSONB       NOT NULL DEFAULT '[{"start_min":630,"end_min":645,"label":"Short break 1"},{"start_min":765,"end_min":810,"label":"Lunch"},{"start_min":930,"end_min":945,"label":"Short break 2"}]'::jsonb,
  created_by     UUID        REFERENCES profiles(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT planner_terms_half_check          CHECK (half IN ('odd', 'even')),
  CONSTRAINT planner_terms_unique_term         UNIQUE (academic_year, half, branch),
  CONSTRAINT planner_terms_day_order_check     CHECK (day_start_min < day_end_min),
  CONSTRAINT planner_terms_grid_check          CHECK (grid_minutes > 0),
  CONSTRAINT planner_terms_theory_check        CHECK (theory_minutes > 0),
  CONSTRAINT planner_terms_lab_check           CHECK (lab_minutes > 0),
  CONSTRAINT planner_terms_dates_check         CHECK (start_date IS NULL OR end_date IS NULL OR start_date <= end_date),
  CONSTRAINT planner_terms_working_days_check  CHECK (cardinality(working_days) >= 1
                                                      AND working_days <@ ARRAY[0,1,2,3,4,5,6]::smallint[]),
  CONSTRAINT planner_terms_breaks_check        CHECK (jsonb_typeof(breaks) = 'array')
);

-- ------------------------------------------------------------
-- planner_term_rooms  (room pool of a term)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS planner_term_rooms (
  id       UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  term_id  UUID    NOT NULL REFERENCES planner_terms(id) ON DELETE CASCADE,
  room_id  UUID    NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  is_lab   BOOLEAN NOT NULL,
  CONSTRAINT planner_term_rooms_unique UNIQUE (term_id, room_id)
);

-- ------------------------------------------------------------
-- planner_faculty  (GLOBAL — shared across terms)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS planner_faculty (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id   UUID        REFERENCES profiles(id) ON DELETE SET NULL,
  short_code   TEXT        NOT NULL,
  full_name    TEXT        NOT NULL,
  email        TEXT,
  department   TEXT,
  max_per_day  INT,
  max_per_week INT,
  is_active    BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT planner_faculty_profile_unique     UNIQUE (profile_id),
  CONSTRAINT planner_faculty_email_lower        CHECK (email = lower(email)),
  CONSTRAINT planner_faculty_max_per_day_check  CHECK (max_per_day > 0),
  CONSTRAINT planner_faculty_max_per_week_check CHECK (max_per_week > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_planner_faculty_short_code_lower
  ON planner_faculty (lower(short_code));

-- ------------------------------------------------------------
-- planner_divisions / planner_batches
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS planner_divisions (
  id            UUID     PRIMARY KEY DEFAULT gen_random_uuid(),
  term_id       UUID     NOT NULL REFERENCES planner_terms(id) ON DELETE CASCADE,
  semester      SMALLINT NOT NULL,
  name          TEXT     NOT NULL,
  student_count INT      NOT NULL DEFAULT 0,
  home_room_id  UUID     REFERENCES rooms(id) ON DELETE SET NULL,
  CONSTRAINT planner_divisions_semester_check      CHECK (semester BETWEEN 1 AND 12),
  CONSTRAINT planner_divisions_student_count_check CHECK (student_count >= 0),
  CONSTRAINT planner_divisions_unique              UNIQUE (term_id, semester, name)
);

CREATE TABLE IF NOT EXISTS planner_batches (
  id            UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  division_id   UUID    NOT NULL REFERENCES planner_divisions(id) ON DELETE CASCADE,
  name          TEXT    NOT NULL,
  student_count INT     NOT NULL DEFAULT 0,
  is_whole      BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT planner_batches_student_count_check CHECK (student_count >= 0),
  CONSTRAINT planner_batches_unique              UNIQUE (division_id, name)
);
-- exactly one hidden whole batch (name 'ALL') per division, maintained by the API
CREATE UNIQUE INDEX IF NOT EXISTS uq_planner_batches_one_whole
  ON planner_batches (division_id) WHERE is_whole;

-- ------------------------------------------------------------
-- planner_subjects / planner_offerings / planner_offering_faculty
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS planner_subjects (
  id               UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  term_id          UUID    NOT NULL REFERENCES planner_terms(id) ON DELETE CASCADE,
  code             TEXT    NOT NULL,
  name             TEXT    NOT NULL,
  kind             TEXT    NOT NULL,
  duration_min     INT     NOT NULL,
  weekly_count     INT     NOT NULL DEFAULT 1,
  semester_total   INT,
  allow_second_lab BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT planner_subjects_kind_check           CHECK (kind IN ('theory', 'lab')),
  CONSTRAINT planner_subjects_duration_check       CHECK (duration_min > 0),
  CONSTRAINT planner_subjects_weekly_count_check   CHECK (weekly_count >= 0),
  CONSTRAINT planner_subjects_semester_total_check CHECK (semester_total >= 0),
  CONSTRAINT planner_subjects_unique               UNIQUE (term_id, code)
);

CREATE TABLE IF NOT EXISTS planner_offerings (
  id           UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  division_id  UUID    NOT NULL REFERENCES planner_divisions(id) ON DELETE CASCADE,
  subject_id   UUID    NOT NULL REFERENCES planner_subjects(id) ON DELETE CASCADE,
  weekly_count INT,                                          -- NULL = use the subject's
  per_batch    BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT planner_offerings_weekly_count_check CHECK (weekly_count >= 0),
  CONSTRAINT planner_offerings_unique             UNIQUE (division_id, subject_id)
);

CREATE TABLE IF NOT EXISTS planner_offering_faculty (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  offering_id UUID NOT NULL REFERENCES planner_offerings(id) ON DELETE CASCADE,
  batch_id    UUID REFERENCES planner_batches(id) ON DELETE CASCADE,  -- NULL = every batch
  faculty_id  UUID NOT NULL REFERENCES planner_faculty(id) ON DELETE NO ACTION,
  role        TEXT NOT NULL DEFAULT 'lead',
  CONSTRAINT planner_offering_faculty_role_check CHECK (role IN ('lead', 'assist'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_planner_offering_faculty
  ON planner_offering_faculty (offering_id, COALESCE(batch_id, '00000000-0000-0000-0000-000000000000'::uuid), faculty_id);

-- ------------------------------------------------------------
-- planner_versions
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS planner_versions (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  term_id      UUID        NOT NULL REFERENCES planner_terms(id) ON DELETE CASCADE,
  version_no   INT         NOT NULL,
  status       TEXT        NOT NULL DEFAULT 'draft',
  based_on_id  UUID        REFERENCES planner_versions(id) ON DELETE SET NULL,
  rev          BIGINT      NOT NULL DEFAULT 0,
  published_at TIMESTAMPTZ,
  published_by UUID        REFERENCES profiles(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT planner_versions_status_check CHECK (status IN ('draft', 'published', 'historical')),
  CONSTRAINT planner_versions_unique       UNIQUE (term_id, version_no)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_planner_versions_one_draft
  ON planner_versions (term_id) WHERE status = 'draft';
CREATE UNIQUE INDEX IF NOT EXISTS uq_planner_versions_one_published
  ON planner_versions (term_id) WHERE status = 'published';

-- ------------------------------------------------------------
-- planner_sessions / planner_session_faculty
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS planner_sessions (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id  UUID        NOT NULL REFERENCES planner_versions(id) ON DELETE CASCADE,
  offering_id UUID        NOT NULL REFERENCES planner_offerings(id) ON DELETE NO ACTION,
  batch_id    UUID        NOT NULL REFERENCES planner_batches(id) ON DELETE NO ACTION,
  seq         INT         NOT NULL,
  weekday     SMALLINT,
  start_min   INT,
  end_min     INT,
  room_id     UUID        REFERENCES rooms(id) ON DELETE NO ACTION,
  locked      BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT planner_sessions_seq_check       CHECK (seq >= 1),
  CONSTRAINT planner_sessions_unique          UNIQUE (version_id, offering_id, batch_id, seq),
  -- placement is all-or-none
  CONSTRAINT planner_sessions_placement_check CHECK (num_nonnulls(weekday, start_min, end_min, room_id) IN (0, 4)),
  CONSTRAINT planner_sessions_weekday_check   CHECK (weekday BETWEEN 0 AND 6),
  CONSTRAINT planner_sessions_time_order_check CHECK (end_min > start_min),
  CONSTRAINT planner_sessions_grid_check      CHECK (start_min % 15 = 0)   -- 15-min grid is hard-wired
);

CREATE TABLE IF NOT EXISTS planner_session_faculty (
  session_id UUID NOT NULL REFERENCES planner_sessions(id) ON DELETE CASCADE,
  faculty_id UUID NOT NULL REFERENCES planner_faculty(id) ON DELETE NO ACTION,
  PRIMARY KEY (session_id, faculty_id)
);

-- ------------------------------------------------------------
-- planner_occupancy  (no code writes here in Phase 1)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS planner_occupancy (
  id          UUID     PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id  UUID     NOT NULL REFERENCES planner_versions(id) ON DELETE CASCADE,
  session_id  UUID     NOT NULL REFERENCES planner_sessions(id) ON DELETE CASCADE,
  kind        TEXT     NOT NULL,
  resource_id UUID     NOT NULL,
  weekday     SMALLINT NOT NULL,
  during      INT4RANGE NOT NULL,
  CONSTRAINT planner_occupancy_kind_check    CHECK (kind IN ('faculty', 'room', 'batch')),
  CONSTRAINT planner_occupancy_weekday_check CHECK (weekday BETWEEN 0 AND 6),
  CONSTRAINT planner_occupancy_no_overlap
    EXCLUDE USING gist (version_id WITH =, kind WITH =, resource_id WITH =, weekday WITH =, during WITH &&)
    DEFERRABLE INITIALLY IMMEDIATE
);
CREATE INDEX IF NOT EXISTS idx_planner_occupancy_lookup
  ON planner_occupancy (version_id, kind, resource_id, weekday);

-- ------------------------------------------------------------
-- planner_rule_config
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS planner_rule_config (
  id        UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  term_id   UUID    NOT NULL REFERENCES planner_terms(id) ON DELETE CASCADE,
  rule_key  TEXT    NOT NULL,
  enabled   BOOLEAN NOT NULL DEFAULT TRUE,
  severity  TEXT    NOT NULL,
  weight    INT     NOT NULL DEFAULT 1,
  params    JSONB   NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT planner_rule_config_severity_check CHECK (severity IN ('blocking', 'hard', 'soft')),
  CONSTRAINT planner_rule_config_unique         UNIQUE (term_id, rule_key)
);

-- ------------------------------------------------------------
-- FK / lookup indexes (columns not already leading a unique index)
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_planner_terms_created_by         ON planner_terms (created_by);
CREATE INDEX IF NOT EXISTS idx_planner_term_rooms_room          ON planner_term_rooms (room_id);
CREATE INDEX IF NOT EXISTS idx_planner_divisions_term           ON planner_divisions (term_id);
CREATE INDEX IF NOT EXISTS idx_planner_divisions_home_room      ON planner_divisions (home_room_id);
CREATE INDEX IF NOT EXISTS idx_planner_offerings_division       ON planner_offerings (division_id);
CREATE INDEX IF NOT EXISTS idx_planner_offerings_subject        ON planner_offerings (subject_id);
CREATE INDEX IF NOT EXISTS idx_planner_offering_faculty_faculty ON planner_offering_faculty (faculty_id);
CREATE INDEX IF NOT EXISTS idx_planner_offering_faculty_batch   ON planner_offering_faculty (batch_id);
CREATE INDEX IF NOT EXISTS idx_planner_versions_based_on        ON planner_versions (based_on_id);
CREATE INDEX IF NOT EXISTS idx_planner_sessions_version         ON planner_sessions (version_id);
CREATE INDEX IF NOT EXISTS idx_planner_sessions_offering        ON planner_sessions (offering_id);
CREATE INDEX IF NOT EXISTS idx_planner_sessions_batch           ON planner_sessions (batch_id);
CREATE INDEX IF NOT EXISTS idx_planner_sessions_room            ON planner_sessions (room_id);
CREATE INDEX IF NOT EXISTS idx_planner_session_faculty_faculty  ON planner_session_faculty (faculty_id);
CREATE INDEX IF NOT EXISTS idx_planner_occupancy_session        ON planner_occupancy (session_id);

-- ------------------------------------------------------------
-- updated_at triggers (shared update_updated_at_column())
-- ------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_planner_terms_updated_at ON planner_terms;
CREATE TRIGGER trg_planner_terms_updated_at
    BEFORE UPDATE ON planner_terms
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS trg_planner_faculty_updated_at ON planner_faculty;
CREATE TRIGGER trg_planner_faculty_updated_at
    BEFORE UPDATE ON planner_faculty
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS trg_planner_sessions_updated_at ON planner_sessions;
CREATE TRIGGER trg_planner_sessions_updated_at
    BEFORE UPDATE ON planner_sessions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
-- END PLANNER DDL
