// tests/auth.test.js — run via `npm test`
//
// Integration tests against a REAL running server + database (this repo has
// no isolated test-DB setup yet — see REMAINING.md). Start the server first:
//   npm run dev
// then in another terminal:
//   npm test
//
// Requires an existing seeded admin account (admin@mitwpu.edu.in / Admin@1234
// — see database/seed.js) for the login tests; the registration test creates
// and cleans up its own throwaway user.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import pool from "../database/db.js";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const ADMIN_EMAIL = "admin@mitwpu.edu.in";
const ADMIN_PASSWORD = "Admin@1234";

// Must be @mitwpu.edu.in — isAllowedDomain() rejects anything else with 403.
const testEmail = `test-${Date.now()}@mitwpu.edu.in`;
const testPassword = "TestPass123!";
let createdUserId;

after(async () => {
  if (createdUserId) {
    await pool.query("DELETE FROM profiles WHERE id = $1", [createdUserId]);
  }
  await pool.end();
});

test("POST /user/register — happy path creates an unverified user, no session", async () => {
  const res = await fetch(`${BASE_URL}/user/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      full_name: "Test User",
      email: testEmail,
      password: testPassword,
    }),
  });
  const body = await res.json();
  assert.equal(res.status, 201);
  // Registration no longer auto-logs in: it starts the OTP verify-email flow.
  // No token, no user object, and no session cookie until /user/verify-email.
  assert.equal(body.requiresVerification, true);
  assert.equal(body.email, testEmail);
  assert.equal(body.token, undefined);
  assert.equal(res.headers.getSetCookie().length, 0);

  createdUserId = (
    await pool.query("SELECT id FROM profiles WHERE email = $1", [testEmail])
  ).rows[0].id;
});

test("GET /user/me — without a token is rejected", async () => {
  const res = await fetch(`${BASE_URL}/user/me`);
  assert.equal(res.status, 401);
});

test("POST /user/login — wrong password is rejected", async () => {
  const res = await fetch(`${BASE_URL}/user/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: "definitely-wrong" }),
  });
  assert.equal(res.status, 401);
});

test("POST /user/login — correct credentials succeed", async () => {
  const res = await fetch(`${BASE_URL}/user/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  // The JWT is delivered only as an httpOnly cookie — deliberately no longer
  // echoed in the response body, where page JS could read it.
  assert.equal(body.token, undefined);
  assert.ok(res.headers.getSetCookie().some((c) => c.startsWith("token=")));
});

test("POST /booking — without a token is rejected", async () => {
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
