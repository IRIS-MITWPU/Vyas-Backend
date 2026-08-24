// config/oauthStateStore.js
//
// passport-oauth2's built-in `state: true` store (NonceStore) requires
// req.session — this app has no express-session middleware (stateless
// JWT-cookie design, session:false everywhere). Using state:true as-is
// would fail every request with "OAuth 2.0 authentication requires
// session support". This is a passport-oauth2-compatible StateStore that
// stores the CSRF state nonce in a short-lived httpOnly cookie instead —
// the fallback OAUTH_AWS_IMPLEMENTATION_PLAN.md calls for.
//
// req.res is relied on here — Express sets req.res = res / res.req = req
// for every request (lib/application.js), so it's safe to use inside a
// passport state store, which is only ever handed `req`.
import crypto from "crypto";

const STATE_COOKIE_NAME = "oauth_state";
const STATE_COOKIE_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes — only needed between /auth/google and its callback

export class CookieStateStore {
  store(req, callback) {
    const state = crypto.randomBytes(16).toString("hex");
    req.res.cookie(STATE_COOKIE_NAME, state, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "Lax", // Google's redirect back is a top-level navigation; Lax survives that
      maxAge: STATE_COOKIE_MAX_AGE_MS,
    });
    callback(null, state);
  }

  verify(req, providedState, callback) {
    const stored = req.cookies?.[STATE_COOKIE_NAME];
    // One-time use — clear regardless of outcome.
    req.res.clearCookie(STATE_COOKIE_NAME, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "Lax",
    });

    if (!stored) {
      return callback(null, false, { message: "Unable to verify authorization request state." });
    }
    if (stored !== providedState) {
      return callback(null, false, { message: "Invalid authorization request state." });
    }
    return callback(null, true);
  }
}
