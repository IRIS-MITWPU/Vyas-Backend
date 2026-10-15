// tests/otp-auth.test.js — run via `npm test`
//
// Email-code sign-in, sessions and step-up. Integration tests against a REAL
// running server + Postgres + Redis (see tests/auth.test.js for how to start them).
// Run the server with RUN_WORKERS=false so no real email is ever sent.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import pool from "../database/db.js";
import { verifySessionToken } from "../middlewares/authMiddleware.js";
import { revokeSession } from "../services/sessions.js";
import {
  COOKIE_NAME, http, sessionFor, seedCode, sessionCookieFrom, uniqEmail,
} from "./helpers/auth.js";

const emails = [];
const track = (e) => { emails.push(e); return e; };

// Allowlist a throwaway email (new accounts are only created for allowlisted emails).
async function allow(email, fullName = "Allowlisted Teacher") {
  await pool.query("INSERT INTO allowed_user (email, full_name) VALUES ($1, $2) ON CONFLICT DO NOTHING", [email, fullName]);
  return track(email);
}

async function makeUser(tag, { admin = false } = {}) {
  const email = track(uniqEmail(tag));
  const { rows: [u] } = await pool.query(
    "INSERT INTO profiles (full_name, email, email_verified, is_admin) VALUES ($1, $2, TRUE, $3) RETURNING id",
    [`User ${tag}`, email, admin]
  );
  return { id: u.id, email };
}

const codesFor = async (email, purpose = "login") =>
  (await pool.query("SELECT * FROM auth_codes WHERE email = $1 AND purpose = $2 ORDER BY created_at", [email, purpose])).rows;
const profileOf = async (email) => (await pool.query("SELECT * FROM profiles WHERE email = $1", [email])).rows[0];
const verify = (email, code, extra = {}) => http("POST", "/user/otp/verify", { body: { email, code, ...extra } });
const me = (cookie) => http("GET", "/user/me", { cookie });

after(async () => {
  if (emails.length) {
    await pool.query("DELETE FROM profiles WHERE email = ANY($1)", [emails]);
    await pool.query("DELETE FROM auth_codes WHERE email = ANY($1)", [emails.map((e) => e.toLowerCase())]);
    await pool.query("DELETE FROM allowed_user WHERE email = ANY($1)", [emails]);
  }
  await pool.end();
});

// ============================================================
// Requesting a code
// ============================================================

test("request: a non-@mitwpu.edu.in address is refused", async () => {
  const r = await http("POST", "/user/otp/request", { body: { email: "someone@gmail.com" } });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, "DOMAIN_NOT_ALLOWED");
});

test("request: an unknown, non-allowlisted address gets no code and no account", async () => {
  const email = track(uniqEmail("outsider"));
  const r = await http("POST", "/user/otp/request", { body: { email } });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, "NOT_ALLOWED");
  assert.equal((await codesFor(email)).length, 0);
  assert.equal(await profileOf(email), undefined);
});

test("request: new (allowlisted) and returning users get the identical response; no profile before a correct code", async () => {
  const fresh = await allow(uniqEmail("fresh"));
  const existing = (await makeUser("existing")).email;

  const a = await http("POST", "/user/otp/request", { body: { email: fresh } });
  const b = await http("POST", "/user/otp/request", { body: { email: existing } });
  assert.equal(a.status, 200);
  assert.deepEqual(a.body, b.body, "the response must not reveal which emails already have an account");
  assert.equal((await codesFor(fresh)).length, 1);
  assert.equal(await profileOf(fresh), undefined, "no account until a correct code is entered");
});

test("request: a second request inside the cooldown issues no second code", async () => {
  const email = await allow(uniqEmail("cool"));
  const a = await http("POST", "/user/otp/request", { body: { email } });
  const b = await http("POST", "/user/otp/request", { body: { email } });
  assert.deepEqual(a.body, b.body, "throttling must be invisible to the caller");
  assert.equal((await codesFor(email)).length, 1);
});

test("request: at most 5 codes per email per hour", async () => {
  const email = await allow(uniqEmail("cap"));
  for (let i = 0; i < 5; i++) {
    await pool.query(
      `INSERT INTO auth_codes (email, purpose, code_hash, expires_at, created_at)
       VALUES ($1, 'login', 'x', NOW() + INTERVAL '10 minutes', NOW() - ($2 * INTERVAL '5 minutes'))`,
      [email, i + 1]
    );
  }
  const r = await http("POST", "/user/otp/request", { body: { email } });
  assert.equal(r.status, 200);
  assert.equal((await codesFor(email)).length, 5, "the 6th request in an hour must not create a code");
});

test("request: only one code stays live; a new one supersedes the old", async () => {
  const email = await allow(uniqEmail("super"));
  await pool.query(
    `INSERT INTO auth_codes (email, purpose, code_hash, expires_at, created_at)
     VALUES ($1, 'login', 'x', NOW() + INTERVAL '10 minutes', NOW() - INTERVAL '5 minutes')`, [email]
  );
  await http("POST", "/user/otp/request", { body: { email } });
  const live = (await codesFor(email)).filter((c) => !c.consumed_at);
  assert.equal(live.length, 1);
});

// ============================================================
// Verifying a code
// ============================================================

test("verify: a correct code creates the account from the allowlist and starts a session", async () => {
  const email = await allow(uniqEmail("signup"), "Dr. Allowlist Name");
  await seedCode(email, "12345678");
  // A name typed by the visitor must not matter.
  const r = await verify(email, "12345678", { full_name: "Evil Name" });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  const p = await profileOf(email);
  assert.equal(p.full_name, "Dr. Allowlist Name");
  assert.equal(p.email_verified, true);
  assert.equal(p.is_admin, false);

  const setCookie = sessionCookieFrom(r);
  assert.ok(setCookie, "a session cookie must be set");
  assert.match(setCookie, /; HttpOnly/i);
  assert.match(setCookie, /; SameSite=Lax/i);
  assert.doesNotMatch(setCookie, /Domain=/i, "host-only cookie");
  assert.equal(r.body.token, undefined, "the session token is never in the body");

  const cookie = setCookie.split(";")[0];
  const token = cookie.slice(COOKIE_NAME.length + 1);
  const { rows } = await pool.query("SELECT token_hash FROM sessions WHERE user_id = $1", [p.id]);
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].token_hash, token, "the DB must not hold the usable token");
  assert.equal(rows[0].token_hash, createHash("sha256").update(token).digest("hex"));

  assert.equal((await me(cookie)).status, 200);
});

test("verify: the email is case-insensitive and ends up as exactly one lower-case profile", async () => {
  const email = await allow(uniqEmail("case"));
  await seedCode(email, "11112222");
  const r = await verify(email.toUpperCase(), "11112222");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const { rows } = await pool.query("SELECT email FROM profiles WHERE lower(email) = $1", [email]);
  assert.deepEqual(rows, [{ email }]);
});

test("verify: a returning user signs in; no allowlist entry needed", async () => {
  const u = await makeUser("returning");
  await seedCode(u.email, "22223333");
  const r = await verify(u.email, "22223333");
  assert.equal(r.status, 200);
  assert.equal(r.body.user.id, u.id);
});

test("verify: wrong code is rejected and counted; after 5 wrong guesses even the right code is dead", async () => {
  const u = await makeUser("burn");
  await seedCode(u.email, "33334444");
  for (let i = 0; i < 5; i++) {
    const r = await verify(u.email, "00000000");
    assert.equal(r.status, 400);
    assert.equal(r.body.code, "INVALID_CODE");
  }
  const right = await verify(u.email, "33334444");
  assert.equal(right.status, 400, "a burned code must not work even if correct");
  assert.equal(sessionCookieFrom(right), null);
});

test("verify: an expired code is rejected with the same generic error", async () => {
  const u = await makeUser("expired");
  const id = await seedCode(u.email, "44445555");
  await pool.query("UPDATE auth_codes SET expires_at = NOW() - INTERVAL '1 second' WHERE id = $1", [id]);
  const r = await verify(u.email, "44445555");
  assert.equal(r.status, 400);
  assert.equal(r.body.code, "INVALID_CODE");
});

test("verify: a code works exactly once", async () => {
  const u = await makeUser("once");
  await seedCode(u.email, "55556666");
  assert.equal((await verify(u.email, "55556666")).status, 200);
  assert.equal((await verify(u.email, "55556666")).status, 400);
});

test("verify: a code is bound to its email and its purpose", async () => {
  const a = await makeUser("bound-a");
  const b = await makeUser("bound-b");
  await seedCode(a.email, "66667777");
  assert.equal((await verify(b.email, "66667777")).status, 400, "A's code must not sign in B");

  // A step-up code is not a sign-in code (and vice versa).
  await seedCode(a.email, "77778888", "reauth");
  assert.equal((await verify(a.email, "77778888")).status, 400);
});

test("verify: malformed codes are rejected the same way", async () => {
  const u = await makeUser("malformed");
  await seedCode(u.email, "88889999");
  for (const code of ["", "1234567", "123456789", "abcdefgh", "8888 999"]) {
    assert.equal((await verify(u.email, code)).status, 400, `code ${JSON.stringify(code)}`);
  }
});

test("verify: 20 parallel correct submissions produce exactly one session", async () => {
  const u = await makeUser("race-ok");
  await seedCode(u.email, "99990000");
  const results = await Promise.all(Array.from({ length: 20 }, () => verify(u.email, "99990000")));
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM sessions WHERE user_id = $1", [u.id]);
  assert.equal(rows[0].n, 1);
});

test("verify: 20 parallel wrong guesses never evaluate more than 5", async () => {
  const u = await makeUser("race-bad");
  await seedCode(u.email, "10101010");
  await Promise.all(Array.from({ length: 20 }, (_, i) => verify(u.email, String(20000000 + i))));
  const { rows: [c] } = await pool.query("SELECT attempts FROM auth_codes WHERE email = $1", [u.email]);
  assert.ok(c.attempts <= 5, `attempts overshot: ${c.attempts}`);
});

test("verify: a code for an address that left the allowlist cannot create an account", async () => {
  const email = await allow(uniqEmail("removed"));
  await seedCode(email, "12121212");
  await pool.query("DELETE FROM allowed_user WHERE email = $1", [email]);
  const r = await verify(email, "12121212");
  assert.equal(r.status, 403);
  assert.equal(await profileOf(email), undefined);
});

test("the old password endpoints are gone (410)", async () => {
  for (const path of ["register", "login", "forgot-password", "reset-password", "verify-email", "resend-verification"]) {
    const r = await http("POST", `/user/${path}`, { body: { email: "a@mitwpu.edu.in", password: "x" } });
    assert.equal(r.status, 410, path);
  }
});

// ============================================================
// Session limits (idle / absolute / admin / not-remembered)
// ============================================================

const setAges = (sessionId, { createdAgo, seenAgo }) =>
  pool.query(
    `UPDATE sessions SET created_at = NOW() - ($2 * INTERVAL '1 hour'), last_seen_at = NOW() - ($3 * INTERVAL '1 hour') WHERE id = $1`,
    [sessionId, createdAgo, seenAgo]
  );

test("session: idle limit is 48h, and use inside it slides the window", async () => {
  const u = await makeUser("idle");
  const s = await sessionFor(u.id);

  await setAges(s.sessionId, { createdAgo: 47, seenAgo: 47 });
  const ok = await me(s.cookie);
  assert.equal(ok.status, 200, "47h idle is still inside the 48h window");
  assert.ok(sessionCookieFrom(ok), "an old-enough session renews its cookie");
  const { rows: [row] } = await pool.query("SELECT NOW() - last_seen_at < INTERVAL '1 minute' AS fresh FROM sessions WHERE id = $1", [s.sessionId]);
  assert.equal(row.fresh, true, "last_seen_at slides forward on use");

  await setAges(s.sessionId, { createdAgo: 49, seenAgo: 49 });
  assert.equal((await me(s.cookie)).status, 401, "49h idle is past the window");
});

test("session: a busy session still ends at the 14-day absolute cap", async () => {
  const u = await makeUser("abs");
  const s = await sessionFor(u.id);
  await setAges(s.sessionId, { createdAgo: 13 * 24, seenAgo: 0 });
  assert.equal((await me(s.cookie)).status, 200);
  await setAges(s.sessionId, { createdAgo: 15 * 24, seenAgo: 0 });
  assert.equal((await me(s.cookie)).status, 401, "even if used a minute ago");
});

test("session: admins get shorter limits (12h idle, 7d absolute), applied from their current role", async () => {
  const user = await makeUser("lim-user");
  const admin = await makeUser("lim-admin", { admin: true });
  const us = await sessionFor(user.id);
  const as = await sessionFor(admin.id);
  await setAges(us.sessionId, { createdAgo: 13, seenAgo: 13 });
  await setAges(as.sessionId, { createdAgo: 13, seenAgo: 13 });
  assert.equal((await me(us.cookie)).status, 200, "13h idle is fine for a teacher");
  assert.equal((await me(as.cookie)).status, 401, "13h idle is too long for an admin");

  const as2 = await sessionFor(admin.id);
  await setAges(as2.sessionId, { createdAgo: 8 * 24, seenAgo: 0 });
  assert.equal((await me(as2.cookie)).status, 401, "admin absolute cap is 7 days");

  // Promoting a teacher tightens their existing session immediately.
  const promoted = await makeUser("promote");
  const ps = await sessionFor(promoted.id);
  await setAges(ps.sessionId, { createdAgo: 13, seenAgo: 13 });
  await pool.query("UPDATE profiles SET is_admin = TRUE WHERE id = $1", [promoted.id]);
  assert.equal((await me(ps.cookie)).status, 401);
});

test("session: 'keep me signed in' off gives a browser-session cookie with an 8h idle limit", async () => {
  const email = (await makeUser("norem")).email;
  await seedCode(email, "13131313");
  const r = await verify(email, "13131313", { remember: false });
  assert.equal(r.status, 200);
  const setCookie = sessionCookieFrom(r);
  assert.doesNotMatch(setCookie, /Max-Age|Expires/i, "no persistent expiry");

  const cookie = setCookie.split(";")[0];
  const { rows: [s] } = await pool.query("SELECT s.id FROM sessions s JOIN profiles p ON p.id = s.user_id WHERE p.email = $1", [email]);
  await setAges(s.id, { createdAgo: 9, seenAgo: 9 });
  assert.equal((await me(cookie)).status, 401, "9h idle is past the 8h limit");

  // And with it on, the cookie is persistent.
  await seedCode(email, "14141414");
  const on = await verify(email, "14141414", { remember: true });
  assert.match(sessionCookieFrom(on), /Max-Age=\d+/i);
});

// ============================================================
// Logout, revocation, device list
// ============================================================

test("logout really revokes the session — a copied cookie stops working", async () => {
  const u = await makeUser("logout");
  const s = await sessionFor(u.id);
  assert.equal((await me(s.cookie)).status, 200);
  assert.equal((await http("POST", "/user/logout", { cookie: s.cookie })).status, 200);
  assert.equal((await me(s.cookie)).status, 401);
});

test("logout-all revokes every session of the user, and only theirs", async () => {
  const u = await makeUser("all");
  const other = await makeUser("all-other");
  const a = await sessionFor(u.id);
  const b = await sessionFor(u.id);
  const o = await sessionFor(other.id);
  assert.equal((await http("POST", "/user/logout-all", { cookie: a.cookie })).status, 200);
  assert.equal((await me(a.cookie)).status, 401);
  assert.equal((await me(b.cookie)).status, 401);
  assert.equal((await me(o.cookie)).status, 200, "another user's session is untouched");
});

test("device list: shows the user's own sessions, flags the current one, revokes one device", async () => {
  const u = await makeUser("devices");
  const other = await makeUser("devices-other");
  const a = await sessionFor(u.id, { userAgent: "Phone" });
  const b = await sessionFor(u.id, { userAgent: "Lab PC" });
  const o = await sessionFor(other.id);

  const list = await http("GET", "/user/sessions", { cookie: a.cookie });
  assert.equal(list.status, 200);
  assert.equal(list.body.sessions.length, 2);
  assert.deepEqual(list.body.sessions.filter((s) => s.current).map((s) => s.id), [a.sessionId]);
  assert.ok(list.body.sessions.every((s) => s.token_hash === undefined && s.token === undefined));

  assert.equal((await http("DELETE", `/user/sessions/${o.sessionId}`, { cookie: a.cookie })).status, 404, "can't revoke someone else's");
  assert.equal((await http("DELETE", `/user/sessions/not-a-uuid`, { cookie: a.cookie })).status, 404);
  assert.equal((await http("DELETE", `/user/sessions/${b.sessionId}`, { cookie: a.cookie })).status, 200);
  assert.equal((await me(b.cookie)).status, 401);
  assert.equal((await me(a.cookie)).status, 200);
  assert.equal((await me(o.cookie)).status, 200);
});

test("the socket/REST session rule rejects a revoked session", async () => {
  // io.use() and protect share verifySessionToken.
  const u = await makeUser("sock");
  const s = await sessionFor(u.id);
  const { user, session } = await verifySessionToken(s.token);
  assert.equal(user.id, u.id);
  assert.ok(session.expiresAt > Date.now());
  await revokeSession(s.sessionId);
  await assert.rejects(() => verifySessionToken(s.token), /Session not found/);
  await assert.rejects(() => verifySessionToken("not-a-real-token-at-all-xxxxxxxx"), /Session not found/);
  await assert.rejects(() => verifySessionToken("short"), /Malformed/);
});

// ============================================================
// Step-up (requireFreshAuth)
// ============================================================

test("step-up: a stale session can't change admin rights until it confirms with a fresh code", async () => {
  const admin = await makeUser("su-admin", { admin: true });
  const target = await makeUser("su-target");
  const s = await sessionFor(admin.id);
  const toggle = () => http("PATCH", `/user/${target.id}/admin`, { cookie: s.cookie });

  assert.equal((await toggle()).status, 200, "a just-signed-in session counts as fresh");
  assert.equal((await profileOf(target.email)).is_admin, true);

  await pool.query("UPDATE sessions SET reauth_at = NOW() - INTERVAL '11 minutes' WHERE id = $1", [s.sessionId]);
  let r = await toggle();
  assert.equal(r.status, 403);
  assert.equal(r.body.code, "REAUTH_REQUIRED");
  assert.equal((await profileOf(target.email)).is_admin, true, "nothing changed");

  // A wrong code doesn't help; a sign-in code isn't a step-up code.
  assert.equal((await http("POST", "/user/reauth/request", { cookie: s.cookie })).status, 200);
  await seedCode(admin.email, "15151515", "reauth");
  assert.equal((await http("POST", "/user/reauth/verify", { cookie: s.cookie, body: { code: "00000000" } })).status, 400);
  assert.equal((await toggle()).status, 403);

  assert.equal((await http("POST", "/user/reauth/verify", { cookie: s.cookie, body: { code: "15151515" } })).status, 200);
  assert.equal((await toggle()).status, 200);
  assert.equal((await profileOf(target.email)).is_admin, false);

  // Step-up is per session: another stale session of the same admin is still blocked.
  const s2 = await sessionFor(admin.id);
  await pool.query("UPDATE sessions SET reauth_at = NOW() - INTERVAL '11 minutes' WHERE id = $1", [s2.sessionId]);
  assert.equal((await http("PATCH", `/user/${target.id}/admin`, { cookie: s2.cookie })).status, 403);
});

test("step-up: guards deletes of buildings/floors/rooms and import jobs", async () => {
  const admin = await makeUser("su2-admin", { admin: true });
  const s = await sessionFor(admin.id);
  await pool.query("UPDATE sessions SET reauth_at = NOW() - INTERVAL '11 minutes' WHERE id = $1", [s.sessionId]);
  const zero = "00000000-0000-4000-8000-000000000000";
  for (const [method, path] of [
    ["DELETE", `/buildings/${zero}`],
    ["DELETE", `/buildings/floor/${zero}`],
    ["DELETE", `/buildings/room/${zero}`],
    ["POST", `/timetable-import/jobs/${zero}/approve`],
    ["DELETE", `/timetable-import/jobs/${zero}`],
  ]) {
    const r = await http(method, path, { cookie: s.cookie });
    assert.equal(r.status, 403, `${method} ${path}`);
    assert.equal(r.body.code, "REAUTH_REQUIRED");
  }
});
