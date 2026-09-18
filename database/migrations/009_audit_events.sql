-- Migration 009: durable audit trail for security-relevant actions
-- (Vyas_Remediation_Plan.md, Phase 7 / FINDINGS item 34).
-- Run: psql -d <dbname> -f database/migrations/009_audit_events.sql
--
-- Supplements, and does not replace, the existing row-level trails
-- (bookings.approved_by/approved_at, timetable_admin_corrections). Those
-- record current state; this records the sequence of events needed to
-- reconstruct an incident after the fact.
--
-- actor_user_id is nullable and ON DELETE SET NULL: a failed login has no
-- known actor, and deleting a user must not erase the record of what that
-- user did.

CREATE TABLE IF NOT EXISTS audit_events (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id  UUID        REFERENCES profiles(id) ON DELETE SET NULL,
  action         TEXT        NOT NULL,
  target_type    TEXT,
  target_id      TEXT,
  metadata       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- "What did this user do?" and "what happened in this window?" — the two
-- queries an incident review actually runs.
CREATE INDEX IF NOT EXISTS idx_audit_events_actor ON audit_events(actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_created_at ON audit_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_action ON audit_events(action, created_at DESC);
