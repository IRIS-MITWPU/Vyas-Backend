// middleware/authMiddleware.js
import jwt from "jsonwebtoken";
import pool from "../database/db.js";
import { generateToken, cookieOptions, JWT_EXPIRY_MS } from "../controllers/userController.js";

// Re-issue the cookie once a session is more than halfway through its life.
// Keeps an active user logged in indefinitely while an idle one expires
// within JWT_EXPIRY_HOURS of their last request.
const SLIDE_AFTER_MS = JWT_EXPIRY_MS / 2;

/**
 * The single session rule: verify the JWT, load the profile, and reject if the
 * token's token_version is stale (i.e. the session was revoked by a password
 * reset or a "log out everywhere").
 *
 * Shared by `protect` (REST) and `sockets/index.js` (`io.use`) so a revoked
 * session can't keep a socket alive after REST has already started rejecting
 * it. Throws on failure; returns `{ user, decoded }` on success.
 */
export const verifySessionToken = async (token) => {
  const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });

  const userResult = await pool.query(
    "SELECT id, full_name, email, is_admin, token_version FROM profiles WHERE id = $1",
    [decoded.id]
  );

  if (userResult.rows.length === 0) {
    throw new Error("User not found");
  }

  const user = userResult.rows[0];
  if (user.token_version !== decoded.token_version) {
    throw new Error("Session revoked");
  }

  return { user, decoded };
};

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

    const { user, decoded } = await verifySessionToken(token);

    // Sliding session: refresh the cookie on activity so active users aren't
    // logged out. Only for cookie-based callers — a Bearer client has nowhere
    // to put a Set-Cookie.
    if (req.cookies?.token && decoded.exp * 1000 - Date.now() < SLIDE_AFTER_MS) {
      res.cookie("token", generateToken(user.id, user.token_version), cookieOptions);
    }

    req.user = user;
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
