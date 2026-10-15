// middleware/authMiddleware.js
import { verifySession, setSessionCookie, COOKIE_NAME, REAUTH_WINDOW_MS } from "../services/sessions.js";

/**
 * The single session rule: the token must belong to a live, unrevoked session
 * inside its idle and absolute limits (see services/sessions.js). Shared by
 * `protect` (REST) and `sockets/index.js` (`io.use`) so a revoked session can't
 * keep a socket alive after REST has already started rejecting it.
 * Throws on failure; returns `{ user, session }` on success.
 */
export const verifySessionToken = verifySession;

// VERIFY SESSION MIDDLEWARE
export const protect = async (req, res, next) => {
  try {
    const cookieToken = req.cookies?.[COOKIE_NAME];
    const token =
      cookieToken ||
      (req.headers.authorization?.startsWith("Bearer ")
        ? req.headers.authorization.split(" ")[1]
        : null);

    if (!token) {
      return res.status(401).json({ error: "Not authorized, no session" });
    }

    const { user, session } = await verifySession(token);

    // Sliding idle window: verifySession refreshes last_seen_at at most every
    // few minutes; renew the browser cookie's Max-Age at the same moment.
    // Only for cookie callers — a Bearer client has nowhere to put a Set-Cookie.
    if (session.touched && cookieToken) {
      setSessionCookie(res, token, { isAdmin: user.is_admin, remember: session.remember });
    }

    req.user = user;
    req.session = session;
    next();
  } catch (err) {
    console.error("Auth Error:", err.message);
    res.status(401).json({ error: "Session is invalid or expired" });
  }
};

// ADMIN-ONLY ACCESS
export const adminOnly = (req, res, next) => {
  if (!req.user || !req.user.is_admin) {
    return res.status(403).json({ error: "Access denied, admin only" });
  }
  next();
};

// STEP-UP: destructive/admin actions need a code entered within the last few
// minutes (login counts), so a hijacked-but-idle session can't do them.
// Must run after `protect`. The client answers REAUTH_REQUIRED by asking the
// user for an emailed code (POST /user/reauth/*) and retrying.
export const requireFreshAuth = (req, res, next) => {
  const age = req.session?.reauthAgeMs;
  if (age !== null && age !== undefined && age < REAUTH_WINDOW_MS) return next();
  res.status(403).json({
    error: "Please confirm it's you with a fresh code to continue.",
    code: "REAUTH_REQUIRED",
  });
};
