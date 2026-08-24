// utils/emailDomain.js
const ALLOWED_DOMAIN = "@mitwpu.edu.in";

export function isAllowedDomain(email) {
  return String(email || "").trim().toLowerCase().endsWith(ALLOWED_DOMAIN);
}
