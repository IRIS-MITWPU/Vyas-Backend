// services/otpCleanup.js
//
// A user who registers and never verifies stays as an unverified `profiles`
// row indefinitely otherwise — this sweeps those away 24h after creation, per
// otp-1's design default. Mirrors the interval-sweep pattern already
// established by services/importReconciliation.js.
import pool from "../database/db.js";

const UNVERIFIED_ACCOUNT_TTL_HOURS = 24;

export async function cleanupUnverifiedAccounts() {
  // Deleting the profile cascades to user_auth and email_verification_codes
  // (both FK ON DELETE CASCADE) — no other query needed.
  const result = await pool.query(
    `DELETE FROM profiles
     WHERE email_verified = FALSE
       AND created_at < NOW() - ($1 || ' hours')::interval
     RETURNING id`,
    [UNVERIFIED_ACCOUNT_TTL_HOURS]
  );
  if (result.rows.length) {
    console.log(`[OtpCleanup] removed ${result.rows.length} abandoned unverified account(s)`);
  }
}

let intervalHandle = null;

export function startOtpCleanupSweep(intervalMs = 60 * 60 * 1000) {
  cleanupUnverifiedAccounts().catch((err) => console.error("[OtpCleanup] Startup sweep failed:", err.message));
  intervalHandle = setInterval(() => {
    cleanupUnverifiedAccounts().catch((err) => console.error("[OtpCleanup] Periodic sweep failed:", err.message));
  }, intervalMs);
  intervalHandle.unref();
  return intervalHandle;
}

export function stopOtpCleanupSweep() {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
}
