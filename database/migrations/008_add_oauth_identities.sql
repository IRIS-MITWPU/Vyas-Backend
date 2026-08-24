-- Migration 008: Google OAuth / OIDC identities (OAUTH_AWS_IMPLEMENTATION_PLAN.md, Phase 2.1).
-- Run: psql -d <dbname> -f database/migrations/008_add_oauth_identities.sql
--
-- Stores linked OAuth provider identities (Google, and any future provider)
-- for a profiles row. An OAuth-only account has a profiles row with NO
-- matching user_auth row — findUserByEmail's INNER JOIN on user_auth already
-- excludes such accounts from password login, so no change to user_auth's
-- password_hash NOT NULL constraint is needed here.

CREATE TABLE IF NOT EXISTS oauth_identities (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  provider          TEXT        NOT NULL,
  provider_user_id  TEXT        NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, provider_user_id)
);

CREATE INDEX IF NOT EXISTS idx_oauth_identities_user_id ON oauth_identities(user_id);
