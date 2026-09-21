-- Migration 012: bookings must start and end on the same IST day (audit F2).
--
-- validate_booking_times() checked the weekday of the start and the
-- hour-of-day of start and end separately, never the dates — so
-- "Mon 09:00 → next year 10:00" passed every check and, via the
-- no_overlapping_bookings exclusion constraint, locked the room for everyone
-- else for the whole span. The trigger runs BEFORE INSERT OR UPDATE, so this
-- covers POST, PATCH and every other write path. Idempotent.
--
-- Before applying to a live DB, check for existing violators (they would
-- make any later UPDATE of those rows fail):
--   SELECT id FROM bookings
--   WHERE (start_time AT TIME ZONE 'Asia/Kolkata')::date
--      <> (end_time AT TIME ZONE 'Asia/Kolkata')::date
--     AND status NOT IN ('cancelled', 'denied');

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

    -- A booking is one weekday slot (audit F2): without this, one row could
    -- span months and block the room for everyone via the exclusion constraint.
    IF (NEW.start_time AT TIME ZONE 'Asia/Kolkata')::date
       <> (NEW.end_time AT TIME ZONE 'Asia/Kolkata')::date THEN
        RAISE EXCEPTION 'Bookings must start and end on the same day';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
