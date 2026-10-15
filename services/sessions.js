// services/sessions.js
//
// Opaque, server-side sessions. The cookie holds 32 random bytes; the DB holds
// only sha256(token), so a database read does not yield usable sessions.
// Idle and absolute limits are enforced here, on every request, using the
// user's *current* admin status (promoting someone tightens their session at
// once). All ages are computed by Postgres (now()) to avoid app/DB clock drift.
import crypto from "crypto";
import pool from "../database/db.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const positive = (v, fallback) => (Number(v) > 0 ? Number(v) : fallback);

const IDLE_MS = positive(process.env.SESSION_IDLE_HOURS, 48) * HOUR;
const ABSOLUTE_MS = positive(process.env.SESSION_ABSOLUTE_DAYS, 14) * DAY;
const ADMIN_IDLE_MS = positive(process.env.ADMIN_IDLE_HOURS, 12) * HOUR;
const ADMIN_ABSOLUTE_MS = positive(process.env.ADMIN_ABSOLUTE_DAYS, 7) * DAY;
// "Keep me signed in" unchecked: a browser-session cookie that also dies after a short idle.
const NOT_REMEMBERED_IDLE_MS = 8 * HOUR;
// last_seen_at is written at most this often (and the cookie's Max-Age renewed with it).
const TOUCH_AFTER_MS = 10 * 60 * 1000;

// How recent a fresh code must be for sensitive actions (see requireFreshAuth).
export const REAUTH_WINDOW_MS = 10 * 60 * 1000;

const isProduction = process.env.NODE_ENV === "production";
// __Host- pins the cookie to this exact host over HTTPS (no Domain, Path=/); it
// needs Secure, which dev (http://localhost) doesn't have.
export const COOKIE_NAME = isProduction ? "__Host-vyas_session" : "vyas_session";

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

export function limitsFor(isAdmin, remember) {
  const baseIdle = isAdmin ? ADMIN_IDLE_MS : IDLE_MS;
  return {
    idleMs: remember ? baseIdle : Math.min(baseIdle, NOT_REMEMBERED_IDLE_MS),
    absoluteMs: isAdmin ? ADMIN_ABSOLUTE_MS : ABSOLUTE_MS,
  };
}

export function setSessionCookie(res, token, { isAdmin, remember }) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: "Lax",
    path: "/",
    ...(remember ? { maxAge: limitsFor(isAdmin, true).idleMs } : {}),
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { httpOnly: true, secure: isProduction, sameSite: "Lax", path: "/" });
}

// A new random token on every login — a client-supplied id is never accepted (no fixation).
// Logging in is itself a fresh authentication, so reauth_at starts at now().
export async function createSession(userId, { remember = true, ip = null, userAgent = null } = {}) {
  const token = crypto.randomBytes(32).toString("base64url");
  const { rows: [row] } = await pool.query(
    `INSERT INTO sessions (token_hash, user_id, remember, reauth_at, user_agent, ip)
     VALUES ($1, $2, $3, NOW(), $4, $5)
     RETURNING id`,
    [sha256(token), userId, remember, userAgent?.slice(0, 255) ?? null, ip]
  );
  return { token, id: row.id };
}

// Throws unless the token belongs to a live session. Shared by REST (`protect`)
// and Socket.IO so a revoked/expired session can't keep either alive.
export async function verifySession(token) {
  if (typeof token !== "string" || token.length < 20 || token.length > 200) {
    throw new Error("Malformed session token");
  }
  const { rows: [s] } = await pool.query(
    `SELECT s.id, s.remember,
            EXTRACT(EPOCH FROM (NOW() - s.created_at)) * 1000      AS age_ms,
            EXTRACT(EPOCH FROM (NOW() - s.last_seen_at)) * 1000    AS idle_ms,
            EXTRACT(EPOCH FROM (NOW() - s.reauth_at)) * 1000       AS reauth_age_ms,
            p.id AS user_id, p.full_name, p.email, p.is_admin
       FROM sessions s JOIN profiles p ON p.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL`,
    [sha256(token)]
  );
  if (!s) throw new Error("Session not found");

  const { idleMs, absoluteMs } = limitsFor(s.is_admin, s.remember);
  const age = Number(s.age_ms);
  const idle = Number(s.idle_ms);
  if (age > absoluteMs || idle > idleMs) {
    await revokeSession(s.id);
    throw new Error("Session expired");
  }

  const touched = idle > TOUCH_AFTER_MS;
  if (touched) await pool.query("UPDATE sessions SET last_seen_at = NOW() WHERE id = $1", [s.id]);

  return {
    user: { id: s.user_id, full_name: s.full_name, email: s.email, is_admin: s.is_admin },
    session: {
      id: s.id,
      remember: s.remember,
      touched,
      reauthAgeMs: s.reauth_age_ms === null ? null : Number(s.reauth_age_ms),
      expiresAt: Date.now() + (absoluteMs - age), // hard cap, used to close live sockets
    },
  };
}

export async function revokeSession(sessionId) {
  await pool.query("UPDATE sessions SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL", [sessionId]);
}

export async function revokeSessionByToken(token) {
  const { rows } = await pool.query(
    "UPDATE sessions SET revoked_at = NOW() WHERE token_hash = $1 AND revoked_at IS NULL RETURNING id",
    [sha256(String(token))]
  );
  return rows.map((r) => r.id);
}

export async function revokeAllForUser(userId) {
  const { rows } = await pool.query(
    "UPDATE sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL RETURNING id",
    [userId]
  );
  return rows.map((r) => r.id);
}

export async function markReauth(sessionId) {
  await pool.query("UPDATE sessions SET reauth_at = NOW() WHERE id = $1", [sessionId]);
}

export async function listSessions(userId, isAdmin) {
  const { rows } = await pool.query(
    `SELECT id, remember, created_at, last_seen_at, user_agent, ip
       FROM sessions WHERE user_id = $1 AND revoked_at IS NULL
      ORDER BY last_seen_at DESC`,
    [userId]
  );
  // Hide sessions that are past their limits but not yet swept.
  const now = Date.now();
  return rows.filter((r) => {
    const { idleMs, absoluteMs } = limitsFor(isAdmin, r.remember);
    return now - new Date(r.last_seen_at) <= idleMs && now - new Date(r.created_at) <= absoluteMs;
  });
}

// Dead rows only: revoked a day ago, or past the longest configured limit (+1 day of slack).
export async function purgeDeadSessions() {
  const maxAbsoluteMs = Math.max(ABSOLUTE_MS, ADMIN_ABSOLUTE_MS) + DAY;
  const maxIdleMs = Math.max(IDLE_MS, ADMIN_IDLE_MS) + DAY;
  const { rowCount } = await pool.query(
    `DELETE FROM sessions
      WHERE revoked_at < NOW() - INTERVAL '1 day'
         OR created_at < NOW() - ($1 * INTERVAL '1 millisecond')
         OR last_seen_at < NOW() - ($2 * INTERVAL '1 millisecond')`,
    [maxAbsoluteMs, maxIdleMs]
  );
  return rowCount;
}
