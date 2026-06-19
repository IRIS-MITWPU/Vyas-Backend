// tests/concurrency.js — Phase 6 concurrency test
// Run: node tests/concurrency.js
//
// Required env vars (or set them below):
//   BASE_URL    — e.g. http://localhost:3000
//   TEST_TOKEN  — valid JWT from POST /user/login
//   TEST_ROOM_ID — UUID of an active room

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const TOKEN = process.env.TEST_TOKEN ?? "";
const ROOM_ID = process.env.TEST_ROOM_ID ?? "";

if (!TOKEN || !ROOM_ID) {
  console.error("Set TEST_TOKEN and TEST_ROOM_ID before running.");
  process.exit(1);
}

// Pick a future time slot unlikely to conflict with real bookings
const start = new Date();
start.setDate(start.getDate() + 1); // tomorrow
start.setHours(10, 0, 0, 0);
const end = new Date(start);
end.setHours(11, 0, 0, 0);

const payload = JSON.stringify({
  roomId: ROOM_ID,
  title: "Concurrency Test",
  startTime: start.toISOString(),
  endTime: end.toISOString(),
});

async function bookRoom(id) {
  const res = await fetch(`${BASE_URL}/booking`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: payload,
  });
  const body = await res.json();
  return { id, status: res.status, body };
}

// ─── Test 1: simultaneous double-booking ─────────────────────────────────────
console.log("Test 1: simultaneous double-booking…");

const [r1, r2] = await Promise.all([bookRoom(1), bookRoom(2)]);

console.log(`  Request 1 → ${r1.status}`, r1.body.error ?? r1.body.booking?.id);
console.log(`  Request 2 → ${r2.status}`, r2.body.error ?? r2.body.booking?.id);

const statuses = [r1.status, r2.status].sort((a, b) => a - b);
if (statuses[0] === 201 && statuses[1] === 409) {
  console.log("  ✅ PASS — one booking succeeded, one rejected\n");
} else {
  console.log("  ❌ FAIL — expected one 201 and one 409\n");
  process.exit(1);
}

// ─── Test 2: load test instructions ──────────────────────────────────────────
console.log("Test 2: autocannon load test");
console.log("  Install:  npm install -g autocannon");
console.log(
  `  Run:      autocannon -c 50 -a 500 -m POST -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -b '${payload}' ${BASE_URL}/booking`,
);
console.log("  Expected: zero duplicate overlapping bookings in the DB.\n");
