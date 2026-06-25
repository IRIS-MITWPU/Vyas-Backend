import rateLimit from "express-rate-limit";

// Tighter limit for login — the highest-value brute-force target.
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Please try again in 15 minutes." },
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
});

// Baseline limit applied to every request — an additional layer on top of
// loginLimiter/authLimiter, which stay in place for their tighter limits.
export const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many requests, please try again later." },
});
