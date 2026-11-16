-- Migration 017: Timetable Planner generation runs (Phase 3, contract section 9).
--
-- One row per "Generate timetable" run of the planner. It carries the progress the UI polls, the result
-- (stats, unplaced sessions with reason codes) and the placements of the touched sessions BEFORE the run
-- (so "Undo last generation" can restore them). At most one queued/running run per version.
-- Idempotent: CREATE ... IF NOT EXISTS only.

CREATE TABLE IF NOT EXISTS planner_generation_runs (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id        UUID        NOT NULL REFERENCES planner_versions(id) ON DELETE CASCADE,
  term_id           UUID        NOT NULL REFERENCES planner_terms(id)    ON DELETE CASCADE,
  mode              TEXT        NOT NULL,
  scope             JSONB       NOT NULL DEFAULT '{}'::jsonb,
  options           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  seed              INT         NOT NULL DEFAULT 1,
  status            TEXT        NOT NULL DEFAULT 'queued',
  stage             TEXT        NULL,
  progress_percent  INT         NOT NULL DEFAULT 0,
  stats             JSONB       NOT NULL DEFAULT '{}'::jsonb,
  unplaced          JSONB       NOT NULL DEFAULT '[]'::jsonb,
  before_placements JSONB       NOT NULL DEFAULT '[]'::jsonb,
  after_placements  JSONB       NOT NULL DEFAULT '[]'::jsonb,
  after_rev         BIGINT      NULL,
  undone_at         TIMESTAMPTZ NULL,
  error_code        TEXT        NULL,
  error_message     TEXT        NULL,
  created_by        UUID        NULL REFERENCES profiles(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at        TIMESTAMPTZ NULL,
  finished_at       TIMESTAMPTZ NULL,
  CONSTRAINT planner_generation_runs_mode_check
    CHECK (mode IN ('fill_unplaced', 'regenerate_unlocked')),
  CONSTRAINT planner_generation_runs_status_check
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  CONSTRAINT planner_generation_runs_progress_check
    CHECK (progress_percent BETWEEN 0 AND 100)
);

-- one active run per version
CREATE UNIQUE INDEX IF NOT EXISTS uq_planner_generation_runs_active
  ON planner_generation_runs (version_id) WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS idx_planner_generation_runs_version
  ON planner_generation_runs (version_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_planner_generation_runs_term
  ON planner_generation_runs (term_id);
CREATE INDEX IF NOT EXISTS idx_planner_generation_runs_created_by
  ON planner_generation_runs (created_by);
