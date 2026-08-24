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

// ============================================================
// Validation schemas
// ============================================================
const registerSchema = z.object({
  full_name: z.string().min(1, "Full name is required"),
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

const verifyEmailSchema = z.object({
  email: z.string().email("Invalid email format"),
  code: z.string().regex(/^\d{6}$/, "Code must be 6 digits"),
});

const resendVerificationSchema = z.object({
  email: z.string().email("Invalid email format"),
});

// ============================================================
// Helpers
// ============================================================
const isProduction = process.env.NODE_ENV === "production";
export const cookieOptions = {
  httpOnly: true,
  secure: isProduction, // requires HTTPS; only true in production
  sameSite: "Lax", // API is now served same-origin via the Vercel /api rewrite in production
  maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
};

export const generateToken = (id, tokenVersion) =>
  jwt.sign({ id, token_version: tokenVersion }, process.env.JWT_SECRET, { expiresIn: "30d" });

// ============================================================
// Email verification (OTP) helpers
// ============================================================
const OTP_TTL_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_MAX_PER_HOUR = 3;
const OTP_RESEND_COOLDOWN_SECONDS = 60;

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
    if (!user) return res.status(401).json({ error: "Invalid credentials" });

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) return res.status(401).json({ error: "Invalid credentials" });

    if (!user.email_verified) {
      return res.status(403).json({
        error: "Please verify your email before logging in.",
        code: "EMAIL_NOT_VERIFIED",
        email: user.email,
      });
    }

    const token = generateToken(user.user_id, user.token_version);
    res.cookie("token", token, cookieOptions);
    res.json({
      message: "Login successful",
      user: {
        id: user.user_id,
        full_name: user.full_name,
        email: user.email,
        is_admin: user.is_admin,
      },
      token,
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

    // Invalidate any existing tokens for this user
    await pool.query("DELETE FROM password_reset_tokens WHERE user_id = $1", [
      user.user_id,
    ]);

    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await pool.query(
      "INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)",
      [user.user_id, token, expiresAt],
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
      "SELECT * FROM password_reset_tokens WHERE token = $1",
      [token],
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

  const { email, code } = parsed.data;

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
      "SELECT id, full_name, email, is_admin, token_version, email_verified FROM profiles WHERE email = $1",
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

    if (new Date(row.expires_at) < new Date() || row.attempts >= OTP_MAX_ATTEMPTS) {
      return expiredCodeResponse();
    }

    const isMatch = await bcrypt.compare(code, row.code_hash);
    if (!isMatch) {
      await pool.query("UPDATE email_verification_codes SET attempts = attempts + 1 WHERE id = $1", [row.id]);
      return invalidCodeResponse();
    }

    await pool.query("UPDATE email_verification_codes SET consumed_at = NOW() WHERE id = $1", [row.id]);
    await pool.query("UPDATE profiles SET email_verified = TRUE WHERE id = $1", [user.id]);
    await enqueueEmail("welcome", { to: user.email, fullName: user.full_name });

    const token = generateToken(user.id, user.token_version);
    res.cookie("token", token, cookieOptions);
    res.json({
      message: "Email verified successfully",
      user: { id: user.id, full_name: user.full_name, email: user.email, is_admin: user.is_admin },
      token,
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
