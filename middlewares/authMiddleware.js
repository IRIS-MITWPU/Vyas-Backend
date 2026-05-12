// middleware/authMiddleware.js
import jwt from "jsonwebtoken";
import pool from "../database/db.js";

// VERIFY TOKEN MIDDLEWARE
export const protect = async (req, res, next) => {
  try {
    const token =
      req.cookies?.token ||
      (req.headers.authorization?.startsWith("Bearer ")
        ? req.headers.authorization.split(" ")[1]
        : null);

    if (!token) {
      return res.status(401).json({ error: "Not authorized, no token provided" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const userResult = await pool.query(
      "SELECT id, full_name, email, is_admin FROM profiles WHERE id = $1",
      [decoded.id]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    req.user = userResult.rows[0];
    next();
  } catch (err) {
    console.error("Auth Error:", err);
    res.status(401).json({ error: "Token is invalid or expired" });
  }
};
// ADMIN-ONLY ACCESS
export const adminOnly = (req, res, next) => {
  if (!req.user || !req.user.is_admin) {
    return res.status(403).json({ error: "Access denied, admin only" });
  }
  next();
};