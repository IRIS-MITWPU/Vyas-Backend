-- database/schema.sql
-- Vyas-Backend Database Schema
-- PostgreSQL 13+ (uses gen_random_uuid() built-in)
-- Run: psql -d <dbname> -f database/schema.sql
-- This schema mirrors the Supabase production DB with Supabase-specific features
-- (auth.users FK, RLS, auth.uid()) replaced by backend-native equivalents.

-- ============================================================
-- EXTENSIONS
-- ============================================================

-- Required for EXCLUDE USING gist (room_id WITH =, ...) on a non-range column
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ============================================================
-- ENUMS
-- ============================================================

DO $$ BEGIN
    CREATE TYPE room_type AS ENUM (
        'classroom', 'lab', 'auditorium', 'conference', 'seminar', 'discussion'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE booking_status AS ENUM (
        'confirmed', 'pending', 'denied', 'cancelled'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================
-- PROFILES
-- ============================================================

CREATE TABLE IF NOT EXISTS profiles (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name   TEXT        NOT NULL,
  email       TEXT        UNIQUE NOT NULL,
  department  TEXT,
  is_admin    BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- USER AUTH  (password hashes — custom backend auth, not Supabase)
-- ============================================================

CREATE TABLE IF NOT EXISTS user_auth (
  user_id       UUID        PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  password_hash TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- BUILDINGS
-- ============================================================

CREATE TABLE IF NOT EXISTS buildings (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT        UNIQUE NOT NULL,
  address     TEXT,
  description TEXT,
  is_active   BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- FLOORS
-- (Supabase equivalent column: "number" — kept as "floor_number" here
--  to match existing backend query code)
-- ============================================================

CREATE TABLE IF NOT EXISTS floors (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  building_id  UUID        NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
  floor_number INT         NOT NULL,
  name         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (floor_number, building_id)
);

-- ============================================================
-- ROOMS
-- ============================================================

CREATE TABLE IF NOT EXISTS rooms (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT        NOT NULL,
  floor_id          UUID        NOT NULL REFERENCES floors(id) ON DELETE CASCADE,
  room_type         room_type   NOT NULL,
  capacity          INT,
  equipment         TEXT[],
  is_active         BOOLEAN     NOT NULL DEFAULT TRUE,
  requires_approval BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- BOOKINGS
-- template_id FK is deferred — added after room_timetable_templates is created
-- ============================================================

CREATE TABLE IF NOT EXISTS bookings (
  id                    UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id               UUID           NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  teacher_id            UUID           NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title                 TEXT           NOT NULL,
  description           TEXT,
  start_time            TIMESTAMPTZ    NOT NULL,
  end_time              TIMESTAMPTZ    NOT NULL,
  class_division        TEXT,
  panel                 TEXT,
  year_course           TEXT,
  is_recurring          BOOLEAN        NOT NULL DEFAULT FALSE,
  status                booking_status NOT NULL DEFAULT 'confirmed',
  approved_by           UUID           REFERENCES profiles(id),
  approved_at           TIMESTAMPTZ,
  template_id           UUID,
  template_teacher_name TEXT,
  generated_for_week    DATE,
  created_at            TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  CONSTRAINT bookings_end_after_start CHECK (end_time > start_time)
);

-- Exclusion constraint: atomically prevents overlapping active bookings for the same room.
-- '[)' = [start, end): back-to-back bookings (9:00-10:00, 10:00-11:00) do NOT conflict.
-- Applied only to non-cancelled, non-denied bookings so cancelled slots can be rebooked.
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

-- ============================================================
-- BOOKING INVITEES
-- ============================================================

CREATE TABLE IF NOT EXISTS booking_invitees (
  booking_id UUID        NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  invitee_id UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (booking_id, invitee_id)
);

-- ============================================================
-- ROOM TIMETABLE TEMPLATES
-- ============================================================

CREATE TABLE IF NOT EXISTS room_timetable_templates (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id               UUID        NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  teacher_name          TEXT        NOT NULL,
  title                 TEXT        NOT NULL,
  -- weekday: 0=Monday … 6=Sunday (matches JS Date.getDay() - 1)
  weekday               SMALLINT    NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time            TIME        NOT NULL,
  duration_minutes      INT         NOT NULL CHECK (duration_minutes > 0),
  notes                 TEXT,
  repeat_interval_weeks INT         NOT NULL DEFAULT 2 CHECK (repeat_interval_weeks > 0),
  effective_from        DATE        NOT NULL DEFAULT CURRENT_DATE,
  is_active             BOOLEAN     NOT NULL DEFAULT TRUE,
  created_by            UUID        REFERENCES profiles(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- ROOM TIMETABLE TEMPLATE EXCEPTIONS
-- ============================================================

CREATE TABLE IF NOT EXISTS room_timetable_template_exceptions (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id         UUID        NOT NULL REFERENCES room_timetable_templates(id) ON DELETE CASCADE,
  week_start_date     DATE        NOT NULL,
  resolved_booking_id UUID        REFERENCES bookings(id) ON DELETE SET NULL,
  reason              TEXT,
  created_by          UUID        REFERENCES profiles(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (template_id, week_start_date)
);

-- Deferred FK: bookings.template_id → room_timetable_templates.id
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'bookings_template_id_fkey'
          AND table_name = 'bookings'
    ) THEN
        ALTER TABLE bookings
            ADD CONSTRAINT bookings_template_id_fkey
            FOREIGN KEY (template_id)
            REFERENCES room_timetable_templates(id)
            ON DELETE SET NULL;
    END IF;
END $$;

-- ============================================================
-- PASSWORD RESET TOKENS  (custom — not in Supabase schema)
-- ============================================================

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  token      TEXT        NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- FUNCTIONS
-- ============================================================

-- Auto-update updated_at on every row UPDATE
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Prevent two confirmed/pending bookings for the same room overlapping in time
CREATE OR REPLACE FUNCTION check_booking_overlap()
RETURNS TRIGGER AS $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM bookings
        WHERE room_id = NEW.room_id
          AND id      != COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000')
          AND status NOT IN ('cancelled', 'denied')
          AND (
              (NEW.start_time >= start_time AND NEW.start_time < end_time)
              OR (NEW.end_time   > start_time AND NEW.end_time  <= end_time)
              OR (NEW.start_time <= start_time AND NEW.end_time  >= end_time)
          )
    ) THEN
        RAISE EXCEPTION 'Booking conflict: Room % is already booked for the requested time period', NEW.room_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Prevent the same teacher from having two overlapping bookings
CREATE OR REPLACE FUNCTION check_user_booking_conflict()
RETURNS TRIGGER AS $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM bookings
        WHERE teacher_id = NEW.teacher_id
          AND id         != COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000')
          AND status NOT IN ('cancelled', 'denied')
          AND (
              (NEW.start_time >= start_time AND NEW.start_time < end_time)
              OR (NEW.end_time   > start_time AND NEW.end_time  <= end_time)
              OR (NEW.start_time <= start_time AND NEW.end_time  >= end_time)
          )
    ) THEN
        RAISE EXCEPTION 'User booking conflict: You already have a booking that overlaps with this time period';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Enforce booking business rules (hours, weekdays, not-in-past)
-- Times are evaluated in IST (Asia/Kolkata) to match the MIT WPU locale.
CREATE OR REPLACE FUNCTION validate_booking_times()
RETURNS TRIGGER AS $$
DECLARE
    start_hour   INT;
    start_minute INT;
    end_hour     INT;
    end_minute   INT;
BEGIN
    IF NEW.start_time <= NOW() THEN
        RAISE EXCEPTION 'Cannot create bookings in the past';
    END IF;

    -- DOW: 0=Sunday, 6=Saturday
    IF EXTRACT(DOW FROM NEW.start_time AT TIME ZONE 'Asia/Kolkata') IN (0, 6) THEN
        RAISE EXCEPTION 'Bookings are not allowed on weekends';
    END IF;

    start_hour   := EXTRACT(HOUR   FROM NEW.start_time AT TIME ZONE 'Asia/Kolkata');
    start_minute := EXTRACT(MINUTE FROM NEW.start_time AT TIME ZONE 'Asia/Kolkata');
    end_hour     := EXTRACT(HOUR   FROM NEW.end_time   AT TIME ZONE 'Asia/Kolkata');
    end_minute   := EXTRACT(MINUTE FROM NEW.end_time   AT TIME ZONE 'Asia/Kolkata');

    IF start_hour < 7 OR (start_hour = 7 AND start_minute < 30) THEN
        RAISE EXCEPTION 'Bookings cannot start before 7:30 AM';
    END IF;

    IF end_hour > 22 OR (end_hour = 22 AND end_minute > 30) THEN
        RAISE EXCEPTION 'Bookings cannot end after 10:30 PM';
    END IF;

    IF NEW.end_time <= NEW.start_time THEN
        RAISE EXCEPTION 'End time must be after start time';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Returns all timetable slots (template-generated + ad-hoc bookings) for a room and week.
-- Slots with exceptions (cancellations) are returned with slot_type='exception_cancelled'.
-- Times are expanded into Asia/Kolkata so that stored TIME values display correctly.
CREATE OR REPLACE FUNCTION get_effective_timetable(
    p_room_id    UUID,
    p_week_start DATE
)
RETURNS TABLE (
    slot_id        UUID,
    slot_type      TEXT,
    start_time     TIMESTAMPTZ,
    end_time       TIMESTAMPTZ,
    title          TEXT,
    teacher_name   TEXT,
    description    TEXT,
    class_division TEXT,
    panel          TEXT,
    year_course    TEXT,
    template_id    UUID,
    booking_id     UUID,
    is_cancelled   BOOLEAN
) AS $$
DECLARE
    week_end DATE;
BEGIN
    week_end := p_week_start + INTERVAL '6 days';

    RETURN QUERY
    WITH week_dates AS (
        SELECT generate_series(
            p_week_start::timestamp,
            (week_end + INTERVAL '1 day')::timestamp,
            INTERVAL '1 day'
        )::date AS day
    ),
    template_slots AS (
        SELECT
            t.id        AS slot_id,
            'template'::TEXT AS slot_type,
            ((wd.day::text || ' ' || t.start_time::text)::timestamp
                AT TIME ZONE 'Asia/Kolkata')::timestamptz AS start_time,
            (((wd.day::text || ' ' || t.start_time::text)::timestamp
                + (t.duration_minutes || ' minutes')::interval)
                AT TIME ZONE 'Asia/Kolkata')::timestamptz AS end_time,
            t.title,
            t.teacher_name,
            t.notes        AS description,
            NULL::TEXT     AS class_division,
            NULL::TEXT     AS panel,
            NULL::TEXT     AS year_course,
            t.id           AS template_id,
            NULL::UUID     AS booking_id,
            FALSE          AS is_cancelled
        FROM room_timetable_templates t
        CROSS JOIN week_dates wd
        WHERE t.room_id        = p_room_id
          AND t.is_active      = true
          AND t.effective_from <= wd.day
          -- ISODOW: Monday=1…Sunday=7; weekday column: 0=Monday…6=Sunday
          AND (EXTRACT(ISODOW FROM wd.day) - 1) = t.weekday
          AND (
              t.repeat_interval_weeks = 1
              OR MOD(
                  (DATE_TRUNC('week', wd.day)::date
                   - DATE_TRUNC('week', t.effective_from)::date) / 7,
                  t.repeat_interval_weeks
              ) = 0
          )
    ),
    exceptions AS (
        SELECT e.template_id, e.week_start_date
        FROM room_timetable_template_exceptions e
        WHERE e.week_start_date = p_week_start
    ),
    active_template_slots AS (
        SELECT ts.*
        FROM template_slots ts
        WHERE NOT EXISTS (
            SELECT 1 FROM exceptions e WHERE e.template_id = ts.template_id
        )
    ),
    booking_slots AS (
        SELECT
            b.id  AS slot_id,
            'booking'::TEXT AS slot_type,
            b.start_time,
            b.end_time,
            b.title,
            COALESCE(b.template_teacher_name, p.full_name) AS teacher_name,
            b.description,
            b.class_division,
            b.panel,
            b.year_course,
            NULL::UUID AS template_id,
            b.id       AS booking_id,
            FALSE      AS is_cancelled
        FROM bookings b
        LEFT JOIN profiles p ON p.id = b.teacher_id
        WHERE b.room_id    = p_room_id
          AND b.status     = 'confirmed'
          AND b.start_time >= p_week_start::timestamptz
          AND b.start_time <  (week_end + INTERVAL '1 day')::timestamptz
    ),
    cancelled_slots AS (
        SELECT
            ts.slot_id,
            'exception_cancelled'::TEXT AS slot_type,
            ts.start_time,
            ts.end_time,
            ts.title,
            ts.teacher_name,
            ts.description,
            ts.class_division,
            ts.panel,
            ts.year_course,
            ts.template_id,
            NULL::UUID AS booking_id,
            TRUE       AS is_cancelled
        FROM template_slots ts
        INNER JOIN exceptions e ON e.template_id = ts.template_id
    )
    SELECT * FROM active_template_slots
    UNION ALL
    SELECT * FROM booking_slots
    UNION ALL
    SELECT * FROM cancelled_slots
    ORDER BY start_time;
END;
$$ LANGUAGE plpgsql;

-- Returns TRUE if the time slot is free for the given room (checks both confirmed
-- bookings and active timetable templates for the week).
CREATE OR REPLACE FUNCTION check_slot_availability(
    p_room_id             UUID,
    p_start_time          TIMESTAMPTZ,
    p_end_time            TIMESTAMPTZ,
    p_exclude_booking_id  UUID DEFAULT NULL
)
RETURNS BOOLEAN AS $$
DECLARE
    week_start    DATE;
    slot_overlaps BOOLEAN;
BEGIN
    -- Normalise to the Monday of the week containing p_start_time
    week_start := DATE_TRUNC('week', p_start_time::date)::date;
    IF EXTRACT(DOW FROM week_start) != 1 THEN
        week_start := week_start
            - INTERVAL '1 day' * (EXTRACT(DOW FROM week_start)::int - 1);
    END IF;

    SELECT EXISTS (
        SELECT 1
        FROM get_effective_timetable(p_room_id, week_start) et
        WHERE et.slot_type   != 'exception_cancelled'
          AND et.is_cancelled = false
          AND et.start_time   < p_end_time
          AND et.end_time     > p_start_time
          AND (p_exclude_booking_id IS NULL OR et.booking_id != p_exclude_booking_id)
    ) INTO slot_overlaps;

    RETURN NOT slot_overlaps;
END;
$$ LANGUAGE plpgsql;

-- Cancel a timetable template for one specific week.
-- Unlike the Supabase version, this accepts p_user_id explicitly (the backend
-- passes the JWT-verified user ID instead of using auth.uid()).
CREATE OR REPLACE FUNCTION create_template_exception(
    p_template_id     UUID,
    p_week_start_date DATE,
    p_user_id         UUID,
    p_reason          TEXT DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
    v_teacher_name TEXT;
    v_user_name    TEXT;
    v_exception_id UUID;
BEGIN
    SELECT teacher_name INTO v_teacher_name
    FROM room_timetable_templates
    WHERE id = p_template_id;

    IF v_teacher_name IS NULL THEN
        RAISE EXCEPTION 'Template not found';
    END IF;

    SELECT full_name INTO v_user_name
    FROM profiles
    WHERE id = p_user_id;

    IF NOT (
        EXISTS (SELECT 1 FROM profiles WHERE id = p_user_id AND is_admin = true)
        OR LOWER(COALESCE(v_user_name, '')) = LOWER(v_teacher_name)
    ) THEN
        RAISE EXCEPTION 'Permission denied: Only admins or the template teacher can create exceptions';
    END IF;

    INSERT INTO room_timetable_template_exceptions (
        template_id, week_start_date, reason, created_by
    ) VALUES (
        p_template_id, p_week_start_date, p_reason, p_user_id
    )
    ON CONFLICT (template_id, week_start_date) DO UPDATE
        SET reason     = COALESCE(EXCLUDED.reason, room_timetable_template_exceptions.reason),
            updated_at = NOW()
    RETURNING id INTO v_exception_id;

    RETURN v_exception_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- TRIGGERS
-- ============================================================

-- updated_at — profiles
DROP TRIGGER IF EXISTS trg_profiles_updated_at ON profiles;
CREATE TRIGGER trg_profiles_updated_at
    BEFORE UPDATE ON profiles
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- updated_at — buildings
DROP TRIGGER IF EXISTS trg_buildings_updated_at ON buildings;
CREATE TRIGGER trg_buildings_updated_at
    BEFORE UPDATE ON buildings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- updated_at — floors
DROP TRIGGER IF EXISTS trg_floors_updated_at ON floors;
CREATE TRIGGER trg_floors_updated_at
    BEFORE UPDATE ON floors
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- updated_at — rooms
DROP TRIGGER IF EXISTS trg_rooms_updated_at ON rooms;
CREATE TRIGGER trg_rooms_updated_at
    BEFORE UPDATE ON rooms
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- updated_at — bookings
DROP TRIGGER IF EXISTS trg_bookings_updated_at ON bookings;
CREATE TRIGGER trg_bookings_updated_at
    BEFORE UPDATE ON bookings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- updated_at — room_timetable_templates
DROP TRIGGER IF EXISTS trg_room_timetable_templates_updated_at ON room_timetable_templates;
CREATE TRIGGER trg_room_timetable_templates_updated_at
    BEFORE UPDATE ON room_timetable_templates
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- updated_at — room_timetable_template_exceptions
DROP TRIGGER IF EXISTS trg_room_timetable_template_exceptions_updated_at ON room_timetable_template_exceptions;
CREATE TRIGGER trg_room_timetable_template_exceptions_updated_at
    BEFORE UPDATE ON room_timetable_template_exceptions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Booking concurrency protection
DROP TRIGGER IF EXISTS trg_check_booking_overlap ON bookings;
CREATE TRIGGER trg_check_booking_overlap
    BEFORE INSERT OR UPDATE ON bookings
    FOR EACH ROW EXECUTE FUNCTION check_booking_overlap();

DROP TRIGGER IF EXISTS trg_check_user_booking_conflict ON bookings;
CREATE TRIGGER trg_check_user_booking_conflict
    BEFORE INSERT OR UPDATE ON bookings
    FOR EACH ROW EXECUTE FUNCTION check_user_booking_conflict();

DROP TRIGGER IF EXISTS trg_validate_booking_times ON bookings;
CREATE TRIGGER trg_validate_booking_times
    BEFORE INSERT OR UPDATE ON bookings
    FOR EACH ROW EXECUTE FUNCTION validate_booking_times();

-- ============================================================
-- INDEXES
-- ============================================================

-- profiles
CREATE INDEX IF NOT EXISTS idx_profiles_email
    ON profiles (email);

-- buildings
CREATE INDEX IF NOT EXISTS idx_buildings_name
    ON buildings (name);
CREATE INDEX IF NOT EXISTS idx_buildings_is_active
    ON buildings (is_active);

-- floors
CREATE INDEX IF NOT EXISTS idx_floors_building_id
    ON floors (building_id);
CREATE INDEX IF NOT EXISTS idx_floors_floor_number
    ON floors (floor_number);

-- rooms
CREATE INDEX IF NOT EXISTS idx_rooms_floor_id
    ON rooms (floor_id);
CREATE INDEX IF NOT EXISTS idx_rooms_room_type
    ON rooms (room_type);
CREATE INDEX IF NOT EXISTS idx_rooms_is_active
    ON rooms (is_active);

-- bookings — general + overlap checks
CREATE INDEX IF NOT EXISTS idx_bookings_room_time
    ON bookings (room_id, start_time, end_time);
CREATE INDEX IF NOT EXISTS idx_bookings_teacher_time_overlap
    ON bookings (teacher_id, start_time, end_time);
CREATE INDEX IF NOT EXISTS idx_bookings_teacher_id
    ON bookings (teacher_id);
CREATE INDEX IF NOT EXISTS idx_bookings_start_time
    ON bookings (start_time);
CREATE INDEX IF NOT EXISTS idx_bookings_end_time
    ON bookings (end_time);
CREATE INDEX IF NOT EXISTS idx_bookings_status
    ON bookings (status);
CREATE INDEX IF NOT EXISTS idx_bookings_template_week
    ON bookings (template_id, generated_for_week)
    WHERE template_id IS NOT NULL;

-- booking_invitees
CREATE INDEX IF NOT EXISTS idx_booking_invitees_invitee_id
    ON booking_invitees (invitee_id);

-- password_reset_tokens
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_token
    ON password_reset_tokens (token);

-- room_timetable_templates
CREATE INDEX IF NOT EXISTS idx_room_timetable_templates_room_weekday
    ON room_timetable_templates (room_id, weekday)
    WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_room_timetable_templates_teacher_name
    ON room_timetable_templates (lower(teacher_name));

-- room_timetable_template_exceptions
CREATE INDEX IF NOT EXISTS idx_room_timetable_template_exceptions_template_week
    ON room_timetable_template_exceptions (template_id, week_start_date);

-- ============================================================
-- SEED DATA
-- ============================================================

INSERT INTO buildings (name, description, is_active)
VALUES ('Vyas', 'Default building', true)
ON CONFLICT (name) DO NOTHING;
