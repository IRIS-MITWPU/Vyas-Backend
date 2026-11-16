-- Migration 016: Timetable Planner lab-room sharing (contract 8.7).
--
-- A big lab (capacity ~62) may host several batches at the same time. Such a room row is written to
-- planner_occupancy with the new kind 'lab_room'. Two changes:
--   1. planner_occupancy_kind_check also allows 'lab_room';
--   2. planner_occupancy_no_overlap no longer applies to 'lab_room' rows (WHERE kind <> 'lab_room'). Exclusive
--      kinds (faculty, room, batch) are still protected by it. The capacity of a shared room is checked by the
--      editor service under the version-row lock, not by the database.
--
-- Migration 015 is NOT edited. Idempotent: each change is guarded by an inspection of the stored constraint
-- definition, so a second run (or a fresh database whose schema.sql already contains the final state) changes
-- nothing. Existing rows stay valid: the new CHECK is a superset and the new exclusion is weaker.

DO $$
DECLARE
  def TEXT;
BEGIN
  -- 1. kind CHECK
  SELECT pg_get_constraintdef(c.oid) INTO def
    FROM pg_constraint c
   WHERE c.conrelid = 'planner_occupancy'::regclass AND c.conname = 'planner_occupancy_kind_check';
  IF def IS NULL OR def NOT LIKE '%lab_room%' THEN
    ALTER TABLE planner_occupancy DROP CONSTRAINT IF EXISTS planner_occupancy_kind_check;
    ALTER TABLE planner_occupancy
      ADD CONSTRAINT planner_occupancy_kind_check CHECK (kind IN ('faculty', 'room', 'batch', 'lab_room'));
  END IF;

  -- 2. exclusion constraint: same columns, but not for shared lab rows
  SELECT pg_get_constraintdef(c.oid) INTO def
    FROM pg_constraint c
   WHERE c.conrelid = 'planner_occupancy'::regclass AND c.conname = 'planner_occupancy_no_overlap';
  IF def IS NULL OR def NOT LIKE '%lab_room%' THEN
    ALTER TABLE planner_occupancy DROP CONSTRAINT IF EXISTS planner_occupancy_no_overlap;
    ALTER TABLE planner_occupancy
      ADD CONSTRAINT planner_occupancy_no_overlap
      EXCLUDE USING gist (version_id WITH =, kind WITH =, resource_id WITH =, weekday WITH =, during WITH &&)
      WHERE (kind <> 'lab_room')
      DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;
