// controllers/userController.js
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { z } from "zod";
import { registerUser, findUserByEmail } from "../models/userModel.js";
import pool from "../database/db.js";
import { enqueueEmail } from "../services/emailQueue.js";

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

// ============================================================
// Helpers
// ============================================================
const isProduction = process.env.NODE_ENV === "production";
const cookieOptions = {
  httpOnly: true,
  secure: isProduction, // SameSite=None requires Secure; only true in production (HTTPS)
  sameSite: isProduction ? "None" : "Lax",
  maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
};

const generateToken = (id, tokenVersion) =>
  jwt.sign({ id, token_version: tokenVersion }, process.env.JWT_SECRET, { expiresIn: "30d" });

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

  if (!email.endsWith("@mitwpu.edu.in")) {
    return res.status(403).json({
      success: false,
      message: "Registration is restricted to @mitwpu.edu.in email addresses.",
    });
  }

  try {
    const user = await registerUser(full_name, email, password);
    await enqueueEmail("welcome", { to: email, fullName: full_name });
    const token = generateToken(user.id, user.token_version);
    res.cookie("token", token, cookieOptions);
    res
      .status(201)
      .json({ message: "User registered successfully", user, token });
  } catch (err) {
    if (err.message === "User already exists") {
      // Generic message — doesn't confirm whether the email is already registered.
      return res.status(400).json({
        success: false,
        message: "Registration failed. Please check your details and try again.",
      });
    }
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
