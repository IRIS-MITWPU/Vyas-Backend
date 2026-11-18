-- Migration 019: Timetable Planner term building + second home classroom (contract 10).
--
-- planner_terms.building_id        : the building the timetable is made for. NULL (every existing term) = no restriction,
--                                    the room pool decides, as before. When set, only rooms of that building are used.
-- planner_divisions.home_room2_id  : optional SECOND home classroom (home_room_id stays the first one). A division has at most 2.
--
-- Schema only: no data and no rule rows are rewritten. Idempotent (ADD COLUMN IF NOT EXISTS, guarded constraint).

ALTER TABLE planner_terms
  ADD COLUMN IF NOT EXISTS building_id UUID NULL REFERENCES buildings(id) ON DELETE SET NULL;

ALTER TABLE planner_divisions
  ADD COLUMN IF NOT EXISTS home_room2_id UUID NULL REFERENCES rooms(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'planner_divisions_home_rooms_distinct' AND conrelid = 'planner_divisions'::regclass
  ) THEN
    -- NULL-safe: deleting a room only nulls one of the two columns, which can never violate this
    ALTER TABLE planner_divisions
      ADD CONSTRAINT planner_divisions_home_rooms_distinct CHECK (home_room2_id IS NULL OR home_room2_id <> home_room_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_planner_terms_building          ON planner_terms (building_id);
CREATE INDEX IF NOT EXISTS idx_planner_divisions_home_room2    ON planner_divisions (home_room2_id);
