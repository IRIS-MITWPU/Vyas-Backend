// routes/users.js
import express from "express";
import { register, login, forgotPassword, resetPassword } from "../controllers/userController.js";
import { protect, adminOnly } from "../middlewares/authMiddleware.js";
import { loginLimiter, authLimiter } from "../middlewares/rateLimiter.js";
import pool from "../database/db.js";

const router = express.Router();

router.post("/register", authLimiter, register);
router.post("/login", loginLimiter, login);
router.post("/forgot-password", authLimiter, forgotPassword);
router.post("/reset-password", authLimiter, resetPassword);

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

  if (full_name !== undefined && !full_name.trim()) {
    return res.status(400).json({ success: false, error: "full_name cannot be empty" });
  }

  const fields = [];
  const values = [];
  let i = 1;

  if (full_name !== undefined) {
    fields.push(`full_name = $${i++}`);
    values.push(full_name.trim());
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
// POST /user/logout — clear auth cookie
// ==============================
router.post("/logout", (req, res) => {
  res.clearCookie("token", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "Strict",
  });
  res.json({ success: true, message: "Logged out" });
});

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
router.patch("/:id/admin", protect, adminOnly, async (req, res) => {
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
