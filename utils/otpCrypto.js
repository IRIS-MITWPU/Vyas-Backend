// utils/otpCrypto.js
// The verification email is sent via the existing BullMQ email queue (not
// inline), which means the job payload briefly lives in Redis. The OTP code
// itself is hashed (one-way) in email_verification_codes for storage, but the
// worker still needs the plaintext code to put in the email — so instead of
// putting the raw digits in the Redis-backed job payload, they're encrypted
// here and only decrypted inside the worker right before sending.
import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const KEY = crypto.createHash("sha256").update(process.env.JWT_SECRET).digest();

export function encryptOtp(code) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
  const encrypted = Buffer.concat([cipher.update(String(code), "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

export function decryptOtp(payload) {
  const buf = Buffer.from(payload, "base64");
  const iv = buf.subarray(0, 12);
  const authTag = buf.subarray(12, 28);
  const encrypted = buf.subarray(28);
  const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}
