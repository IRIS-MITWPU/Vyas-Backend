// controllers/userController.js
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { z } from "zod";
import { registerUser, findUserByEmail } from "../models/userModel.js";
import pool from "../database/db.js";
import { enqueueEmail } from "../services/emailQueue.js";
import { sendError } from "../utils/errorResponse.js";
import { encryptOtp } from "../utils/otpCrypto.js";
import { isAllowedDomain } from "../utils/emailDomain.js";
import { logAuditEvent } from "../services/auditLog.js";

// ============================================================
// Validation schemas
// ============================================================
// Shared by register and PATCH /user/me. full_name is display text only —
// it never grants access (see migration 010) — but keep it sane.
export const fullNameSchema = z
  .string()
  .trim()
  .min(1, "Full name is required")
  .max(100, "Full name must be at most 100 characters")
  .regex(/^\P{Cc}*$/u, "Full name must not contain control characters");

const registerSchema = z.object({
  full_name: fullNameSchema,
  email: z.string().email("Invalid email format"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

const loginSchema = z.object({
  email: z.string().email("Invalid email format"),
  password: z.string().min(1, "Password is required"),
});
  
const forgotPasswordSchema = z.object({
  email: z.string().email("Invalid email format"),
});

const resetPasswordSchema = z.object({
  token: z.string().min(1, "Token is required"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

// password: proves the verifier is the person who registered, not just the
// mailbox owner — see the F0 note in verifyEmail.
const verifyEmailSchema = z.object({
  email: z.string().email("Invalid email format"),
  code: z.string().regex(/^\d{6}$/, "Code must be 6 digits"),
  password: z.string().min(1, "Password is required"),
});

const resendVerificationSchema = z.object({
  email: z.string().email("Invalid email format"),
});

// ============================================================
// Helpers
// ============================================================
const isProduction = process.env.NODE_ENV === "production";

// Session lifetime. This is an *idle* window, not a hard cap: `protect`
// re-issues the cookie on activity once it's more than halfway expired
// (see SLIDE_AFTER_MS in middlewares/authMiddleware.js), so an active user
// is never logged out mid-session while an abandoned/stolen cookie dies
// within JWT_EXPIRY of its last use rather than the old flat 30 days.
// ponytail: sliding single token, not access+refresh rotation — `protect`
// already re-checks token_version from Postgres on every request, so
// revocation is instant without a refresh-token table. Move to rotating
// refresh tokens if stolen-token *replay detection* is ever needed.
const JWT_EXPIRY_HOURS = Number(process.env.JWT_EXPIRY_HOURS) || 8;
export const JWT_EXPIRY_MS = JWT_EXPIRY_HOURS * 60 * 60 * 1000;

export const cookieOptions = {
  httpOnly: true,
  secure: isProduction, // requires HTTPS; only true in production
  sameSite: "Lax", // API is now served same-origin via the Vercel /api rewrite in production
  maxAge: JWT_EXPIRY_MS,
};

export const generateToken = (id, tokenVersion) =>
  jwt.sign({ id, token_version: tokenVersion }, process.env.JWT_SECRET, {
    algorithm: "HS256",
    expiresIn: JWT_EXPIRY_MS / 1000, // jsonwebtoken takes seconds when given a number
  });

// ============================================================
// Email verification (OTP) helpers
// ============================================================
const OTP_TTL_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_MAX_PER_HOUR = 3;
const OTP_RESEND_COOLDOWN_SECONDS = 60;
const RESET_COOLDOWN_MINUTES = 5;

// Reset tokens are 32 random bytes, so a fast unsalted hash is enough: the DB
// holds only sha256(token), and the plaintext exists only in the emailed link.
const hashResetToken = (token) => crypto.createHash("sha256").update(token).digest("hex");

// Precomputed once so the "email not found" / "already verified" branches of
// verifyEmail can spend the same bcrypt cost as a real comparison — otherwise
// those branches return measurably faster and leak account state via timing.
const DUMMY_CODE_HASH = bcrypt.hashSync("dummy-timing-safety", 10);

async function issueVerificationCode(userId, email, fullName) {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  const codeHash = await bcrypt.hash(code, 10);
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

  await pool.query(
    "INSERT INTO email_verification_codes (user_id, code_hash, expires_at) VALUES ($1, $2, $3)",
    [userId, codeHash, expiresAt]
  );

  await enqueueEmail("verification-code", {
    to: email,
    fullName,
    encryptedCode: encryptOtp(code),
    expiresInMinutes: OTP_TTL_MINUTES,
  });
}

// ============================================================
// REGISTER
// ============================================================
export async function register(req, res) {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const { full_name, email, password } = parsed.data;

  if (!isAllowedDomain(email)) {
    return res.status(403).json({
      success: false,
      message: "Registration is restricted to @mitwpu.edu.in email addresses.",
    });
  }

  try {
    const user = await registerUser(full_name, email, password);
    await issueVerificationCode(user.id, email, full_name);
    res.status(201).json({ requiresVerification: true, email });
  } catch (err) {
    if (err.message === "User already exists") {
      // Generic message — doesn't confirm whether the email is already registered.
      return res.status(400).json({
        success: false,
        message: "Registration failed. Please check your details and try again.",
      });
    }
    sendError(res, 500, "Registration failed", err);
  }
}

// ============================================================
// LOGIN
// ============================================================
export async function login(req, res) {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const { email, password } = parsed.data;

  try {
    const user = await findUserByEmail(email);
    if (!user) {
      logAuditEvent({ action: "login.failed", metadata: { email, reason: "unknown_user" } });
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      logAuditEvent({
        actorUserId: user.user_id,
        action: "login.failed",
        metadata: { email, reason: "bad_password" },
      });
      return res.status(401).json({ error: "Invalid credentials" });
    }

    if (!user.email_verified) {
      return res.status(403).json({
        error: "Please verify your email before logging in.",
        code: "EMAIL_NOT_VERIFIED",
        email: user.email,
      });
    }

    const token = generateToken(user.user_id, user.token_version);
    res.cookie("token", token, cookieOptions);
    logAuditEvent({ actorUserId: user.user_id, action: "login.succeeded", metadata: { email } });
    res.json({
      message: "Login successful",
      user: {
        id: user.user_id,
        full_name: user.full_name,
        email: user.email,
        is_admin: user.is_admin,
      },
    });
  } catch (err) {
    sendError(res, 500, "Login failed", err);
  }
}

// ============================================================
// FORGOT PASSWORD
// ============================================================
export async function forgotPassword(req, res) {
  const parsed = forgotPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ errors: parsed.error.flatten().fieldErrors });
  }

  const { email } = parsed.data;

  // Always respond the same way — prevents user enumeration
  const genericResponse = {
    message: "If that email is registered, a reset link has been sent.",
  };

  try {
    const user = await findUserByEmail(email);
    if (!user) return res.json(genericResponse);

    // Cooldown (audit F8): a still-valid link issued in the last few minutes
    // means this is a repeat — don't delete it (the user may be mid-reset)
    // and don't mail another. Same generic response either way.
    const recent = await pool.query(
      `SELECT 1 FROM password_reset_tokens
       WHERE user_id = $1 AND expires_at > NOW()
         AND created_at > NOW() - make_interval(mins => $2)`,
      [user.user_id, RESET_COOLDOWN_MINUTES]
    );
    if (recent.rowCount > 0) return res.json(genericResponse);

    // Invalidate any existing tokens for this user
    await pool.query("DELETE FROM password_reset_tokens WHERE user_id = $1", [
      user.user_id,
    ]);

    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await pool.query(
      "INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)",
      [user.user_id, hashResetToken(token), expiresAt],
    );

    const resetUrl = `${process.env.FRONTEND_ORIGIN}/reset-password?token=${token}`;
    await enqueueEmail("password-reset", { to: email, resetUrl });

    res.json(genericResponse);
  } catch (err) {
    console.error("Forgot password error:", err);
    res.status(500).json({ error: "Failed to process request" });
  }
}

// ============================================================
// RESET PASSWORD
// ============================================================
export async function resetPassword(req, res) {
  const parsed = resetPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ errors: parsed.error.flatten().fieldErrors });
  }

  const { token, password } = parsed.data;

  try {
    const result = await pool.query(
      "SELECT * FROM password_reset_tokens WHERE token_hash = $1",
      [hashResetToken(token)],
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: "Invalid or expired reset token" });
    }

    const row = result.rows[0];

    if (new Date(row.expires_at) < new Date()) {
      await pool.query("DELETE FROM password_reset_tokens WHERE id = $1", [
        row.id,
      ]);
      return res.status(400).json({ error: "Reset token has expired" });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    await pool.query(
      "UPDATE user_auth SET password_hash = $1 WHERE user_id = $2",
      [passwordHash, row.user_id],
    );

    // Bumping token_version invalidates every JWT issued before this reset.
    await pool.query(
      "UPDATE profiles SET token_version = token_version + 1 WHERE id = $1",
      [row.user_id],
    );

    logAuditEvent({ actorUserId: row.user_id, action: "password.reset" });

    await pool.query("DELETE FROM password_reset_tokens WHERE id = $1", [
      row.id,
    ]);

    res.json({ message: "Password reset successfully. You can now log in." });
  } catch (err) {
    console.error("Reset password error:", err);
    res.status(500).json({ error: "Failed to reset password" });
  }
}

// ============================================================
// VERIFY EMAIL
// ============================================================
export async function verifyEmail(req, res) {
  const parsed = verifyEmailSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ errors: parsed.error.flatten().fieldErrors });
  }

  const { email, code, password } = parsed.data;

  // "Invalid code" is deliberately reused for every case that would otherwise
  // reveal whether this email is registered (not found / already verified) —
  // only "expired" is distinguished, matching the granularity resetPassword
  // already uses for its own token, so this isn't a new enumeration surface.
  const invalidCodeResponse = () =>
    res.status(400).json({ error: "Incorrect verification code.", code: "INVALID_CODE" });
  const expiredCodeResponse = () =>
    res.status(400).json({
      error: "This code has expired or is no longer valid. Please request a new one.",
      code: "CODE_EXPIRED",
    });

  try {
    const userResult = await pool.query(
      `SELECT p.id, p.full_name, p.email, p.is_admin, p.email_verified, a.password_hash
       FROM profiles p LEFT JOIN user_auth a ON a.user_id = p.id
       WHERE p.email = $1`,
      [email]
    );

    if (userResult.rows.length === 0 || userResult.rows[0].email_verified) {
      await bcrypt.compare(code, DUMMY_CODE_HASH); // keep timing consistent with the real-code path below
      return invalidCodeResponse();
    }

    const user = userResult.rows[0];

    const codeResult = await pool.query(
      `SELECT * FROM email_verification_codes
       WHERE user_id = $1 AND consumed_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      [user.id]
    );

    if (codeResult.rows.length === 0) {
      await bcrypt.compare(code, DUMMY_CODE_HASH);
      return invalidCodeResponse();
    }

    const row = codeResult.rows[0];

    if (new Date(row.expires_at) < new Date()) {
      return expiredCodeResponse();
    }

    // Claim an attempt atomically *before* evaluating the guess. A
    // read-then-increment let parallel requests all see attempts < 5 and
    // each get a guess evaluated; this conditional UPDATE can succeed at most
    // OTP_MAX_ATTEMPTS times per code, however many requests race.
    const claimed = await pool.query(
      `UPDATE email_verification_codes SET attempts = attempts + 1
       WHERE id = $1 AND consumed_at IS NULL AND attempts < $2
       RETURNING id`,
      [row.id, OTP_MAX_ATTEMPTS]
    );
    if (claimed.rowCount === 0) return expiredCodeResponse();

    // F0: the code proves mailbox control, the password proves this is the
    // person who registered. Both are required, and a wrong password is
    // indistinguishable from a wrong code (no oracle for either). Both
    // compares always run so timing doesn't reveal which one failed.
    const [codeOk, passwordOk] = await Promise.all([
      bcrypt.compare(code, row.code_hash),
      bcrypt.compare(password, user.password_hash ?? DUMMY_CODE_HASH),
    ]);
    if (!codeOk || !passwordOk || !user.password_hash) {
      return invalidCodeResponse();
    }

    const consumed = await pool.query(
      "UPDATE email_verification_codes SET consumed_at = NOW() WHERE id = $1 AND consumed_at IS NULL",
      [row.id]
    );
    if (consumed.rowCount === 0) return invalidCodeResponse(); // lost a race with a concurrent verify

    // Bumping token_version drops any session issued before verification.
    const { rows: [verified] } = await pool.query(
      `UPDATE profiles SET email_verified = TRUE, token_version = token_version + 1
       WHERE id = $1 RETURNING token_version`,
      [user.id]
    );
    await enqueueEmail("welcome", { to: user.email, fullName: user.full_name });

    const token = generateToken(user.id, verified.token_version);
    res.cookie("token", token, cookieOptions);
    res.json({
      message: "Email verified successfully",
      user: { id: user.id, full_name: user.full_name, email: user.email, is_admin: user.is_admin },
    });
  } catch (err) {
    sendError(res, 500, "Verification failed", err);
  }
}

// ============================================================
// RESEND VERIFICATION
// ============================================================
export async function resendVerification(req, res) {
  const parsed = resendVerificationSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ errors: parsed.error.flatten().fieldErrors });
  }

  const { email } = parsed.data;

  // Always the same response regardless of whether the email exists, is
  // already verified, or is rate-limited — prevents user enumeration. The
  // frontend's 60s cooldown is enforced client-side after this call, not
  // derived from anything in this response.
  const genericResponse = {
    message: "If that email has a pending verification, a new code has been sent.",
  };

  try {
    const userResult = await pool.query(
      "SELECT id, full_name, email, email_verified FROM profiles WHERE email = $1",
      [email]
    );
    if (userResult.rows.length === 0) return res.json(genericResponse);

    const user = userResult.rows[0];
    if (user.email_verified) return res.json(genericResponse);

    const recentCodes = await pool.query(
      `SELECT created_at FROM email_verification_codes
       WHERE user_id = $1 AND created_at > NOW() - INTERVAL '1 hour'
       ORDER BY created_at DESC`,
      [user.id]
    );

    if (recentCodes.rows.length > 0) {
      const secondsSinceLast = (Date.now() - new Date(recentCodes.rows[0].created_at).getTime()) / 1000;
      if (secondsSinceLast < OTP_RESEND_COOLDOWN_SECONDS) return res.json(genericResponse);
      if (recentCodes.rows.length >= OTP_RESEND_MAX_PER_HOUR) return res.json(genericResponse);
    }

    // Invalidate any outstanding code before issuing a new one.
    await pool.query(
      "UPDATE email_verification_codes SET consumed_at = NOW() WHERE user_id = $1 AND consumed_at IS NULL",
      [user.id]
    );

    await issueVerificationCode(user.id, user.email, user.full_name);

    res.json(genericResponse);
  } catch (err) {
    console.error("Resend verification error:", err);
    res.status(500).json({ error: "Failed to process request" });
  }
}
