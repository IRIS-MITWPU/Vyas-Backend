// routes/users.js
import express from "express";
import {
  requestCode,
  verifyCode,
  reauthRequest,
  reauthVerify,
  logout,
  logoutAll,
  listSessions,
  revokeSessionById,
  fullNameSchema,
} from "../controllers/userController.js";
import { protect, adminOnly, requireFreshAuth } from "../middlewares/authMiddleware.js";
import { otpRequestLimiter, otpVerifyLimiter, otpEmailLimiter } from "../middlewares/rateLimiter.js";
import pool from "../database/db.js";
import { logAuditEvent } from "../services/auditLog.js";

const router = express.Router();

// Email-code sign-in (the only way in besides Google). Passwords no longer exist.
router.post("/otp/request", otpRequestLimiter, otpEmailLimiter, requestCode);
router.post("/otp/verify", otpVerifyLimiter, verifyCode);

// Step-up: a fresh code before destructive/admin actions (see requireFreshAuth).
router.post("/reauth/request", protect, otpRequestLimiter, reauthRequest);
router.post("/reauth/verify", protect, otpVerifyLimiter, reauthVerify);

// The old password endpoints are gone for good.
const gone = (req, res) =>
  res.status(410).json({ error: "Passwords are no longer used. Sign in with an emailed code." });
for (const path of ["/register", "/login", "/forgot-password", "/reset-password", "/verify-email", "/resend-verification"]) {
  router.post(path, gone);
}

// ==============================
// GET /user/me — current user's profile
// ==============================
router.get("/me", protect, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, full_name, email, department, is_admin, created_at, updated_at FROM profiles WHERE id = $1",
      [req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: "Profile not found" });
    }
    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    console.error("Error fetching profile:", err);
    res.status(500).json({ error: "Failed to fetch profile" });
  }
});

// ==============================
// PATCH /user/me — update current user's profile
// ==============================
router.patch("/me", protect, async (req, res) => {
  const { full_name, department } = req.body;

  let fullName;
  if (full_name !== undefined) {
    const parsed = fullNameSchema.safeParse(full_name);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: parsed.error.issues[0].message });
    }
    fullName = parsed.data;
  }

  const fields = [];
  const values = [];
  let i = 1;

  if (fullName !== undefined) {
    fields.push(`full_name = $${i++}`);
    values.push(fullName);
  }
  if (department !== undefined) {
    fields.push(`department = $${i++}`);
    values.push(department || null);
  }

  if (fields.length === 0) {
    return res.status(400).json({ success: false, error: "No fields to update" });
  }

  fields.push(`updated_at = $${i++}`);
  values.push(new Date().toISOString());
  values.push(req.user.id);

  try {
    const result = await pool.query(
      `UPDATE profiles SET ${fields.join(", ")} WHERE id = $${i}
       RETURNING id, full_name, email, department, is_admin, created_at, updated_at`,
      values
    );
    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    console.error("Error updating profile:", err);
    res.status(500).json({ success: false, error: "Failed to update profile" });
  }
});

// ==============================
// Sessions: sign out (revokes this session server-side, so a copied cookie
// dies too), sign out everywhere, and the "your devices" list.
// ==============================
router.post("/logout", logout);
router.post("/logout-all", protect, logoutAll);
router.get("/sessions", protect, listSessions);
router.delete("/sessions/:id", protect, revokeSessionById);

// ==============================
// GET /user/search — search users for invitees
// ==============================
router.get("/search", protect, async (req, res) => {
  const { q } = req.query;
  if (!q || typeof q !== "string" || !q.trim()) {
    return res.json({ success: true, users: [] });
  }
  try {
    const result = await pool.query(
      `SELECT id, full_name, email FROM profiles
       WHERE full_name ILIKE $1 OR email ILIKE $1
       LIMIT 8`,
      [`%${q.trim()}%`]
    );
    res.json({ success: true, users: result.rows });
  } catch (err) {
    console.error("Error searching users:", err);
    res.status(500).json({ error: "Search failed" });
  }
});

// ==============================
// ADMIN: LIST ALL USERS
// ==============================
router.get("/all", protect, adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, full_name, email, department, is_admin, created_at, updated_at
       FROM profiles
       ORDER BY created_at DESC`
    );
    res.json({ success: true, users: result.rows, total: result.rows.length });
  } catch (err) {
    console.error("Error fetching users:", err);
    res.status(500).json({ error: "Failed to fetch users" });
  }
});

// ==============================
// ADMIN: TOGGLE is_admin FLAG
// ==============================
router.patch("/:id/admin", protect, adminOnly, requireFreshAuth, async (req, res) => {
  const { id } = req.params;

  if (id === req.user.id) {
    return res.status(400).json({ error: "Cannot modify your own admin status" });
  }

  try {
    const result = await pool.query(
      `UPDATE profiles
       SET is_admin = NOT is_admin
       WHERE id = $1
       RETURNING id, full_name, email, is_admin`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const user = result.rows[0];
    logAuditEvent({
      actorUserId: req.user.id,
      action: "user.admin_toggled",
      targetType: "profile",
      targetId: user.id,
      metadata: { is_admin: user.is_admin },
    });
    res.json({
      success: true,
      message: `${user.full_name} is now ${user.is_admin ? "an admin" : "a regular user"}`,
      user,
    });
  } catch (err) {
    console.error("Error toggling admin status:", err);
    res.status(500).json({ error: "Failed to update user" });
  }
});

export default router;
