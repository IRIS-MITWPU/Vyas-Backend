-- Migration 006: track LLM chunks that exhausted retries during timetable
-- import extraction, so the review UI can surface what may be missing and
-- an admin can retry just those sections instead of the whole file.
-- Run: psql -d <dbname> -f database/migrations/006_chunk_failure_tracking.sql

ALTER TABLE timetable_import_files
  ADD COLUMN IF NOT EXISTS failed_chunks JSONB DEFAULT '[]'::jsonb;
