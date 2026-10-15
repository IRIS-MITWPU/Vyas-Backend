// utils/emailDomain.js
const ALLOWED_DOMAIN_RE = /^[^@\s]+@mitwpu\.edu\.in$/;

// The one place an email is canonicalised. profiles.email is lower-case only
// (CHECK constraint), so every entry point must go through this.
export function normalizeEmail(email) {
  return String(email ?? "").trim().toLowerCase();
}

export function isAllowedDomain(email) {
  return ALLOWED_DOMAIN_RE.test(normalizeEmail(email));
}
