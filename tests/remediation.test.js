// tests/remediation.test.js — run via `npm test`
//
// Regression tests for VYAS-REMEDIATION-AND-DEPLOY-PLAN.md (security audit
// F0–F8 + hardening notes). Same harness as security.test.js: integration
// against a REAL running server + database + Redis.
//   npm run dev                          # terminal 1
//   npm run test:reset && npm test       # terminal 2
//
// Requires the seeded admin account (admin@mitwpu.edu.in / Admin@1234).
// Each test cleans up what it creates.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { spawn, spawnSync } from "node:child_process";
import pool from "../database/db.js";
import bcrypt from "bcryptjs";
import { verifySessionToken } from "../middlewares/authMiddleware.js";
import { register, login, verifyEmail, forgotPassword, resetPassword, generateToken } from "../controllers/userController.js";
import { encryptOtp, decryptOtp } from "../utils/otpCrypto.js";
import { createHash, createDecipheriv } from "node:crypto";
import IORedis from "ioredis";
import { emailQueue } from "../services/emailQueue.js";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const ADMIN_EMAIL = "admin@mitwpu.edu.in";

let adminId;
const createdEmails = []; // profiles to delete after the run (cascades to auth/OTP/tokens)

before(async () => {
  adminId = (await pool.query("SELECT id FROM profiles WHERE email = $1", [ADMIN_EMAIL])).rows[0].id;
});

after(async () => {
  if (createdEmails.length) {
    await pool.query("DELETE FROM profiles WHERE email = ANY($1)", [createdEmails]);
  }
  await pool.end();
  const client = await emailQueue.client;
  await emailQueue.close();
  await client.quit();
});

// ============================================================
// 1.2 — JWT algorithm pinning
// ============================================================

test("1.2: a session token signed with a non-HS256 algorithm is rejected", async () => {
  const { token_version } = (
    await pool.query("SELECT token_version FROM profiles WHERE id = $1", [adminId])
  ).rows[0];

  const hs384 = jwt.sign({ id: adminId, token_version }, process.env.JWT_SECRET, {
    algorithm: "HS384",
    expiresIn: 600,
  });
  await assert.rejects(() => verifySessionToken(hs384), /invalid algorithm/);

  const res = await fetch(`${BASE_URL}/user/me`, { headers: { Cookie: `token=${hs384}` } });
  assert.equal(res.status, 401);
});

// ============================================================
// 1.5 — SMTP_FROM is required (no hardcoded personal fallback)
// ============================================================

test("1.5: the app refuses to start without SMTP_FROM", () => {
  // An empty value counts as missing, and dotenv won't overwrite a set var.
  const r = spawnSync(process.execPath, ["app.js"], {
    env: { ...process.env, SMTP_FROM: "", PORT: "0" },
    encoding: "utf8",
    timeout: 20000,
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Missing required environment variables:.*SMTP_FROM/);
});

// ============================================================
// Controller-level harness. register/forgot/reset share a 5/hour per-IP
// bucket and the OTP routes a 5/hour per-email one, so tests that aren't
// about the limiters call the controllers directly (same approach the
// security suite uses for `protect`).
// ============================================================

async function call(handler, body) {
  const out = { status: 200, body: undefined, cookies: {} };
  const res = {
    status(code) { out.status = code; return res; },
    json(b) { out.body = b; return res; },
    cookie(name, value) { out.cookies[name] = value; return res; },
  };
  await handler({ body }, res);
  return out;
}

const uniq = (tag) => `rem-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@mitwpu.edu.in`;

// Replace the hash of the user's current OTP with a known code — the real
// code only exists encrypted inside the queued email job.
async function setOtp(email, code) {
  const { rows } = await pool.query(
    `UPDATE email_verification_codes SET code_hash = $2
     WHERE id = (SELECT c.id FROM email_verification_codes c JOIN profiles p ON p.id = c.user_id
                 WHERE p.email = $1 AND c.consumed_at IS NULL ORDER BY c.created_at DESC LIMIT 1)
     RETURNING id`,
    [email, await bcrypt.hash(code, 4)]
  );
  assert.equal(rows.length, 1, `no pending OTP row for ${email}`);
  return rows[0].id;
}

const profileOf = async (email) =>
  (await pool.query("SELECT * FROM profiles WHERE email = $1", [email])).rows[0];

// ============================================================
// 2.1 [F0] — account pre-hijacking
// ============================================================

test("2.1 F0: verifying with the OTP alone, or with a password that isn't the account's, fails", async () => {
  const email = uniq("f0a");
  createdEmails.push(email);
  let r = await call(register, { full_name: "Attacker", email, password: "AttackerPass1!" });
  assert.equal(r.status, 201);
  await setOtp(email, "123456");

  // The mailbox owner has the code but not the attacker's password.
  r = await call(verifyEmail, { email, code: "123456" });
  assert.equal(r.status, 400);
  r = await call(verifyEmail, { email, code: "123456", password: "VictimPass1!" });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, "INVALID_CODE", "wrong password must look exactly like a wrong code");
  assert.equal(r.cookies.token, undefined);

  const p = await profileOf(email);
  assert.equal(p.email_verified, false);
  const { rows: [otp] } = await pool.query(
    "SELECT attempts FROM email_verification_codes WHERE user_id = $1 AND consumed_at IS NULL", [p.id]
  );
  assert.equal(otp.attempts, 1, "a wrong-password verify counts as a failed attempt");
});

test("2.1 F0: re-registering a pending email replaces the credential and kills old OTPs", async () => {
  const email = uniq("f0c");
  createdEmails.push(email);
  assert.equal((await call(register, { full_name: "Attacker", email, password: "AttackerPass1!" })).status, 201);
  const attackerOtpId = await setOtp(email, "111111");
  const versionBefore = (await profileOf(email)).token_version;

  const r = await call(register, { full_name: "Real Owner", email, password: "OwnerPass1!" });
  assert.equal(r.status, 201, "a pending (unverified) registration must be replaceable");

  const { rowCount } = await pool.query("SELECT 1 FROM email_verification_codes WHERE id = $1", [attackerOtpId]);
  assert.equal(rowCount, 0, "the attacker-era OTP must be gone");
  assert.equal((await call(login, { email, password: "AttackerPass1!" })).status, 401);

  await setOtp(email, "222222");
  const v = await call(verifyEmail, { email, code: "222222", password: "OwnerPass1!" });
  assert.equal(v.status, 200);
  assert.ok(v.cookies.token);
  const p = await profileOf(email);
  assert.equal(p.email_verified, true);
  assert.equal(p.full_name, "Real Owner");
  assert.ok(p.token_version > versionBefore, "verify must bump token_version");
  assert.equal((await call(login, { email, password: "OwnerPass1!" })).status, 200);
});

test("2.1 F0: re-registering a verified email still fails and changes nothing", async () => {
  const before = (await pool.query(
    "SELECT a.password_hash, p.full_name FROM profiles p JOIN user_auth a ON a.user_id = p.id WHERE p.email = $1",
    [ADMIN_EMAIL]
  )).rows[0];
  const r = await call(register, { full_name: "Hijacker", email: ADMIN_EMAIL, password: "Whatever123!" });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /Registration failed/);
  const afterRow = (await pool.query(
    "SELECT a.password_hash, p.full_name FROM profiles p JOIN user_auth a ON a.user_id = p.id WHERE p.email = $1",
    [ADMIN_EMAIL]
  )).rows[0];
  assert.deepEqual(afterRow, before);
});

test("2.1: 20 concurrent wrong OTP guesses — at most 5 are ever evaluated", async () => {
  const email = uniq("otp-race");
  createdEmails.push(email);
  assert.equal((await call(register, { full_name: "Racer", email, password: "RacerPass1!" })).status, 201);
  await setOtp(email, "999999");

  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      call(verifyEmail, { email, code: String(100000 + i), password: "RacerPass1!" })
    )
  );
  const evaluated = results.filter((r) => r.body?.code === "INVALID_CODE").length;
  assert.ok(evaluated <= 5, `expected <= 5 evaluated guesses, got ${evaluated}`);
  const { rows: [otp] } = await pool.query(
    `SELECT c.attempts FROM email_verification_codes c JOIN profiles p ON p.id = c.user_id
     WHERE p.email = $1 AND c.consumed_at IS NULL`, [email]
  );
  assert.ok(otp.attempts <= 5, `attempts column overshot: ${otp.attempts}`);
});

// ============================================================
// Session helpers for HTTP tests — mint cookies directly instead of logging
// in (the login limiter is 10/15 min per IP and the other suites use it).
// ============================================================

async function makeVerifiedUser(fullName, { admin = false } = {}) {
  const email = uniq("user");
  createdEmails.push(email);
  const { rows: [u] } = await pool.query(
    `INSERT INTO profiles (full_name, email, email_verified, is_admin)
     VALUES ($1, $2, TRUE, $3) RETURNING id, token_version`,
    [fullName, email, admin]
  );
  await pool.query("INSERT INTO user_auth (user_id, password_hash) VALUES ($1, $2)", [
    u.id, await bcrypt.hash("UserPass123!", 4),
  ]);
  return { id: u.id, email, cookie: `token=${generateToken(u.id, u.token_version)}` };
}

async function adminCookie() {
  const { token_version } = (
    await pool.query("SELECT token_version FROM profiles WHERE id = $1", [adminId])
  ).rows[0];
  return `token=${generateToken(adminId, token_version)}`;
}

async function http(method, path, cookie, body) {
  // Origin: BASE_URL = a same-origin client, which the CSRF check allows.
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Origin: BASE_URL, ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}

// ============================================================
// 2.2 [F4] — timetable cancellation authorized by name matching
// ============================================================

test("2.2 F4: renaming yourself to a template's teacher_name does not grant cancel rights", async () => {
  const { rows: [room] } = await pool.query("SELECT id FROM rooms LIMIT 1");
  const { rows: [tmpl] } = await pool.query(
    `INSERT INTO room_timetable_templates (room_id, teacher_name, title, weekday, start_time, duration_minutes)
     VALUES ($1, 'Dr. Target Teacher', 'F4 test lecture', 0, '10:00', 60) RETURNING id`,
    [room.id]
  );
  try {
    const mallory = await makeVerifiedUser("Mallory");
    let r = await http("PATCH", "/user/me", mallory.cookie, { full_name: "dr. target teacher" });
    assert.equal(r.status, 200);

    r = await http("POST", `/timetable/${tmpl.id}/exception`, mallory.cookie, { weekStartDate: "2030-01-07" });
    assert.equal(r.status, 403, "a name match alone must not authorize a cancellation");

    // Admin links the real teacher by immutable profile id → that teacher may cancel.
    const teacher = await makeVerifiedUser("Dr. Target Teacher");
    const admin = await adminCookie();
    r = await http("PUT", `/timetable/${tmpl.id}`, admin, { teacherProfileId: teacher.id });
    assert.equal(r.status, 200);
    assert.equal(r.body.template.teacher_profile_id, teacher.id);

    r = await http("POST", `/timetable/${tmpl.id}/exception`, teacher.cookie, { weekStartDate: "2030-01-14" });
    assert.equal(r.status, 201, "the linked teacher can cancel their own slot");
    r = await http("POST", `/timetable/${tmpl.id}/exception`, mallory.cookie, { weekStartDate: "2030-01-21" });
    assert.equal(r.status, 403);
    r = await http("POST", `/timetable/${tmpl.id}/exception`, admin, { weekStartDate: "2030-01-28" });
    assert.equal(r.status, 201, "admins can still cancel");

    r = await http("PUT", `/timetable/${tmpl.id}`, admin, { teacherProfileId: "00000000-0000-4000-8000-000000000000" });
    assert.equal(r.status, 400, "teacherProfileId must be a real profile");
  } finally {
    await pool.query("DELETE FROM room_timetable_templates WHERE id = $1", [tmpl.id]);
  }
});

// ============================================================
// 2.3 [F8] — forgot-password abuse (per-email limit + DB cooldown)
// ============================================================

async function resetJobsFor(email) {
  const jobs = await emailQueue.getJobs(["waiting", "delayed", "active", "failed", "completed", "paused"]);
  return jobs.filter((j) => j?.name === "password-reset" && j.data?.to === email).length;
}

test("2.3 F8: a second forgot-password inside the cooldown re-issues nothing", async () => {
  const u = await makeVerifiedUser("Reset Target");
  let r = await call(forgotPassword, { email: u.email });
  assert.equal(r.status, 200);
  const first = (await pool.query("SELECT id, created_at FROM password_reset_tokens WHERE user_id = $1", [u.id])).rows;
  assert.equal(first.length, 1);
  const jobsAfterFirst = await resetJobsFor(u.email);
  assert.equal(jobsAfterFirst, 1);

  r = await call(forgotPassword, { email: u.email });
  assert.equal(r.status, 200);
  assert.match(r.body.message, /If that email is registered/, "same generic response");
  const second = (await pool.query("SELECT id, created_at FROM password_reset_tokens WHERE user_id = $1", [u.id])).rows;
  assert.deepEqual(second, first, "the in-flight reset link must stay valid (not deleted/re-issued)");
  assert.equal(await resetJobsFor(u.email), jobsAfterFirst, "no second email enqueued");
});

test("2.3 F8: POST /user/forgot-password is limited per email, not just per IP", async () => {
  const email = uniq("f8-http"); // needn't exist — the limiter must not reveal that
  const statuses = [];
  for (let i = 0; i < 4; i++) {
    statuses.push((await http("POST", "/user/forgot-password", null, { email })).status);
  }
  assert.deepEqual(statuses, [200, 200, 200, 429]);
});

test("2.3: the per-email limiter heals a counter key that lost its TTL", async () => {
  const redis = new IORedis(process.env.REDIS_URL);
  try {
    const email = uniq("ttl");
    const key = `rl:otp-email:${email}`; // perEmailLimiter on /resend-verification (own per-IP bucket)
    await redis.set(key, "1"); // what a failed PEXPIRE used to leave behind: a counter that never expires
    assert.equal((await http("POST", "/user/resend-verification", null, { email })).status, 200);
    const ttl = await redis.pttl(key);
    assert.ok(ttl > 0, `key must have a TTL again, got ${ttl}`);
    await redis.del(key);
  } finally {
    redis.disconnect();
  }
});

// ============================================================
// 2.4 — full_name validation (register + PATCH /user/me)
// ============================================================

test("2.4: full_name is trimmed, 1–100 chars, no control characters", async () => {
  const u = await makeVerifiedUser("Valid Name");
  for (const bad of ["   ", "x".repeat(101), "Dr.\u0000Target", "Line\nBreak", "Tab\tName"]) {
    const r = await http("PATCH", "/user/me", u.cookie, { full_name: bad });
    assert.equal(r.status, 400, `PATCH must reject ${JSON.stringify(bad)}`);
  }
  let r = await http("PATCH", "/user/me", u.cookie, { full_name: "  Dr. Spaced  " });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.full_name, "Dr. Spaced");

  r = await call(register, { full_name: "Evil\u0007Bell", email: uniq("f24"), password: "GoodPass123!" });
  assert.equal(r.status, 400);
  const email = uniq("f24ok");
  createdEmails.push(email);
  r = await call(register, { full_name: "  Padded Name ", email, password: "GoodPass123!" });
  assert.equal(r.status, 201);
  assert.equal((await profileOf(email)).full_name, "Padded Name");
});

// ============================================================
// 2.5 — CSRF defense-in-depth + production CORS
// ============================================================

test("2.5: state-changing requests need an allowed Origin when a session cookie is sent", async () => {
  const u = await makeVerifiedUser("Csrf Probe");
  const patch = (headers) =>
    fetch(`${BASE_URL}/user/me`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ department: "CSRF" }),
    });

  assert.equal((await patch({ Cookie: u.cookie })).status, 403, "cookie + no Origin");
  assert.equal((await patch({ Cookie: u.cookie, Origin: "https://evil.iris-club.in" })).status, 403);
  assert.equal((await patch({ Cookie: u.cookie, Origin: "http://localhost:5173" })).status, 200, "dev frontend origin");
  assert.equal((await patch({ Cookie: u.cookie, Origin: BASE_URL })).status, 200, "the API's own origin");
  // Non-browser clients authenticate with a Bearer header, which a cross-site
  // page can't attach — no Origin needed.
  const bearer = u.cookie.slice("token=".length);
  assert.equal((await patch({ Authorization: `Bearer ${bearer}` })).status, 200);
  // Reads are not affected.
  assert.equal((await fetch(`${BASE_URL}/user/me`, { headers: { Cookie: u.cookie } })).status, 200);
});

test("2.5: production drops the localhost origins (Express + Socket.IO) and sets strict cookie flags", async () => {
  const PORT = 3099;
  const prodUrl = `http://localhost:${PORT}`;
  const frontend = "https://vyas.iris-club.in";
  const child = spawn(process.execPath, ["app.js"], {
    env: { ...process.env, NODE_ENV: "production", PORT: String(PORT), FRONTEND_ORIGIN: frontend },
    stdio: "ignore",
  });
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      await new Promise((r) => setTimeout(r, 500));
      up = await fetch(`${prodUrl}/health`).then((r) => r.ok, () => false);
    }
    assert.ok(up, "production-mode server did not start");

    let res;
    for (const local of ["http://localhost:5173", "http://localhost:8080"]) {
      res = await fetch(`${prodUrl}/`, { headers: { Origin: local } });
      assert.notEqual(res.headers.get("access-control-allow-origin"), local);
      res = await fetch(`${prodUrl}/user/logout`, { method: "POST", headers: { Origin: local } });
      assert.equal(res.status, 403);
      res = await fetch(`${prodUrl}/socket.io/?EIO=4&transport=polling`, { headers: { Origin: local } });
      assert.notEqual(res.headers.get("access-control-allow-origin"), local);
    }
    res = await fetch(`${prodUrl}/socket.io/?EIO=4&transport=polling`, { headers: { Origin: frontend } });
    assert.equal(res.headers.get("access-control-allow-origin"), frontend);

    res = await fetch(`${prodUrl}/user/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: frontend },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: "Admin@1234" }),
    });
    assert.equal(res.status, 200);
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith("token="));
    assert.match(cookie, /; HttpOnly/i);
    assert.match(cookie, /; Secure/i);
    assert.match(cookie, /; SameSite=Lax/i);
    assert.doesNotMatch(cookie, /Domain=/i, "cookie must be host-only");
  } finally {
    child.kill();
  }
});

// ============================================================
// 2.6 — queue and token data hygiene
// ============================================================

async function latestResetJob(email) {
  const jobs = await emailQueue.getJobs(["waiting", "delayed", "active", "failed", "completed", "paused"]);
  return jobs.filter((j) => j?.name === "password-reset" && j.data?.to === email)
    .sort((a, b) => b.timestamp - a.timestamp)[0];
}

test("2.6a: email jobs (which carry reset URLs) are kept at most 1 hour", async () => {
  const u = await makeVerifiedUser("Retention Probe");
  await call(forgotPassword, { email: u.email });
  const job = await latestResetJob(u.email);
  assert.ok(job, "reset email job not found");
  for (const opt of ["removeOnComplete", "removeOnFail"]) {
    const keep = job.opts[opt];
    assert.ok(keep && typeof keep === "object", `${opt} must be an {age,count} policy`);
    assert.ok(keep.age > 0 && keep.age <= 3600, `${opt}.age must be <= 1h, got ${keep.age}`);
  }
});

test("2.6b: reset tokens are stored hashed; only the emailed plaintext works", async () => {
  const u = await makeVerifiedUser("Hash Probe");
  await call(forgotPassword, { email: u.email });
  const plaintext = new URL((await latestResetJob(u.email)).data.resetUrl).searchParams.get("token");
  const { rows: [row] } = await pool.query("SELECT * FROM password_reset_tokens WHERE user_id = $1", [u.id]);
  const stored = row.token_hash ?? row.token;
  assert.notEqual(stored, plaintext, "the DB must not hold the usable token");
  assert.equal(stored, createHash("sha256").update(plaintext).digest("hex"));

  let r = await call(resetPassword, { token: stored, password: "NewPassword123!" });
  assert.equal(r.status, 400, "a leaked DB value must not work as a reset token");
  r = await call(resetPassword, { token: plaintext, password: "NewPassword123!" });
  assert.equal(r.status, 200);
  assert.equal((await call(login, { email: u.email, password: "NewPassword123!" })).status, 200);
});

test("2.6c: the OTP encryption key is not the SHA-256 of JWT_SECRET", () => {
  const blob = Buffer.from(encryptOtp("123456"), "base64");
  const legacyKey = createHash("sha256").update(process.env.JWT_SECRET).digest();
  const d = createDecipheriv("aes-256-gcm", legacyKey, blob.subarray(0, 12));
  d.setAuthTag(blob.subarray(12, 28));
  assert.throws(() => Buffer.concat([d.update(blob.subarray(28)), d.final()]), "JWT-derived key must not decrypt OTPs");
  assert.equal(decryptOtp(encryptOtp("654321")), "654321");
});

// ============================================================
// Phase 3 — booking integrity. Uses its own building/rooms so it can't
// collide with the concurrency suite running in parallel.
// ============================================================

// `hh:mm` IST on the weekday `daysAhead` days out (skipping weekends), as ISO.
function istAt(daysAhead, hh, mm = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1);
  const ymd = d.toISOString().slice(0, 10);
  return new Date(`${ymd}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+05:30`).toISOString();
}
const nextDay = (iso) => new Date(new Date(iso).getTime() + 24 * 3600 * 1000).toISOString();

async function makeRooms() {
  const { rows: [b] } = await pool.query(
    "INSERT INTO buildings (name) VALUES ($1) RETURNING id", [`_rem-bldg-${Date.now()}-${Math.random()}`]
  );
  const { rows: [f] } = await pool.query(
    "INSERT INTO floors (building_id, floor_number) VALUES ($1, 1) RETURNING id", [b.id]
  );
  const room = async (name, requiresApproval) => (await pool.query(
    `INSERT INTO rooms (name, floor_id, room_type, requires_approval) VALUES ($1, $2, 'classroom', $3) RETURNING id`,
    [name, f.id, requiresApproval]
  )).rows[0].id;
  return { buildingId: b.id, open: await room("R-open", false), approval: await room("R-approval", true) };
}

test("3.1 F2: bookings must start and end on the same IST day (POST and PATCH)", async () => {
  const rooms = await makeRooms();
  try {
    const u = await makeVerifiedUser("Booker F2");
    const post = (startTime, endTime) =>
      http("POST", "/booking", u.cookie, { roomId: rooms.open, title: "F2", startTime, endTime });

    // Year-long squat (the audit's repro shape) — rejected by zod.
    let r = await post(istAt(20, 9), new Date(new Date(istAt(20, 10)).getTime() + 364 * 86400000).toISOString());
    assert.equal(r.status, 400);
    // 21:00 → 08:00 next day: only 11 h, so it passes the duration refine —
    // the DB trigger must still reject it.
    r = await post(istAt(21, 21), nextDay(istAt(21, 8)));
    assert.ok(r.status >= 400, `overnight booking must be rejected, got ${r.status}`);

    r = await post(istAt(22, 9), istAt(22, 10));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const id = r.body.booking.id;

    r = await http("PATCH", `/booking/${id}`, u.cookie, { end_time: nextDay(istAt(22, 10)) });
    assert.ok(r.status >= 400, `multi-day PATCH must be rejected, got ${r.status}`);

    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM bookings WHERE room_id = $1
       AND (start_time AT TIME ZONE 'Asia/Kolkata')::date <> (end_time AT TIME ZONE 'Asia/Kolkata')::date`,
      [rooms.open]
    );
    assert.equal(rows[0].n, 0, "no multi-day booking may be stored");
  } finally {
    await pool.query("DELETE FROM buildings WHERE id = $1", [rooms.buildingId]);
  }
});

test("3.2 F3: an owner's time edit of an approved booking goes back to pending", async () => {
  const rooms = await makeRooms();
  try {
    const owner = await makeVerifiedUser("Owner F3");
    const other = await makeVerifiedUser("Other F3");
    const admin = await adminCookie();

    let r = await http("POST", "/booking", owner.cookie, {
      roomId: rooms.approval, title: "F3", startTime: istAt(23, 9), endTime: istAt(23, 10),
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.booking.status, "pending");
    const id = r.body.booking.id;

    r = await http("PATCH", `/booking/${id}`, admin, { status: "confirmed" });
    assert.equal(r.body.booking.status, "confirmed");
    assert.ok(r.body.booking.approved_by);

    // Admin time-only edit keeps the approval.
    r = await http("PATCH", `/booking/${id}`, admin, { end_time: istAt(23, 10, 30) });
    assert.equal(r.status, 200);
    assert.equal(r.body.booking.status, "confirmed");

    // Non-owner: no rows updated.
    r = await http("PATCH", `/booking/${id}`, other.cookie, { start_time: istAt(23, 11), end_time: istAt(23, 12) });
    assert.equal(r.status, 404);

    // Owner moves it to a slot the admin never approved → needs re-approval.
    r = await http("PATCH", `/booking/${id}`, owner.cookie, { start_time: istAt(23, 14), end_time: istAt(23, 15) });
    assert.equal(r.status, 200);
    assert.equal(r.body.booking.status, "pending");
    assert.equal(r.body.booking.approved_by, null);
    assert.equal(r.body.booking.approved_at, null);

    // A no-approval room stays confirmed after an owner time edit.
    r = await http("POST", "/booking", owner.cookie, {
      roomId: rooms.open, title: "F3-open", startTime: istAt(23, 9), endTime: istAt(23, 10),
    });
    assert.equal(r.body.booking.status, "confirmed");
    r = await http("PATCH", `/booking/${r.body.booking.id}`, owner.cookie, { start_time: istAt(23, 11), end_time: istAt(23, 12) });
    assert.equal(r.body.booking.status, "confirmed");
  } finally {
    await pool.query("DELETE FROM buildings WHERE id = $1", [rooms.buildingId]);
  }
});

test("3.2: approve racing an owner's cancel never resurrects a cancelled booking", async () => {
  const rooms = await makeRooms();
  try {
    const owner = await makeVerifiedUser("Racer F3");
    const admin = await adminCookie();
    for (let i = 0; i < 12; i++) {
      const hour = 8 + i;
      let r = await http("POST", "/booking", owner.cookie, {
        roomId: rooms.approval, title: `race-${i}`, startTime: istAt(24, hour), endTime: istAt(24, hour, 30),
      });
      assert.equal(r.status, 201);
      const id = r.body.booking.id;
      const [cancel, approve] = await Promise.all([
        http("DELETE", `/booking/${id}`, owner.cookie),
        http("PATCH", `/booking/${id}`, admin, { status: "confirmed" }),
      ]);
      const { rows: [b] } = await pool.query("SELECT status FROM bookings WHERE id = $1", [id]);
      if (cancel.status === 200) {
        assert.equal(b.status, "cancelled", `iteration ${i}: owner's cancel succeeded but final status is ${b.status}`);
      }
      assert.ok([200, 409].includes(approve.status), `approve returned ${approve.status}`);
    }
  } finally {
    await pool.query("DELETE FROM buildings WHERE id = $1", [rooms.buildingId]);
  }
});
