-- Migration 007: panel-scoped legend backfill for timetable import
-- extraction. A subject code can map to a different teacher in a different
-- panel, so lectures need to carry which panel they came from, and each
-- file needs a durable copy of its per-panel legend lookups so a later
-- retry-failed-chunks job (a separate worker invocation with no access to
-- the original in-memory legend data) can still backfill recovered lectures.
-- Run: psql -d <dbname> -f database/migrations/007_panel_legend_backfill.sql

ALTER TABLE timetable_extracted_lectures
  ADD COLUMN IF NOT EXISTS panel_label VARCHAR(200),
  ADD COLUMN IF NOT EXISTS sheet_name VARCHAR(200),
  ADD COLUMN IF NOT EXISTS legend_backfilled BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE timetable_import_files
  ADD COLUMN IF NOT EXISTS panel_legend JSONB DEFAULT '[]'::jsonb;
