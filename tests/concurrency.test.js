// tests/concurrency.test.js — run via `npm test`
//
// Integration test against a REAL running server + database (same
// requirements as tests/auth.test.js — start `npm run dev` first).
//
// Verifies the core booking-safety property documented in CLAUDE.md's
// "Booking Concurrency" section: two simultaneous bookings for the same
// room+slot can never both succeed. Unlike the older tests/concurrency.js,
// this does NOT assert a specific [201, 409] status pair — per BEFORE_DEP.md
// §3.1, the BEFORE trigger usually raises a 500 before the exclusion
// constraint's 23P01 ever fires; only under genuine request-level race
// timing does the clean 409 path get hit. Either way, exactly one booking
// must end up active in the database — that's the property that actually
// matters, so that's what this test asserts directly against the DB.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pool from "../database/db.js";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const ADMIN_EMAIL = "admin@mitwpu.edu.in";
const ADMIN_PASSWORD = "Admin@1234";

let token;
let buildingId, floorId, roomId;
let bookingIds = [];
let start, end;

function nextWeekdayAt(hour, daysAhead = 1) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
    d.setUTCDate(d.getUTCDate() + 1);
  }
  // IST = UTC + 5:30, so `hour`:00 IST == (hour-6):30 UTC. e.g. 10:00 IST
  // == 04:30 UTC — comfortably inside the 7:30-22:30 IST booking window.
  d.setUTCHours(hour - 6, 30, 0, 0);
  return d;
}

before(async () => {
  const loginRes = await fetch(`${BASE_URL}/user/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  const loginBody = await loginRes.json();
  assert.equal(loginRes.status, 200, "admin login must succeed for this test to run");
  token = loginBody.token;

  const authHeaders = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };

  const buildingRes = await fetch(`${BASE_URL}/buildings`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      name: `_ConcurrencyTestBldg-${Date.now()}`,
      address: "Test Addr",
      description: "throwaway — created by tests/concurrency.test.js",
    }),
  });
  buildingId = (await buildingRes.json()).building.id;

  const floorRes = await fetch(`${BASE_URL}/buildings/${buildingId}/floor`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ floor_number: 1, name: "Test Floor" }),
  });
  floorId = (await floorRes.json()).floor.id;

  const roomRes = await fetch(`${BASE_URL}/buildings/floor/${floorId}/room`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ name: "_ConcurrencyTestRoom", room_type: "classroom", capacity: 10 }),
  });
  roomId = (await roomRes.json()).room.id;

  start = nextWeekdayAt(10);
  end = nextWeekdayAt(11);
});

after(async () => {
  const authHeaders = { Authorization: `Bearer ${token}` };
  for (const id of bookingIds) {
    await fetch(`${BASE_URL}/booking/${id}`, { method: "DELETE", headers: authHeaders }).catch(() => {});
  }
  if (roomId) await fetch(`${BASE_URL}/buildings/room/${roomId}`, { method: "DELETE", headers: authHeaders }).catch(() => {});
  if (floorId) await fetch(`${BASE_URL}/buildings/floor/${floorId}`, { method: "DELETE", headers: authHeaders }).catch(() => {});
  if (buildingId) await fetch(`${BASE_URL}/buildings/${buildingId}`, { method: "DELETE", headers: authHeaders }).catch(() => {});
  await pool.end();
});

test("two simultaneous bookings for the same room+slot — exactly one succeeds", async () => {
  const payload = JSON.stringify({
    roomId,
    title: "Concurrency Test",
    startTime: start.toISOString(),
    endTime: end.toISOString(),
  });

  const bookRoom = () =>
    fetch(`${BASE_URL}/booking`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: payload,
    }).then(async (res) => ({ status: res.status, body: await res.json() }));

  const [r1, r2] = await Promise.all([bookRoom(), bookRoom()]);

  for (const r of [r1, r2]) {
    if (r.body?.booking?.id) bookingIds.push(r.body.booking.id);
  }

  const statuses = [r1.status, r2.status].sort((a, b) => a - b);

  // Exactly one request must succeed (201) — and since 201 is numerically
  // the smallest possible value here, ascending sort always puts it first.
  // The loser's status is allowed to be either 409 (clean exclusion-
  // constraint path) or 500 (the BEFORE trigger firing first, per the
  // documented precedence issue) — both prove the conflict was rejected,
  // which is the property under test.
  assert.equal(statuses[0], 201, `expected one request to succeed with 201, got statuses ${statuses}`);
  assert.ok(
    statuses[1] === 409 || statuses[1] === 500,
    `expected the losing request to be 409 or 500, got ${statuses[1]}`,
  );

  // The real safety property: the database must show exactly one active
  // booking for this room+slot, regardless of which HTTP status came back.
  const dbCheck = await pool.query(
    `SELECT id FROM bookings
     WHERE room_id = $1 AND status NOT IN ('cancelled', 'denied')
       AND tstzrange(start_time, end_time, '[)') && tstzrange($2::timestamptz, $3::timestamptz, '[)')`,
    [roomId, start.toISOString(), end.toISOString()],
  );
  assert.equal(dbCheck.rows.length, 1, "exactly one active booking should exist for this room+slot");
});
