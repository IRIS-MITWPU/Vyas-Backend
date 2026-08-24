-- Migration 004: overall wall-clock deadline tracking for import jobs (Phase 5
-- of llm-import-reliability-implementation-guide.md).
-- Run: psql -d <dbname> -f database/migrations/004_import_job_deadline.sql

ALTER TABLE timetable_import_jobs
  ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ;
