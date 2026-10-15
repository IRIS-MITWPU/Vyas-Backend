// Creates (or promotes) the first admin — there is no seed in production.
//   ADMIN_EMAIL=... [ADMIN_NAME=...] npm run create-admin
//   docker compose run --rm -e ADMIN_EMAIL=... app node scripts/create-admin.mjs
//
// There are no passwords: the admin then signs in with an emailed code (or Google).
// Input comes from the environment (not argv). Idempotent: an existing profile with
// that email is promoted to admin and marked verified; its name is left alone.
import pool from "../database/db.js";
import { normalizeEmail, isAllowedDomain } from "../utils/emailDomain.js";

const email = normalizeEmail(process.env.ADMIN_EMAIL);
const fullName = process.env.ADMIN_NAME?.trim() || "Administrator";

function fail(msg) {
  console.error(`create-admin: ${msg}`);
  process.exit(1);
}

if (!isAllowedDomain(email)) fail("ADMIN_EMAIL must be a valid @mitwpu.edu.in address");

const client = await pool.connect();
try {
  await client.query("BEGIN");
  const { rows: existing } = await client.query("SELECT id FROM profiles WHERE email = $1 FOR UPDATE", [email]);

  let id;
  let action;
  if (existing.length) {
    id = existing[0].id;
    await client.query("UPDATE profiles SET is_admin = TRUE, email_verified = TRUE WHERE id = $1", [id]);
    action = "promoted existing user";
  } else {
    const { rows: [created] } = await client.query(
      "INSERT INTO profiles (full_name, email, is_admin, email_verified) VALUES ($1, $2, TRUE, TRUE) RETURNING id",
      [fullName, email],
    );
    id = created.id;
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
