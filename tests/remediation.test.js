// tests/remediation.test.js — run via `npm test`
//
// Regression tests for VYAS-REMEDIATION-AND-DEPLOY-PLAN.md (security audit
// F0–F8 + hardening notes). Same harness as security.test.js: integration
// against a REAL running server + database + Redis.
//   npm run dev                          # terminal 1
//   npm run test:reset && npm test       # terminal 2
//
// Requires the seeded admin profile (admin@mitwpu.edu.in); sessions are minted
// directly (tests/helpers/auth.js) — there is no password to log in with.
// Each test cleans up what it creates.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import pool from "../database/db.js";
import { encryptOtp, decryptOtp, hashCode } from "../utils/otpCrypto.js";
import { createHash, createDecipheriv } from "node:crypto";
import IORedis from "ioredis";
import { findOrCreateGoogleUser, NotAllowedUserError } from "../models/oauthModel.js";
import { sessionFor } from "./helpers/auth.js";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const ADMIN_EMAIL = "admin@mitwpu.edu.in";

let adminId;
const createdEmails = []; // profiles to delete after the run (cascades to auth/OTP/tokens)
const allowedEmails = []; // allowed_user rows this run inserted

before(async () => {
  adminId = (await pool.query("SELECT id FROM profiles WHERE email = $1", [ADMIN_EMAIL])).rows[0].id;
});

after(async () => {
  if (createdEmails.length) {
    await pool.query("DELETE FROM profiles WHERE email = ANY($1)", [createdEmails]);
  }
  if (allowedEmails.length) {
    await pool.query("DELETE FROM allowed_user WHERE email = ANY($1)", [allowedEmails]);
  }
  await pool.end();
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
// Helpers
// ============================================================

const uniq = (tag) => `rem-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@mitwpu.edu.in`;

// New accounts are gated by the staff allowlist, so throwaway emails must be on it.
// Only rows this run actually inserted are cleaned up.
async function allow(email) {
  const { rowCount } = await pool.query(
    "INSERT INTO allowed_user (email, full_name) VALUES ($1, 'Test') ON CONFLICT DO NOTHING",
    [email]
  );
  if (rowCount) allowedEmails.push(email);
  return email;
}

const profileOf = async (email) =>
  (await pool.query("SELECT * FROM profiles WHERE email = $1", [email])).rows[0];

// ============================================================
// Staff allowlist (allowed_user) — gates NEW accounts only
// ============================================================

test("allowlist: Google sign-in creates only allowlisted accounts, but links existing ones regardless", async () => {
  const gid = () => `test-google-${Date.now()}-${Math.random()}`;

  const outsider = uniq("g-not-allowed");
  await assert.rejects(
    () => findOrCreateGoogleUser({ googleId: gid(), email: outsider, fullName: "Outsider" }),
    NotAllowedUserError
  );
  assert.equal(await profileOf(outsider), undefined);

  const insider = await allow(uniq("g-allowed"));
  createdEmails.push(insider);
  const created = await findOrCreateGoogleUser({ googleId: gid(), email: insider, fullName: "Insider" });
  assert.equal(created.email, insider);

  const u = await makeVerifiedUser("Existing Unlisted");
  const linked = await findOrCreateGoogleUser({ googleId: gid(), email: u.email, fullName: "Whatever" });
  assert.equal(linked.id, u.id);
});

// ============================================================
// Session helpers for HTTP tests — mint cookies directly instead of logging
// in (there is no password, and codes only exist inside the emailed message).
// ============================================================

async function makeVerifiedUser(fullName, { admin = false } = {}) {
  const email = uniq("user");
  createdEmails.push(email);
  const { rows: [u] } = await pool.query(
    `INSERT INTO profiles (full_name, email, email_verified, is_admin)
     VALUES ($1, $2, TRUE, $3) RETURNING id`,
    [fullName, email, admin]
  );
  const s = await sessionFor(u.id);
  return { id: u.id, email, cookie: s.cookie, token: s.token };
}

async function adminCookie() {
  return (await sessionFor(adminId)).cookie;
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
// 2.3 [F8] — code-request abuse (per-email limit, not just per IP)
// ============================================================

test("2.3 F8: POST /user/otp/request is limited per email, not just per IP", async () => {
  const email = uniq("f8-http"); // valid domain but not allowlisted: no code is ever sent
  const statuses = [];
  for (let i = 0; i < 6; i++) {
    statuses.push((await http("POST", "/user/otp/request", null, { email })).status);
  }
  assert.deepEqual(statuses, [403, 403, 403, 403, 403, 429]);
});

test("2.3: the per-email limiter heals a counter key that lost its TTL", async () => {
  const redis = new IORedis(process.env.REDIS_URL);
  try {
    const email = uniq("ttl");
    const key = `rl:otp-email:${email}`;
    await redis.set(key, "1"); // what a failed PEXPIRE used to leave behind: a counter that never expires
    assert.equal((await http("POST", "/user/otp/request", null, { email })).status, 403);
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

test("2.4: PATCH /user/me full_name is trimmed, 1–100 chars, no control characters", async () => {
  const u = await makeVerifiedUser("Valid Name");
  for (const bad of ["   ", "x".repeat(101), "Dr.\u0000Target", "Line\nBreak", "Tab\tName"]) {
    const r = await http("PATCH", "/user/me", u.cookie, { full_name: bad });
    assert.equal(r.status, 400, `PATCH must reject ${JSON.stringify(bad)}`);
  }
  let r = await http("PATCH", "/user/me", u.cookie, { full_name: "  Dr. Spaced  " });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.full_name, "Dr. Spaced");
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
  assert.equal((await patch({ Authorization: `Bearer ${u.token}` })).status, 200);
  // Reads are not affected.
  assert.equal((await fetch(`${BASE_URL}/user/me`, { headers: { Cookie: u.cookie } })).status, 200);
});

test("2.5: production drops the localhost origins (Express + Socket.IO) and sets strict session-cookie flags", async () => {
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

    // Sign in through the real endpoint in production mode (the code is seeded: the
    // real one only exists in the email) and check the cookie the browser would store.
    const { rows: [admin] } = await pool.query("SELECT email FROM profiles WHERE email = $1", [ADMIN_EMAIL]);
    await pool.query(
      "UPDATE auth_codes SET consumed_at = NOW() WHERE email = $1 AND purpose = 'login' AND consumed_at IS NULL",
      [admin.email]
    );
    await pool.query(
      `INSERT INTO auth_codes (email, purpose, code_hash, expires_at)
       VALUES ($1, 'login', $2, NOW() + INTERVAL '10 minutes')`,
      [admin.email, hashCode(admin.email, "login", "16161616")]
    );
    res = await fetch(`${prodUrl}/user/otp/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: frontend },
      body: JSON.stringify({ email: admin.email, code: "16161616" }),
    });
    assert.equal(res.status, 200);
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith("__Host-vyas_session="));
    assert.ok(cookie, "production must use the __Host- prefixed cookie name");
    assert.match(cookie, /; HttpOnly/i);
    assert.match(cookie, /; Secure/i);
    assert.match(cookie, /; SameSite=Lax/i);
    assert.match(cookie, /; Path=\//i);
    assert.doesNotMatch(cookie, /Domain=/i, "cookie must be host-only");
  } finally {
    child.kill();
  }
});

// ============================================================
// 2.6 — data hygiene
// ============================================================

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
