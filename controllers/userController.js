// controllers/userController.js
//
// Email-code (OTP) sign-in. One flow for new and returning users: request a code
// for an email, then verify it. There are no passwords. An account is created
// only after a correct code, and only for an email on the staff allowlist.
import crypto from "crypto";
import { z } from "zod";
import pool from "../database/db.js";
import { findProfileByEmail, createProfileFromAllowlist } from "../models/userModel.js";
import { enqueueEmail } from "../services/emailQueue.js";
import { logAuditEvent } from "../services/auditLog.js";
import {
  createSession,
  setSessionCookie,
  clearSessionCookie,
  markReauth,
  listSessions as listUserSessions,
  revokeAllForUser,
  revokeSessionByToken,
  COOKIE_NAME,
} from "../services/sessions.js";
import { sendError } from "../utils/errorResponse.js";
import { encryptOtp, hashCode, codeMatches } from "../utils/otpCrypto.js";
import { isAllowedDomain, normalizeEmail } from "../utils/emailDomain.js";
import { isAllowedUser } from "../utils/allowedUser.js";

// ============================================================
// Validation schemas
// ============================================================
// full_name is display text only â€” it never grants access (see migration 010) â€”
// but keep it sane. Used by PATCH /user/me.
export const fullNameSchema = z
  .string()
  .trim()
  .min(1, "Full name is required")
  .max(100, "Full name must be at most 100 characters")
  .regex(/^\P{Cc}*$/u, "Full name must not contain control characters");

const emailSchema = z.string().trim().max(254).email("Invalid email format");

const requestCodeSchema = z.object({ email: emailSchema });

const verifyCodeSchema = z.object({
  email: emailSchema,
  code: z.string().regex(/^\d{8}$/, "Code must be 8 digits"),
  remember: z.boolean().default(true),
});

const reauthVerifySchema = z.object({ code: z.string().regex(/^\d{8}$/, "Code must be 8 digits") });

// ============================================================
// Code helpers
// ============================================================
const CODE_DIGITS = 8; // 8 digits keeps worst-case guessing odds negligible (see below)
const CODE_TTL_MINUTES = 10;
const CODE_MAX_ATTEMPTS = 5; // per code, claimed atomically
const REQUEST_COOLDOWN_SECONDS = 60;
const REQUESTS_MAX_PER_HOUR = 5; // 5 codes x 5 attempts = 25 guesses/h out of 10^8

const GENERIC_REQUEST_RESPONSE = { message: "If this address can sign in, a code is on its way." };

const invalidCode = (res) =>
  res.status(400).json({ error: "Incorrect or expired code.", code: "INVALID_CODE" });

// Too soon after the last code, or too many this hour. The caller answers with
// the same generic response either way, so throttling reveals nothing.
async function isThrottled(email, purpose) {
  const { rows: [r] } = await pool.query(
    `SELECT count(*)::int AS n, EXTRACT(EPOCH FROM (NOW() - MAX(created_at))) AS since
       FROM auth_codes
      WHERE email = $1 AND purpose = $2 AND created_at > NOW() - INTERVAL '1 hour'`,
    [email, purpose]
  );
  return r.n >= REQUESTS_MAX_PER_HOUR || (r.n > 0 && Number(r.since) < REQUEST_COOLDOWN_SECONDS);
}

async function issueCode(email, purpose, fullName) {
  const code = String(crypto.randomInt(0, 10 ** CODE_DIGITS)).padStart(CODE_DIGITS, "0");
  // One live code per email+purpose: a new one supersedes the old.
  await pool.query(
    "UPDATE auth_codes SET consumed_at = NOW() WHERE email = $1 AND purpose = $2 AND consumed_at IS NULL",
    [email, purpose]
  );
  await pool.query(
    `INSERT INTO auth_codes (email, purpose, code_hash, expires_at)
     VALUES ($1, $2, $3, NOW() + ($4 * INTERVAL '1 minute'))`,
    [email, purpose, hashCode(email, purpose, code), CODE_TTL_MINUTES]
  );
  await enqueueEmail("verification-code", {
    to: email,
    fullName: fullName ?? "",
    purpose,
    encryptedCode: encryptOtp(code),
    expiresInMinutes: CODE_TTL_MINUTES,
    requestedAt: Date.now(),
  });
}

// Checks a submitted code and consumes it. Every failure looks the same.
// The attempt is claimed with one conditional UPDATE *before* the guess is
// evaluated, so parallel requests can't each get a free guess; the final
// consume is likewise atomic, so a correct code can be used exactly once.
async function consumeCode(email, purpose, code) {
  const { rows: [row] } = await pool.query(
    `SELECT id, code_hash FROM auth_codes
      WHERE email = $1 AND purpose = $2 AND consumed_at IS NULL AND expires_at > NOW()
      ORDER BY created_at DESC LIMIT 1`,
    [email, purpose]
  );
  if (!row) return false;

  const claimed = await pool.query(
    `UPDATE auth_codes SET attempts = attempts + 1
      WHERE id = $1 AND consumed_at IS NULL AND attempts < $2 AND expires_at > NOW()
      RETURNING id`,
    [row.id, CODE_MAX_ATTEMPTS]
  );
  if (claimed.rowCount === 0) return false;
  if (!codeMatches(email, purpose, code, row.code_hash)) return false;

  const consumed = await pool.query(
    "UPDATE auth_codes SET consumed_at = NOW() WHERE id = $1 AND consumed_at IS NULL RETURNING id",
    [row.id]
  );
  return consumed.rowCount === 1;
}

const clientInfo = (req) => ({ ip: req.ip, userAgent: req.get("user-agent") ?? null });

// Closes live sockets of revoked sessions (they joined room sid:<id> on connect).
function dropSockets(req, sessionIds) {
  const io = req.app.get("io");
  for (const id of sessionIds) io?.in(`sid:${id}`).disconnectSockets(true);
}

// ============================================================
// SIGN IN / SIGN UP â€” step 1: request a code
// ============================================================
export async function requestCode(req, res) {
  const parsed = requestCodeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, errors: parsed.error.flatten().fieldErrors });
  }
  const email = normalizeEmail(parsed.data.email);

  if (!isAllowedDomain(email)) {
    return res.status(403).json({
      success: false,
      code: "DOMAIN_NOT_ALLOWED",
      message: "Sign-in is restricted to @mitwpu.edu.in email addresses.",
    });
  }

  try {
    const profile = await findProfileByEmail(email);
    // Existing accounts always get a code; a brand-new one only if allowlisted.
    // New and returning users get the identical response, so this endpoint
    // doesn't reveal which emails already have an account.
    if (!profile && !(await isAllowedUser(email))) {
      logAuditEvent({ action: "otp.rejected_not_allowed", metadata: { email, ip: req.ip } });
      return res.status(403).json({
        success: false,
        code: "NOT_ALLOWED",
        message: "This email is not authorized. Contact the administrator.",
      });
    }

    if (!(await isThrottled(email, "login"))) {
      await issueCode(email, "login", profile?.full_name);
      logAuditEvent({ actorUserId: profile?.id, action: "otp.requested", metadata: { email, ip: req.ip } });
    }
    res.json(GENERIC_REQUEST_RESPONSE);
  } catch (err) {
    sendError(res, 500, "Could not send a code", err);
  }
}

// ============================================================
// SIGN IN / SIGN UP â€” step 2: verify the code, start a session
// ============================================================
export async function verifyCode(req, res) {
  const parsed = verifyCodeSchema.safeParse(req.body);
  if (!parsed.success) return invalidCode(res);
  const email = normalizeEmail(parsed.data.email);
  const { code, remember } = parsed.data;

  try {
    if (!(await consumeCode(email, "login", code))) {
      logAuditEvent({ action: "otp.failed", metadata: { email, ip: req.ip } });
      return invalidCode(res);
    }

    let profile = await findProfileByEmail(email);
    let created = false;
    if (!profile) {
      profile = await createProfileFromAllowlist(email);
      created = Boolean(profile);
      profile ??= await findProfileByEmail(email); // lost a race to a parallel verify
    }
    if (!profile) {
      // Removed from the allowlist between requesting and verifying the code.
      return res.status(403).json({ success: false, code: "NOT_ALLOWED", message: "This email is not authorized. Contact the administrator." });
    }

    const { token } = await createSession(profile.id, { remember, ...clientInfo(req) });
    setSessionCookie(res, token, { isAdmin: profile.is_admin, remember });
    logAuditEvent({ actorUserId: profile.id, action: "login.succeeded", metadata: { email, method: "otp", created } });
    if (created) await enqueueEmail("welcome", { to: profile.email, fullName: profile.full_name });

    res.json({
      message: "Signed in",
      user: { id: profile.id, full_name: profile.full_name, email: profile.email, is_admin: profile.is_admin },
    });
  } catch (err) {
    sendError(res, 500, "Verification failed", err);
  }
}

// ============================================================
// STEP-UP: a fresh code before destructive/admin actions (requireFreshAuth)
// ============================================================
export async function reauthRequest(req, res) {
  try {
    if (!(await isThrottled(req.user.email, "reauth"))) {
      await issueCode(req.user.email, "reauth", req.user.full_name);
      logAuditEvent({ actorUserId: req.user.id, action: "reauth.requested" });
    }
    res.json(GENERIC_REQUEST_RESPONSE);
  } catch (err) {
    sendError(res, 500, "Could not send a code", err);
  }
}

export async function reauthVerify(req, res) {
  const parsed = reauthVerifySchema.safeParse(req.body);
  if (!parsed.success) return invalidCode(res);

  try {
    if (!(await consumeCode(req.user.email, "reauth", parsed.data.code))) {
      logAuditEvent({ actorUserId: req.user.id, action: "reauth.failed" });
      return invalidCode(res);
    }
    await markReauth(req.session.id);
    logAuditEvent({ actorUserId: req.user.id, action: "reauth.succeeded" });
    res.json({ success: true });
  } catch (err) {
    sendError(res, 500, "Verification failed", err);
  }
}

// ============================================================
// SESSIONS: sign out, sign out everywhere, device list
// ============================================================
export async function logout(req, res) {
  try {
    const token = req.cookies?.[COOKIE_NAME];
    if (token) dropSockets(req, await revokeSessionByToken(token));
  } catch (err) {
    console.error("Logout error:", err.message);
  }
  clearSessionCookie(res);
  res.json({ success: true, message: "Logged out" });
}

export async function logoutAll(req, res) {
  try {
    dropSockets(req, await revokeAllForUser(req.user.id));
    logAuditEvent({ actorUserId: req.user.id, action: "session.revoked_all" });
    clearSessionCookie(res);
    res.json({ success: true, message: "Logged out of all devices" });
  } catch (err) {
    sendError(res, 500, "Failed to log out of all devices", err);
  }
}

export async function listSessions(req, res) {
  try {
    const sessions = await listUserSessions(req.user.id, req.user.is_admin);
    res.json({
      success: true,
      sessions: sessions.map((s) => ({
        id: s.id,
        created_at: s.created_at,
        last_seen_at: s.last_seen_at,
        user_agent: s.user_agent,
        current: s.id === req.session.id,
      })),
    });
  } catch (err) {
    sendError(res, 500, "Failed to load sessions", err);
  }
}

export async function revokeSessionById(req, res) {
  try {
    const { rows } = await pool.query(
      `UPDATE sessions SET revoked_at = NOW()
        WHERE id::text = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id`,
      [req.params.id, req.user.id]
    );
    if (rows.length === 0) return res.status(404).json({ success: false, error: "Session not found" });
    dropSockets(req, [rows[0].id]);
    logAuditEvent({ actorUserId: req.user.id, action: "session.revoked", targetType: "session", targetId: rows[0].id });
    if (rows[0].id === req.session.id) clearSessionCookie(res);
    res.json({ success: true });
  } catch (err) {
    sendError(res, 500, "Failed to revoke session", err);
  }
}
