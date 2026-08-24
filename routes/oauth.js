// routes/oauth.js — Google OAuth 2.0 / OIDC sign-in, mounted at /auth in app.js.
// Kept separate from routes/users.js: this isn't a /user/* profile-CRUD
// concern, and the callback path must exactly match what's registered as
// an Authorized redirect URI in Google Cloud Console.
import express from "express";
import passport from "../config/passport.js";
import { googleCallback, googleFailure } from "../controllers/oauthController.js";
import { oauthLimiter } from "../middlewares/rateLimiter.js";

const router = express.Router();

router.get(
  "/google",
  oauthLimiter,
  passport.authenticate("google", { scope: ["openid", "profile", "email"], session: false, state: true })
);

router.get("/google/callback", oauthLimiter, (req, res, next) => {
  passport.authenticate("google", { session: false, state: true }, (err, user, info) => {
    if (err) return next(err);
    if (!user) {
      req.authInfo = info;
      return googleFailure(req, res);
    }
    req.user = user;
    return googleCallback(req, res);
  })(req, res, next);
});

export default router;
