// controllers/oauthController.js
import { createSession, setSessionCookie } from "../services/sessions.js";
import { logAuditEvent } from "../services/auditLog.js";

const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:5173";

// req.user here is the profiles row returned by findOrCreateGoogleUser via
// the passport verify callback — never request-influenced data.
export async function googleCallback(req, res) {
  const user = req.user;
  // Google sign-in is an explicit choice on the user's own account, so it gets the
  // normal ("keep me signed in") session; Google's own login on the device is the
  // real gate on a shared computer.
  const { token } = await createSession(user.id, {
    remember: true,
    ip: req.ip,
    userAgent: req.get("user-agent") ?? null,
  });
  setSessionCookie(res, token, { isAdmin: user.is_admin, remember: true });
  logAuditEvent({ actorUserId: user.id, action: "login.succeeded", metadata: { method: "google" } });
  // FRONTEND_ORIGIN is env-configured, not derived from the request — no
  // open-redirect surface here.
  res.redirect(`${FRONTEND_ORIGIN}/auth/callback`);
}

const ERROR_QUERY_PARAMS = {
  DOMAIN_NOT_ALLOWED: "domain_not_allowed",
  NOT_ALLOWED: "not_allowed",
  OAUTH_FAILED: "oauth_failed",
};

export function googleFailure(req, res) {
  const code = req.authInfo?.message;
  const errorParam = ERROR_QUERY_PARAMS[code] || "oauth_failed";
  res.redirect(`${FRONTEND_ORIGIN}/auth?error=${errorParam}`);
}
