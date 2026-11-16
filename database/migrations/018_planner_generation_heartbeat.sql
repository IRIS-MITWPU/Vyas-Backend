-- Migration 018: Timetable Planner generation runs, liveness + cross-process cancel (Phase 3 review amendments, contract 9.9).
--
-- heartbeat_at     : written by the executing process on every progress/chunk write; the stale-run sweep fails a
--                    queued/running run whose heartbeat is older than 2 minutes (so a long run is never failed while alive).
-- cancel_requested : set by cancelRun when the run is executing in ANOTHER process; the executor polls it.
-- instance_id      : random id of the process that executes the run.
-- Idempotent: ADD COLUMN IF NOT EXISTS only.

ALTER TABLE planner_generation_runs
  ADD COLUMN IF NOT EXISTS heartbeat_at     TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS cancel_requested BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS instance_id      TEXT        NULL;

UPDATE planner_generation_runs
   SET heartbeat_at = COALESCE(started_at, created_at)
 WHERE heartbeat_at IS NULL;
