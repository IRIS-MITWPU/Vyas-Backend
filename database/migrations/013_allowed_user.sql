-- Migration 013: staff allowlist for account creation.
--
-- Only emails in this table can create a NEW account (password register or
-- first-time Google sign-in), checked after the @mitwpu.edu.in domain check.
-- Existing accounts are never checked against it. Populated from the staff
-- spreadsheet by scripts/import-allowed-users.mjs. Idempotent.

CREATE TABLE IF NOT EXISTS allowed_user (
  email      TEXT        PRIMARY KEY CHECK (email = lower(email)),
  full_name  TEXT        NOT NULL,
  eprn       TEXT        UNIQUE,  -- NULL for non-teaching staff
  phone      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
