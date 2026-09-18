// tests/security.test.js — run via `npm test`
//
// Regression tests for the Vyas_Remediation_Plan fixes. Same harness as
// auth.test.js: integration against a REAL running server + database.
//   npm run dev        # terminal 1
//   npm test           # terminal 2
//
// Requires the seeded admin account (admin@mitwpu.edu.in / Admin@1234 —
// see database/seed.js). Each test cleans up what it creates.
//
// Every assertion here fails against the pre-fix code:
//   - job-scoping: the un-scoped UPDATE returned 204 and mutated the row
//   - session lifetime: tokens were issued with a flat 30-day expiry
//   - logout-all: the endpoint did not exist
//   - socket rule: io.use() never checked token_version

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import pool from "../database/db.js";
import { protect, verifySessionToken } from "../middlewares/authMiddleware.js";
import { generateToken, JWT_EXPIRY_MS } from "../controllers/userController.js";
import { emailQueue } from "../services/emailQueue.js";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const ADMIN_EMAIL = "admin@mitwpu.edu.in";
const ADMIN_PASSWORD = "Admin@1234";

let authCookie;
let adminId;
const createdJobIds = [];

function cookieFrom(res) {
  const c = res.headers.getSetCookie().find((x) => x.startsWith("token="));
  return c ? c.split(";")[0] : null;
}

async function login() {
  const res = await fetch(`${BASE_URL}/user/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  assert.equal(res.status, 200, "admin login must succeed for these tests to run");
  return cookieFrom(res);
}

before(async () => {
  authCookie = await login();
  adminId = (await pool.query("SELECT id FROM profiles WHERE email = $1", [ADMIN_EMAIL])).rows[0].id;
});

after(async () => {
  for (const id of createdJobIds) {
    await pool.query("DELETE FROM timetable_import_jobs WHERE id = $1", [id]);
  }
  await pool.end();
  // Importing authMiddleware/userController transitively opens the BullMQ
  // queue's Redis connection, which would otherwise hold the event loop open
  // and hang the run after the last assertion. emailQueue.close() alone isn't
  // enough: emailQueue.js passes in its own IORedis instance, and BullMQ only
  // closes connections it created itself — so quit that client explicitly.
  const client = await emailQueue.client;
  await emailQueue.close();
  await client.quit();
});

// ============================================================
// Session lifetime (Phase 1a)
// ============================================================

test("login issues a short-lived cookie, not a 30-day one", async () => {
  const res = await fetch(`${BASE_URL}/user/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  const raw = res.headers.getSetCookie().find((c) => c.startsWith("token="));
  const decoded = jwt.decode(raw.split(";")[0].slice("token=".length));

  const lifetimeMs = (decoded.exp - decoded.iat) * 1000;
  assert.equal(lifetimeMs, JWT_EXPIRY_MS);
  assert.ok(lifetimeMs <= 24 * 60 * 60 * 1000, `expected <= 24h, got ${lifetimeMs}ms`);
  assert.match(raw, /HttpOnly/i);
});

// ============================================================
// Session revocation, REST and socket (Phase 1b + 1d)
// ============================================================

test("POST /user/logout-all revokes cookies issued before it", async () => {
  const doomed = await login();

  // Still valid right now.
  let res = await fetch(`${BASE_URL}/user/me`, { headers: { Cookie: doomed } });
  assert.equal(res.status, 200);

  const revoker = await login();
  res = await fetch(`${BASE_URL}/user/logout-all`, {
    method: "POST",
    headers: { Cookie: revoker },
  });
  assert.equal(res.status, 200);

  // Every previously-issued cookie is now dead.
  for (const [label, cookie] of [["earlier session", doomed], ["revoking session", revoker]]) {
    const after = await fetch(`${BASE_URL}/user/me`, { headers: { Cookie: cookie } });
    assert.equal(after.status, 401, `${label} should be rejected after logout-all`);
  }

  authCookie = await login(); // later tests need a live session
});

test("the socket auth rule rejects a token with a stale token_version", async () => {
  // io.use() and protect share verifySessionToken, so asserting on it covers
  // the socket path without standing up a socket.io client.
  const { token_version } = (
    await pool.query("SELECT token_version FROM profiles WHERE id = $1", [adminId])
  ).rows[0];

  const good = generateToken(adminId, token_version);
  const { user } = await verifySessionToken(good);
  assert.equal(user.id, adminId);

  const stale = generateToken(adminId, token_version - 1);
  await assert.rejects(() => verifySessionToken(stale), /Session revoked/);
});

test("protect re-issues the cookie only once a session is past halfway", async () => {
  const { token_version } = (
    await pool.query("SELECT token_version FROM profiles WHERE id = $1", [adminId])
  ).rows[0];

  // Drive `protect` directly: the slide depends on the token's remaining life,
  // which would otherwise take hours of wall-clock to reach.
  async function runProtect(secondsRemaining) {
    const token = jwt.sign(
      { id: adminId, token_version },
      process.env.JWT_SECRET,
      { expiresIn: secondsRemaining }
    );
    let reissued = null;
    const req = { cookies: { token }, headers: {} };
    const res = {
      cookie: (name, value) => { reissued = { name, value }; },
      status: () => res,
      json: (b) => { throw new Error(`protect rejected: ${JSON.stringify(b)}`); },
    };
    await protect(req, res, () => {});
    return reissued;
  }

  const fresh = await runProtect(JWT_EXPIRY_MS / 1000);
  assert.equal(fresh, null, "a brand-new token must not be re-issued on every request");

  const stale = await runProtect(60); // 1 minute left — well past halfway
  assert.ok(stale, "a nearly-expired token must be re-issued");
  assert.equal(stale.name, "token");
  const newExp = jwt.decode(stale.value).exp * 1000;
  assert.ok(
    newExp - Date.now() > JWT_EXPIRY_MS * 0.9,
    "the re-issued cookie must carry a full fresh lifetime"
  );
});

// ============================================================
// Job-scoping / IDOR (Phase 2)
// ============================================================

async function createJob(label) {
  const { rows } = await pool.query(
    `INSERT INTO timetable_import_jobs (name, created_by, status)
     VALUES ($1, $2, 'CREATED') RETURNING id`,
    [label, adminId]
  );
  createdJobIds.push(rows[0].id);
  return rows[0].id;
}

test("DELETE /jobs/:jobId/lectures/:lectureId won't reject a lecture from another job", async () => {
  const jobA = await createJob(`_sectest-A-${Date.now()}`);
  const jobB = await createJob(`_sectest-B-${Date.now()}`);

  const lecture = (
    await pool.query(
      `INSERT INTO timetable_extracted_lectures (job_id, teacher_name, subject, room_number,
         weekday_number, start_time, duration_minutes, status)
       VALUES ($1, 'Dr Test', 'Subject', 'R101', 1, '10:00', 60, 'PENDING') RETURNING id`,
      [jobB]
    )
  ).rows[0].id;

  // Mismatched pair: lecture belongs to jobB, request is scoped to jobA.
  const res = await fetch(`${BASE_URL}/timetable-import/jobs/${jobA}/lectures/${lecture}`, {
    method: "DELETE",
    headers: { Cookie: authCookie },
  });
  assert.equal(res.status, 404);

  const after = await pool.query(
    "SELECT status FROM timetable_extracted_lectures WHERE id = $1",
    [lecture]
  );
  assert.equal(after.rows[0].status, "PENDING", "lecture must not have been rejected");
});

test("PATCH /jobs/:jobId/conflicts/:conflictId/resolve won't resolve another job's conflict", async () => {
  const jobA = await createJob(`_sectest-C-${Date.now()}`);
  const jobB = await createJob(`_sectest-D-${Date.now()}`);

  const conflict = (
    await pool.query(
      `INSERT INTO timetable_import_conflicts (job_id, conflict_type, severity, description)
       VALUES ($1, 'ROOM_CLASH', 'ERROR', 'test conflict') RETURNING id`,
      [jobB]
    )
  ).rows[0].id;

  const res = await fetch(
    `${BASE_URL}/timetable-import/jobs/${jobA}/conflicts/${conflict}/resolve`,
    { method: "PATCH", headers: { Cookie: authCookie } }
  );
  assert.equal(res.status, 404);

  const after = await pool.query(
    "SELECT resolved FROM timetable_import_conflicts WHERE id = $1",
    [conflict]
  );
  assert.equal(after.rows[0].resolved, false, "conflict must not have been resolved");
});
