-- Migration 003: LLM import pipeline reliability — structured progress
-- tracking (Phase 3) and explicit terminal-state failure codes (Phase 4).
-- Run: psql -d <dbname> -f database/migrations/003_llm_import_reliability.sql

ALTER TABLE timetable_import_jobs
  ADD COLUMN IF NOT EXISTS current_chunk INTEGER,
  ADD COLUMN IF NOT EXISTS total_chunks INTEGER,
  ADD COLUMN IF NOT EXISTS current_attempt INTEGER,
  ADD COLUMN IF NOT EXISTS max_attempts INTEGER,
  ADD COLUMN IF NOT EXISTS llm_request_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_progress_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS failure_code VARCHAR(50);
    -- LLM_TIMEOUT | LLM_PROVIDER_ERROR | LLM_RETRIES_EXHAUSTED
    -- | JOB_CANCELLED_BY_USER | JOB_DEADLINE_EXCEEDED | REDIS_ERROR
    -- | PARSING_ERROR | UNKNOWN
