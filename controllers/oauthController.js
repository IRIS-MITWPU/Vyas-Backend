// controllers/oauthController.js
import { generateToken, cookieOptions } from "./userController.js";

const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:5173";

// req.user here is the profiles row returned by findOrCreateGoogleUser via
// the passport verify callback — never request-influenced data.
export function googleCallback(req, res) {
  const user = req.user;
  const token = generateToken(user.id, user.token_version);
  res.cookie("token", token, cookieOptions);
  // FRONTEND_ORIGIN is env-configured, not derived from the request — no
  // open-redirect surface here.
  res.redirect(`${FRONTEND_ORIGIN}/auth/callback`);
}

const ERROR_QUERY_PARAMS = {
  DOMAIN_NOT_ALLOWED: "domain_not_allowed",
  UNVERIFIED_ACCOUNT_EXISTS: "unverified_account_exists",
  OAUTH_FAILED: "oauth_failed",
};

export function googleFailure(req, res) {
  const code = req.authInfo?.message;
  const errorParam = ERROR_QUERY_PARAMS[code] || "oauth_failed";
  res.redirect(`${FRONTEND_ORIGIN}/auth?error=${errorParam}`);
}
