// scripts/verify-otp-flow.mjs
// Throwaway verification script for Phase 3 (OTP email verification), part 1.
// Exercises the real HTTP endpoints against a locally running instance
// (pass its port via OTP_TEST_PORT, default 3000) + the real DB.
//
// Deliberately economical with authLimiter-guarded calls (register +
// verify-email + resend-verification all share one 5-per-hour-per-IP budget
// by design — see FINDINGS.md) — uses exactly 5 authLimiter hits total
// (1 register + 4 verify-email) so it fits in one rate-limit window.
//
// Cannot verify actual email delivery/rendering content (no accessible
// @mitwpu.edu.in inbox available) — swaps in a known code hash directly in
// the DB (same bcrypt hashing the controller itself uses) to exercise the
// verify-email endpoint's comparison/attempts/expiry logic end-to-end
// instead of reading the code out of a real inbox.
import "dotenv/config";
import bcrypt from "bcryptjs";
import pool from "../database/db.js";

const PORT = process.env.OTP_TEST_PORT || 3000;
const BASE = `http://localhost:${PORT}`;
const email = `otp-verify-${Date.now()}@mitwpu.edu.in`;
const password = "TestPassword123";
let failures = 0;

function check(label, condition, detail) {
  if (condition) {
    console.log(`PASS: ${label}`);
  } else {
    failures++;
    console.log(`FAIL: ${label}${detail ? " — " + JSON.stringify(detail) : ""}`);
  }
}

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function main() {
  console.log(`--- register (${email}) [authLimiter hit 1/5] ---`);
  const reg = await post("/user/register", { full_name: "OTP Verify", email, password });
  console.log(reg.status, reg.body);
  check("register returns 201 with requiresVerification, no token", reg.status === 201 && reg.body.requiresVerification === true && !reg.body.token, reg.body);

  const codeRowInitial = await pool.query(
    "SELECT * FROM email_verification_codes WHERE user_id = (SELECT id FROM profiles WHERE email = $1)",
    [email]
  );
  check("a hashed code row was created (not plaintext)", codeRowInitial.rows.length === 1 && codeRowInitial.rows[0].code_hash.startsWith("$2"), codeRowInitial.rows[0]);

  console.log("--- login before verifying (loginLimiter, not authLimiter — expect 403 EMAIL_NOT_VERIFIED) ---");
  const loginBefore = await post("/user/login", { email, password });
  console.log(loginBefore.status, loginBefore.body);
  check("unverified login rejected with EMAIL_NOT_VERIFIED", loginBefore.status === 403 && loginBefore.body.code === "EMAIL_NOT_VERIFIED", loginBefore.body);

  const userRes = await pool.query("SELECT id FROM profiles WHERE email = $1", [email]);
  const userId = userRes.rows[0].id;

  const KNOWN_CODE = "123456";
  const knownHash = await bcrypt.hash(KNOWN_CODE, 10);
  await pool.query(
    "UPDATE email_verification_codes SET code_hash = $1, attempts = 0 WHERE user_id = $2 AND consumed_at IS NULL",
    [knownHash, userId]
  );

  console.log("--- wrong code once [authLimiter hit 2/5] (expect INVALID_CODE, attempts -> 1) ---");
  const wrong = await post("/user/verify-email", { email, code: "000000" });
  console.log(wrong.status, wrong.body);
  check("wrong code rejected with INVALID_CODE", wrong.status === 400 && wrong.body.code === "INVALID_CODE", wrong.body);
  const attemptsRow = await pool.query(
    "SELECT attempts FROM email_verification_codes WHERE user_id = $1 AND consumed_at IS NULL",
    [userId]
  );
  check("attempts incremented after one wrong try", attemptsRow.rows[0]?.attempts === 1, attemptsRow.rows[0]);

  console.log("--- simulate 5 exhausted attempts directly in DB, then try the CORRECT code [authLimiter hit 3/5] (expect still rejected: burned) ---");
  await pool.query("UPDATE email_verification_codes SET attempts = 5 WHERE user_id = $1 AND consumed_at IS NULL", [userId]);
  const afterBurn = await post("/user/verify-email", { email, code: KNOWN_CODE });
  console.log(afterBurn.status, afterBurn.body);
  check("burned code (5 attempts) rejects even the correct code", afterBurn.status === 400 && afterBurn.body.code === "CODE_EXPIRED", afterBurn.body);

  console.log("--- expired (but not burned) code [authLimiter hit 4/5] (expect CODE_EXPIRED) ---");
  await pool.query("UPDATE email_verification_codes SET consumed_at = NOW() WHERE user_id = $1 AND consumed_at IS NULL", [userId]);
  await pool.query(
    `INSERT INTO email_verification_codes (user_id, code_hash, expires_at) VALUES ($1, $2, NOW() - INTERVAL '1 minute')`,
    [userId, knownHash]
  );
  const expiredTry = await post("/user/verify-email", { email, code: KNOWN_CODE });
  console.log(expiredTry.status, expiredTry.body);
  check("expired code rejected with CODE_EXPIRED", expiredTry.status === 400 && expiredTry.body.code === "CODE_EXPIRED", expiredTry.body);

  console.log("--- fresh valid code [authLimiter hit 5/5] (expect success) ---");
  await pool.query("UPDATE email_verification_codes SET consumed_at = NOW() WHERE user_id = $1 AND consumed_at IS NULL", [userId]);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  await pool.query(
    `INSERT INTO email_verification_codes (user_id, code_hash, expires_at) VALUES ($1, $2, $3)`,
    [userId, knownHash, expiresAt]
  );
  const verifyOk = await post("/user/verify-email", { email, code: KNOWN_CODE });
  console.log(verifyOk.status, verifyOk.body.message, "token present:", !!verifyOk.body.token);
  check("correct code verifies and issues a token", verifyOk.status === 200 && !!verifyOk.body.token, verifyOk.body);

  const profileAfter = await pool.query("SELECT email_verified FROM profiles WHERE id = $1", [userId]);
  check("profiles.email_verified flipped to TRUE", profileAfter.rows[0]?.email_verified === true, profileAfter.rows[0]);

  console.log("--- login after verifying (loginLimiter, free budget — expect success) ---");
  const loginAfter = await post("/user/login", { email, password });
  console.log(loginAfter.status, loginAfter.body.message);
  check("verified user can log in normally", loginAfter.status === 200 && !!loginAfter.body.token, loginAfter.body);

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  await pool.end();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("SCRIPT ERROR:", err);
  await pool.end();
  process.exit(1);
});
