// models/oauthModel.js
import pool from "../database/db.js";

const PROVIDER = "google";

export class UnverifiedAccountExistsError extends Error {
  constructor(email) {
    super(
      "An account with this email already exists but hasn't completed email verification."
    );
    this.name = "UnverifiedAccountExistsError";
    this.email = email;
  }
}

/**
 * Find or create a profiles row for a verified Google sign-in.
 *
 * - If a profiles row exists for the email AND email_verified=true: auto-link
 *   (idempotent — repeat sign-ins for the same Google account don't duplicate
 *   the oauth_identities row).
 * - If a profiles row exists for the email but email_verified=false: refuse.
 *   That row's owner never proved they control this email address (password
 *   registered, OTP never completed) — silently linking Google's verification
 *   onto it would hand Google-account access to whatever unverified row
 *   happens to share the email, which is a real account-takeover vector, not
 *   a theoretical one. Caller (oauthController) surfaces this as a redirect
 *   telling the user to complete/reset the existing registration first.
 * - Else: create a new profiles row (email_verified=true, no user_auth row —
 *   OAuth-only accounts never get a password hash) + its oauth_identities row.
 *
 * Returns the profiles row shape needed for token issuance downstream
 * (id, token_version, is_admin).
 */
export async function findOrCreateGoogleUser({ googleId, email, fullName }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const existing = await client.query(
      `SELECT id, full_name, email, is_admin, token_version, email_verified
       FROM profiles WHERE email = $1`,
      [email]
    );

    let profile;

    if (existing.rows.length > 0) {
      profile = existing.rows[0];

      if (!profile.email_verified) {
        throw new UnverifiedAccountExistsError(email);
      }

      await client.query(
        `INSERT INTO oauth_identities (user_id, provider, provider_user_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (provider, provider_user_id) DO NOTHING`,
        [profile.id, PROVIDER, googleId]
      );
    } else {
      const inserted = await client.query(
        `INSERT INTO profiles (full_name, email, email_verified)
         VALUES ($1, $2, TRUE)
         RETURNING id, full_name, email, is_admin, token_version, email_verified`,
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
