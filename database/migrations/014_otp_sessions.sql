-- Migration 014: OTP-only sign-in + server-side sessions.
--
-- * auth_codes: emailed one-time codes, keyed by EMAIL (not user id) so a code can
--   exist before any profile does — a profile is only created after a correct code.
-- * sessions: opaque, revocable sessions. Only sha256(token) is stored.
-- * profiles.email is forced to lower case (it was case-sensitive, so
--   Teacher@x and teacher@x could be two accounts).
-- * Pending (unverified) password sign-ups are removed: nothing can create them now.
--
-- Additive: user_auth, password_reset_tokens and email_verification_codes are left in
-- place so the change can be rolled back; a later migration drops them. Idempotent.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM profiles GROUP BY lower(email) HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Migration 014 aborted: profiles has emails that differ only by case. Merge or delete the duplicates, then re-run.';
  END IF;
END $$;

UPDATE profiles SET email = lower(email) WHERE email <> lower(email);
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_email_lower;
ALTER TABLE profiles ADD CONSTRAINT profiles_email_lower CHECK (email = lower(email));

DELETE FROM profiles WHERE email_verified = FALSE;

CREATE TABLE IF NOT EXISTS auth_codes (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT        NOT NULL CHECK (email = lower(email)),
  purpose     TEXT        NOT NULL CHECK (purpose IN ('login', 'reauth')),
  code_hash   TEXT        NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  attempts    INT         NOT NULL DEFAULT 0,
  consumed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_auth_codes_email ON auth_codes(email, purpose, created_at DESC);

CREATE TABLE IF NOT EXISTS sessions (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash   TEXT        NOT NULL UNIQUE,
  user_id      UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  remember     BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reauth_at    TIMESTAMPTZ,
  user_agent   TEXT,
  ip           TEXT,
  revoked_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id) WHERE revoked_at IS NULL;
