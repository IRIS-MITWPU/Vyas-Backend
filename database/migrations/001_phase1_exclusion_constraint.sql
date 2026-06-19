-- Migration 001: Phase 1 — Add PostgreSQL-level booking overlap protection
-- Run: psql -d <dbname> -f database/migrations/001_phase1_exclusion_constraint.sql
--
-- Step 1.1: Enable GiST support required for exclusion constraints on non-range columns
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Step 1.2: valid_booking_time CHECK
-- Already present as 'bookings_end_after_start' (end_time > start_time) — skipping.

-- Step 1.3: Exclusion constraint — the actual concurrency solution.
-- Atomically prevents two active bookings for the same room from overlapping.
-- '[)' means [start, end): 9:00-10:00 and 10:00-11:00 do NOT conflict.
-- Cancelled/denied bookings are excluded from the constraint so they don't block rebooking.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'no_overlapping_bookings'
      AND conrelid = 'bookings'::regclass
  ) THEN
    ALTER TABLE bookings
    ADD CONSTRAINT no_overlapping_bookings
    EXCLUDE USING gist (
      room_id WITH =,
      tstzrange(start_time, end_time, '[)') WITH &&
    )
    WHERE (status NOT IN ('cancelled', 'denied'));
  END IF;
END $$;
