// utils/allowedUser.js
import pool from "../database/db.js";

// Is this email on the staff allowlist? Only consulted when a NEW account is
// being created — existing accounts are never re-checked.
export async function isAllowedUser(email, db = pool) {
  const { rowCount } = await db.query("SELECT 1 FROM allowed_user WHERE email = $1", [
    String(email || "").trim().toLowerCase(),
  ]);
  return rowCount > 0;
}
