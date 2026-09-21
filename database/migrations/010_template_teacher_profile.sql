-- Migration 010: authorize timetable-slot cancellation by profile id, not name (audit F4).
--
-- create_template_exception() used to allow any user whose full_name matched
-- the template's teacher_name, and users can set their own full_name via
-- PATCH /user/me — so anyone could cancel anyone's slots. Now: admin, or the
-- profile an admin linked via teacher_profile_id. teacher_name stays as
-- display text only. No name-based backfill (that would re-create the bug):
-- existing templates start unlinked, i.e. admin-only until an admin links them.
-- Idempotent.

ALTER TABLE room_timetable_templates
  ADD COLUMN IF NOT EXISTS teacher_profile_id UUID REFERENCES profiles(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION create_template_exception(
    p_template_id     UUID,
    p_week_start_date DATE,
    p_user_id         UUID,
    p_reason          TEXT DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
    v_found              BOOLEAN;
    v_teacher_profile_id UUID;
    v_exception_id       UUID;
BEGIN
    SELECT TRUE, teacher_profile_id INTO v_found, v_teacher_profile_id
    FROM room_timetable_templates
    WHERE id = p_template_id;

    IF v_found IS NULL THEN
        RAISE EXCEPTION 'Template not found';
    END IF;

    IF NOT (
        EXISTS (SELECT 1 FROM profiles WHERE id = p_user_id AND is_admin = true)
        OR (v_teacher_profile_id IS NOT NULL AND v_teacher_profile_id = p_user_id)
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
