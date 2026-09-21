// models/userModel.js
import pool from '../database/db.js';
import bcrypt from 'bcryptjs';

// A verified email can't be registered again. An *unverified* (pending) one
// is replaced — name and password overwritten, outstanding OTPs deleted — so
// whoever actually controls the mailbox wins. Otherwise an attacker could
// pre-register someone else's address with their own password and inherit
// the account once the owner verifies it (audit F0).
export async function registerUser(full_name, email, password) {
  const hashedPassword = await bcrypt.hash(password, 10);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const checkUser = await client.query(
      "SELECT id, email_verified FROM profiles WHERE email = $1 FOR UPDATE",
      [email]
    );
    const existing = checkUser.rows[0];
    if (existing?.email_verified) {
      throw new Error("User already exists");
    }

    let profile;
    if (existing) {
      profile = (await client.query(
        `UPDATE profiles SET full_name = $2, token_version = token_version + 1
         WHERE id = $1
         RETURNING id, full_name, email, is_admin, token_version`,
        [existing.id, full_name]
      )).rows[0];
      await client.query(
        `INSERT INTO user_auth (user_id, password_hash) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
        [existing.id, hashedPassword]
      );
      await client.query("DELETE FROM email_verification_codes WHERE user_id = $1", [existing.id]);
    } else {
      profile = (await client.query(
        `INSERT INTO profiles (full_name, email)
         VALUES ($1, $2)
         RETURNING id, full_name, email, is_admin, token_version`,
        [full_name, email]
      )).rows[0];
      await client.query(
        `INSERT INTO user_auth (user_id, password_hash)
         VALUES ($1, $2)`,
        [profile.id, hashedPassword]
      );
    }

    await client.query("COMMIT");
    return profile;
  } catch (err) {
    await client.query("ROLLBACK");
    // Two concurrent first-time registrations: the loser hits the unique index.
    if (err.code === "23505") throw new Error("User already exists");
    throw err;
  } finally {
    client.release();
  }
}

export async function findUserByEmail(email) {
  const query = `
    SELECT
      p.id AS user_id,
      p.full_name,
      p.email,
      p.is_admin,
      p.token_version,
      p.email_verified,
      a.password_hash
    FROM profiles p
    JOIN user_auth a ON p.id = a.user_id
    WHERE p.email = $1
  `;
  const result = await pool.query(query, [email]);
  return result.rows[0];
}
