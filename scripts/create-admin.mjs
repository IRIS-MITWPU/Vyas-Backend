// Creates (or promotes) the first admin — there is no seed in production.
//   ADMIN_EMAIL=... ADMIN_PASSWORD=... [ADMIN_NAME=...] npm run create-admin
//   docker compose run --rm -e ADMIN_EMAIL=... -e ADMIN_PASSWORD=... app node scripts/create-admin.mjs
//
// Input comes from the environment (not argv) so the password stays out of the process list.
// Idempotent: an existing profile with that email is promoted to admin and marked verified;
// its password is only replaced when ADMIN_RESET_PASSWORD=1.
import bcrypt from "bcryptjs";
import pool from "../database/db.js";

const email = process.env.ADMIN_EMAIL?.trim();
const password = process.env.ADMIN_PASSWORD;
const fullName = process.env.ADMIN_NAME?.trim() || "Administrator";
const resetPassword = process.env.ADMIN_RESET_PASSWORD === "1";

function fail(msg) {
  console.error(`create-admin: ${msg}`);
  process.exit(1);
}

if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail("ADMIN_EMAIL must be a valid email address");
if (!password || password.length < 8) fail("ADMIN_PASSWORD is required and must be at least 8 characters");

const client = await pool.connect();
try {
  await client.query("BEGIN");
  const { rows: existing } = await client.query("SELECT id FROM profiles WHERE email = $1 FOR UPDATE", [email]);

  let id;
  let action;
  if (existing.length) {
    id = existing[0].id;
    await client.query("UPDATE profiles SET is_admin = TRUE, email_verified = TRUE WHERE id = $1", [id]);
    const { rowCount } = await client.query("SELECT 1 FROM user_auth WHERE user_id = $1", [id]);
    action = rowCount ? "promoted existing user" : "promoted existing profile";
    if (!rowCount || resetPassword) {
      const hash = await bcrypt.hash(password, 10);
      await client.query(
        `INSERT INTO user_auth (user_id, password_hash) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
        [id, hash],
      );
      action += rowCount ? " (password reset)" : " (password set)";
    }
  } else {
    const { rows: [created] } = await client.query(
      "INSERT INTO profiles (full_name, email, is_admin, email_verified) VALUES ($1, $2, TRUE, TRUE) RETURNING id",
      [fullName, email],
    );
    id = created.id;
    const hash = await bcrypt.hash(password, 10);
    await client.query("INSERT INTO user_auth (user_id, password_hash) VALUES ($1, $2)", [id, hash]);
    action = "created";
  }

  await client.query("COMMIT");
  console.log(`create-admin: ${action}: ${email} (${id})`);
} catch (err) {
  await client.query("ROLLBACK").catch(() => {});
  console.error("create-admin failed:", err.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
