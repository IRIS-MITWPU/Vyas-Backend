import rateLimit from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import IORedis from "ioredis";

// Dedicated Redis connection for rate limiting — same ioredis/REDIS_URL
// pattern already used by services/emailQueue.js, services/importQueue.js,
// and sockets/index.js (each owns its own connection rather than sharing one).
// Unlike the BullMQ connections (which require maxRetriesPerRequest: null so
// jobs survive a blip), a rate-limit lookup must fail fast. With retries
// unbounded and the offline queue on, a Redis outage made every rate-limited
// request — i.e. every request, via generalLimiter — hang forever instead of
// erroring, so `passOnStoreError` below never fired and the whole API wedged.
// These three settings are what turn that hang into a prompt error that
// passOnStoreError can then let through.
const redisClient = new IORedis(process.env.REDIS_URL, {
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  commandTimeout: 500,
});
redisClient.on("error", (err) => console.error("❌ Rate-limiter Redis error:", err));

// rate-limit-redis's RedisStore.init() runs synchronously at rateLimit()
// construction time (right below) and caches whatever loadIncrementScript()
// returns — including a rejection — as this.incrementScriptSha forever; it
// only retries on a Redis-level NOSCRIPT error, never on a connection error.
// So if init() fires before this client finishes connecting, every limiter
// is permanently broken for the process's lifetime, even after Redis is up.
// Waiting here for "ready" (or a bounded timeout, so a real outage still
// fails open at boot instead of hanging) avoids that race.
await Promise.race([
  new Promise((resolve) => redisClient.once("ready", resolve)),
  new Promise((resolve) => setTimeout(resolve, 2000)),
]);

// Every limiter below pairs this store with `passOnStoreError: true` — a Redis
// outage degrades brute-force protection temporarily rather than taking down
// login/register entirely. Matches perEmailLimiter, which already fails open.
function redisStore(prefix) {
  return new RedisStore({
    sendCommand: (...args) => redisClient.call(...args),
    prefix,
  });
}

// Tighter limit for login — the highest-value brute-force target.
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Please try again in 15 minutes." },
  passOnStoreError: true,
  store: redisStore("rl:login:"),
});

// Looser limit for register/forgot-password/reset-password — still
// unauthenticated and abusable (account spam, reset-email flooding),
// but lower-frequency legitimate use than login.
export const authLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again in an hour." },
  passOnStoreError: true,
  store: redisStore("rl:auth:"),
});

// Separate, more generous limit for verify-email/resend-verification.
// These used to share authLimiter's 5/hour/IP bucket with register/forgot-
// password/reset-password — a legitimate new user could burn the whole
// budget with 1 register call + a few mistyped OTP codes, locking
// themselves out of verification for up to an hour. Split out so entering
// OTP codes (a normal part of the same signup flow) doesn't compete with
// the stricter budget meant for account-creation/reset abuse.
export const otpVerifyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again in an hour." },
  passOnStoreError: true,
  store: redisStore("rl:otp-verify:"),
});

// Google OAuth entry/callback endpoints — same shape as authLimiter, applied
// per-IP to both /auth/google and /auth/google/callback.
export const oauthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again in 15 minutes." },
  passOnStoreError: true,
  store: redisStore("rl:oauth:"),
});

// Baseline limit applied to every request — an additional layer on top of
// loginLimiter/authLimiter, which stay in place for their tighter limits.
export const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many requests, please try again later." },
  passOnStoreError: true,
  store: redisStore("rl:general:"),
});

// Per-email limiter for the OTP endpoints (register/verify-email/resend-verification).
// authLimiter alone is per-IP, which is trivially bypassed by rotating IPs to
// hammer one victim email's inbox or brute-force one account's code — this
// caps attempts against a single email address regardless of source IP.
// Redis-backed fixed window (INCR + EXPIRE on first increment), keyed by
// normalized email — same semantics as the old in-memory version, just
// shared across instances instead of per-process.
export function perEmailLimiter({ windowMs, max, message, keyPrefix }) {
  return async (req, res, next) => {
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!email) return next();

    const key = `${keyPrefix}:${email}`;
    try {
      const count = await redisClient.incr(key);
      if (count === 1) {
        await redisClient.pexpire(key, windowMs);
      }
      if (count > max) {
        return res.status(429).json({ error: message });
      }
      next();
    } catch (err) {
      console.error("❌ perEmailLimiter Redis error:", err);
      next(); // fail open — a Redis outage shouldn't block registration/verification
    }
  };
}

export const otpEmailLimiter = perEmailLimiter({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  message: "Too many requests for this email address. Please try again in an hour.",
  keyPrefix: "rl:otp-email",
});
