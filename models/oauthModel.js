// models/oauthModel.js
import pool from "../database/db.js";
import { isAllowedUser } from "../utils/allowedUser.js";

const PROVIDER = "google";

export class NotAllowedUserError extends Error {
  constructor(email) {
    super("This email is not on the staff allowlist.");
    this.name = "NotAllowedUserError";
    this.email = email;
  }
}

/**
 * Find or create a profiles row for a verified Google sign-in.
 *
 * - If a profiles row exists for the email: auto-link (idempotent — repeat
 *   sign-ins for the same Google account don't duplicate the oauth_identities
 *   row). Every profile is email-verified: accounts are only ever created after
 *   proving mailbox control (an emailed code, or this Google sign-in).
 * - Else, if the email is on the staff allowlist: create the profile + its
 *   oauth_identities row. Otherwise NotAllowedUserError.
 *
 * Returns the profiles row needed to start a session (id, is_admin, ...).
 */
export async function findOrCreateGoogleUser({ googleId, email, fullName }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const existing = await client.query(
      `SELECT id, full_name, email, is_admin FROM profiles WHERE email = $1`,
      [email]
    );

    let profile;

    if (existing.rows.length > 0) {
      profile = existing.rows[0];

      await client.query(
        `INSERT INTO oauth_identities (user_id, provider, provider_user_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (provider, provider_user_id) DO NOTHING`,
        [profile.id, PROVIDER, googleId]
      );
    } else {
      // Only NEW accounts are gated by the staff allowlist; an existing
      // verified profile (branch above) links regardless.
      if (!(await isAllowedUser(email, client))) {
        throw new NotAllowedUserError(email);
      }

      const inserted = await client.query(
        `INSERT INTO profiles (full_name, email, email_verified)
         VALUES ($1, $2, TRUE)
         RETURNING id, full_name, email, is_admin`,
        [fullName, email]
      );
      profile = inserted.rows[0];

      await client.query(
        `INSERT INTO oauth_identities (user_id, provider, provider_user_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (provider, provider_user_id) DO NOTHING`,
        [profile.id, PROVIDER, googleId]
      );
    }

    await client.query("COMMIT");
    return profile;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
