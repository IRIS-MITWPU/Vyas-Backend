// models/userModel.js
import pool from '../database/db.js';

export async function findProfileByEmail(email) {
  const { rows } = await pool.query(
    "SELECT id, full_name, email, is_admin FROM profiles WHERE email = $1",
    [email]
  );
  return rows[0] ?? null;
}

// Creates the account for an allowlisted email, using the allowlist's own
// name (nothing the visitor types ends up in a profile). Returns null when the
// email is not allowlisted, or when a concurrent request created it first —
// the caller re-reads in that case. Only ever called after a correct code.
export async function createProfileFromAllowlist(email) {
  const { rows } = await pool.query(
    `INSERT INTO profiles (full_name, email, email_verified)
     SELECT full_name, email, TRUE FROM allowed_user WHERE email = $1
     ON CONFLICT (email) DO NOTHING
     RETURNING id, full_name, email, is_admin`,
    [email]
  );
  return rows[0] ?? null;
}
