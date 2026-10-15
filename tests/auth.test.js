// tests/auth.test.js — run via `npm test`
//
// Integration tests against a REAL running server + database + Redis (this repo
// has no isolated test-DB setup). Start the dev stack and server first:
//   docker compose -f docker-compose.dev.yml up -d
//   RUN_WORKERS=false npm run dev        # RUN_WORKERS=false: never send real email
// then in another terminal:
//   npm run test:reset && npm test
//
// Sign-in is by emailed code only. The real code exists only inside the queued
// email, so tests store a code they know (tests/helpers/auth.js) — the server has
// no bypass. More coverage of the flow itself is in otp-auth.test.js.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import pool from "../database/db.js";
import { BASE_URL, http, seedCode, sessionCookieFrom, uniqEmail } from "./helpers/auth.js";

// Must be @mitwpu.edu.in and on the staff allowlist, or no account can be created.
const testEmail = uniqEmail("auth");

after(async () => {
  await pool.query("DELETE FROM profiles WHERE email = $1", [testEmail]);
  await pool.query("DELETE FROM auth_codes WHERE email = $1", [testEmail]);
  await pool.query("DELETE FROM allowed_user WHERE email = $1", [testEmail]);
  await pool.end();
});

test("sign-up and sign-in are one flow: request a code, verify it, get a session", async () => {
  await pool.query("INSERT INTO allowed_user (email, full_name) VALUES ($1, 'Test User')", [testEmail]);

  const req = await http("POST", "/user/otp/request", { body: { email: testEmail } });
  assert.equal(req.status, 200);
  assert.equal(req.headers.getSetCookie().length, 0, "requesting a code logs nobody in");

  await seedCode(testEmail, "24681357");
  const res = await http("POST", "/user/otp/verify", { body: { email: testEmail, code: "24681357" } });
  assert.equal(res.status, 200);
  assert.equal(res.body.user.email, testEmail);
  assert.equal(res.body.token, undefined, "the session token is only ever an httpOnly cookie");

  const cookie = sessionCookieFrom(res).split(";")[0];
  const me = await http("GET", "/user/me", { cookie });
  assert.equal(me.status, 200);
  assert.equal(me.body.user.email, testEmail);
});

test("GET /user/me — without a session is rejected", async () => {
  const res = await fetch(`${BASE_URL}/user/me`);
  assert.equal(res.status, 401);
});

test("GET /user/me — a made-up session cookie is rejected", async () => {
  const res = await fetch(`${BASE_URL}/user/me`, { headers: { Cookie: "vyas_session=not-a-real-session-token-0123456789" } });
  assert.equal(res.status, 401);
});

test("POST /booking — without a session is rejected", async () => {
  const res = await fetch(`${BASE_URL}/booking`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      roomId: "00000000-0000-0000-0000-000000000000",
      title: "Should never be created",
      startTime: new Date().toISOString(),
      endTime: new Date().toISOString(),
    }),
  });
  assert.equal(res.status, 401);
});
