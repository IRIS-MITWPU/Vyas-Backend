// config/passport.js
import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import { OAuth2Client } from "google-auth-library";
import { isAllowedDomain } from "../utils/emailDomain.js";
import { findOrCreateGoogleUser, UnverifiedAccountExistsError } from "../models/oauthModel.js";
import { CookieStateStore } from "./oauthStateStore.js";

// Used only to cryptographically verify the ID token's signature/claims —
// never to call Google APIs.
const idTokenClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: process.env.GOOGLE_CALLBACK_URL,
      store: new CookieStateStore(),
    },
    // arity-5 verify callback (accessToken, refreshToken, params, profile, done):
    // passport-oauth2 passes the raw token-exchange response as `params` only
    // when the verify function's arity is 5 — this is how we reach the ID
    // token (params.id_token), since the `openid` scope makes Google include
    // it in that response. `profile` (from Google's userinfo endpoint) is
    // deliberately NOT used as the source of identity claims below — the
    // OIDC requirement here is to trust only the cryptographically verified
    // ID token, not an unauthenticated profile fetch.
    async (accessToken, refreshToken, params, profile, done) => {
      try {
        const idToken = params?.id_token;
        if (!idToken) {
          return done(null, false, { message: "OAUTH_FAILED" });
        }

        const ticket = await idTokenClient.verifyIdToken({
          idToken,
          audience: process.env.GOOGLE_CLIENT_ID,
        });
        // verifyIdToken() throws if iss/aud/exp/signature don't check out —
        // reaching this line means those are already verified.
        const payload = ticket.getPayload();

        if (!payload || payload.email_verified !== true) {
          return done(null, false, { message: "OAUTH_FAILED" });
        }

        const email = String(payload.email).trim().toLowerCase();
        if (!isAllowedDomain(email)) {
          return done(null, false, { message: "DOMAIN_NOT_ALLOWED" });
        }

        const user = await findOrCreateGoogleUser({
          googleId: payload.sub,
          email,
          fullName: payload.name || profile?.displayName || email,
        });
        return done(null, user);
      } catch (err) {
        if (err instanceof UnverifiedAccountExistsError) {
          return done(null, false, { message: "UNVERIFIED_ACCOUNT_EXISTS" });
        }
        return done(err);
      }
    }
  )
);

// No serializeUser/deserializeUser — never used, since every route runs
// with session:false (JWT-cookie sessions, same as the rest of the app).

export default passport;
