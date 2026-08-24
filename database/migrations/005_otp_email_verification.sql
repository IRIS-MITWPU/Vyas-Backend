-- Migration 005: OTP email verification on registration (Phase 3 of
-- IMPLEMENTATION_PLAN.md).
-- Run: psql -d <dbname> -f database/migrations/005_otp_email_verification.sql
--
-- NOTE on the backfill UPDATE below: it is only safe to run before the OTP
-- feature goes live (i.e. before any registration can create an unverified
-- row). It marks every profile that exists *at migration time* as verified
-- so pre-existing users are never locked out. Re-running this file after
-- go-live is still idempotent for the ALTER/CREATE statements, but the
-- UPDATE would incorrectly also verify any genuinely-unverified accounts
-- created since the first run — do not re-run it after deploy.

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE profiles SET email_verified = TRUE WHERE email_verified = FALSE;

CREATE TABLE IF NOT EXISTS email_verification_codes (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  code_hash    TEXT        NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  attempts     INT         NOT NULL DEFAULT 0,
  consumed_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_verification_codes_user_id ON email_verification_codes(user_id);
