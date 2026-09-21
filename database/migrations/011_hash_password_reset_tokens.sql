-- Migration 011: store password-reset tokens as SHA-256 hashes (audit 2.6b).
--
-- The column held the plaintext token, so anyone who could read the table
-- (a backup, a replica, a SQL-injection elsewhere) could reset any account
-- with a pending link. The app now stores sha256(token) in token_hash and
-- hashes the submitted token before lookup.
--
-- Existing rows hold plaintext and can't be converted meaningfully, so they
-- are deleted: any reset link issued before this deploy stops working and
-- the user simply requests a new one (links only live 1 h anyway).
-- Idempotent.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'password_reset_tokens' AND column_name = 'token'
  ) THEN
    DELETE FROM password_reset_tokens;
    ALTER TABLE password_reset_tokens RENAME COLUMN token TO token_hash;
  END IF;
END $$;
