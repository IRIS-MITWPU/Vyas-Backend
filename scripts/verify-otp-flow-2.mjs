// scripts/verify-otp-flow-2.mjs
// Throwaway verification script for Phase 3 (OTP email verification), part 2.
// Run against a FRESH backend process (authLimiter's in-memory counter must
// be at zero) — uses 4 authLimiter-guarded calls total.
import "dotenv/config";
import pool from "../database/db.js";
import bcrypt from "bcryptjs";

const PORT = process.env.OTP_TEST_PORT || 3000;
const BASE = `http://localhost:${PORT}`;
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
  console.log("--- non-mitwpu email rejected before any OTP work [authLimiter hit 1/4] ---");
  const badDomain = await post("/user/register", { full_name: "Bad Domain", email: "someone@gmail.com", password: "TestPassword123" });
  console.log(badDomain.status, badDomain.body);
  check("non-mitwpu.edu.in email rejected at registration", badDomain.status === 403, badDomain.body);
  const noRow = await pool.query("SELECT 1 FROM profiles WHERE email = 'someone@gmail.com'");
  check("no profile row created for the rejected domain", noRow.rows.length === 0, noRow.rows);

  console.log("--- already-verified email must not leak state via verify-email [authLimiter hit 2/4] ---");
  const verifiedEmail = `otp-already-verified-${Date.now()}@mitwpu.edu.in`;
  const passwordHash = await bcrypt.hash("TestPassword123", 10);
  const profileRes = await pool.query(
    "INSERT INTO profiles (full_name, email, email_verified) VALUES ($1, $2, TRUE) RETURNING id",
    ["Already Verified", verifiedEmail]
  );
  const verifiedUserId = profileRes.rows[0].id;
  await pool.query("INSERT INTO user_auth (user_id, password_hash) VALUES ($1, $2)", [verifiedUserId, passwordHash]);

  const reVerify = await post("/user/verify-email", { email: verifiedEmail, code: "000000" });
  console.log(reVerify.status, reVerify.body);
  check(
    "already-verified email gets the same generic INVALID_CODE shape (no distinct 'already verified' leak)",
    reVerify.status === 400 && reVerify.body.code === "INVALID_CODE",
    reVerify.body
  );

  console.log("--- resend-verification cooldown [authLimiter hits 3/4 and 4/4] ---");
  const unverifiedEmail = `otp-resend-${Date.now()}@mitwpu.edu.in`;
  const reg = await post("/user/register", { full_name: "Resend Test", email: unverifiedEmail, password: "TestPassword123" });
  console.log("(setup) register status:", reg.status);

  const resend1 = await post("/user/resend-verification", { email: unverifiedEmail });
  console.log(resend1.status, resend1.body);
  const countAfterFirst = await pool.query(
    "SELECT COUNT(*) FROM email_verification_codes WHERE user_id = (SELECT id FROM profiles WHERE email = $1)",
    [unverifiedEmail]
  );
  console.log("code rows after 1st resend:", countAfterFirst.rows[0].count);

  const resend2 = await post("/user/resend-verification", { email: unverifiedEmail });
  console.log(resend2.status, resend2.body);
  const countAfterSecond = await pool.query(
    "SELECT COUNT(*) FROM email_verification_codes WHERE user_id = (SELECT id FROM profiles WHERE email = $1)",
    [unverifiedEmail]
  );
  console.log("code rows after immediate 2nd resend:", countAfterSecond.rows[0].count);
  check(
    "immediate second resend is blocked by the 60s cooldown (no new code row inserted)",
    Number(countAfterSecond.rows[0].count) === Number(countAfterFirst.rows[0].count),
    { after1: countAfterFirst.rows[0].count, after2: countAfterSecond.rows[0].count }
  );
  check(
    "resend response is identical (enumeration-safe) whether cooldown blocked it or not",
    resend1.status === 200 && resend2.status === 200 && resend1.body.message === resend2.body.message,
    { resend1: resend1.body, resend2: resend2.body }
  );

  await pool.query("DELETE FROM profiles WHERE email IN ($1, $2)", [verifiedEmail, unverifiedEmail]);

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  await pool.end();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("SCRIPT ERROR:", err);
  await pool.end();
  process.exit(1);
});
