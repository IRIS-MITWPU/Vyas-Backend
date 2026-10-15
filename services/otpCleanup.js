// services/otpCleanup.js
//
// Hourly sweep of auth data that has no further use: sign-in codes a day past
// expiry, and revoked/expired sessions (see purgeDeadSessions). Mirrors the
// interval-sweep pattern established by services/importReconciliation.js.
// (Name and exports kept from the old unverified-account sweep so app.js and
// worker.js need no change.)
import pool from "../database/db.js";
import { purgeDeadSessions } from "./sessions.js";

export async function cleanupAuthData() {
  const codes = await pool.query(
    "DELETE FROM auth_codes WHERE expires_at < NOW() - INTERVAL '1 day'"
  );
  const sessions = await purgeDeadSessions();
  if (codes.rowCount || sessions) {
    console.log(`[AuthCleanup] removed ${codes.rowCount} old code(s), ${sessions} dead session(s)`);
  }
}

let intervalHandle = null;

export function startOtpCleanupSweep(intervalMs = 60 * 60 * 1000) {
  cleanupAuthData().catch((err) => console.error("[AuthCleanup] Startup sweep failed:", err.message));
  intervalHandle = setInterval(() => {
    cleanupAuthData().catch((err) => console.error("[AuthCleanup] Periodic sweep failed:", err.message));
  }, intervalMs);
  intervalHandle.unref();
  return intervalHandle;
}

export function stopOtpCleanupSweep() {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
}
