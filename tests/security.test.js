// tests/security.test.js — run via `npm test`
//
// Regression tests for the Vyas_Remediation_Plan fixes that are not about sign-in
// (sign-in, sessions and step-up live in otp-auth.test.js). Same harness as
// auth.test.js: integration against a REAL running server + database.
//
// Requires the seeded admin profile (admin@mitwpu.edu.in — see database/seed.js);
// the tests mint a session for it directly. Each test cleans up what it creates.
//
// Every assertion here fails against the pre-fix code:
//   - job-scoping: the un-scoped UPDATE returned 204 and mutated the row

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pool from "../database/db.js";
import { BASE_URL, sessionFor } from "./helpers/auth.js";

const ADMIN_EMAIL = "admin@mitwpu.edu.in";

let authCookie;
let adminId;
const createdJobIds = [];

before(async () => {
  adminId = (await pool.query("SELECT id FROM profiles WHERE email = $1", [ADMIN_EMAIL])).rows[0].id;
  authCookie = (await sessionFor(adminId)).cookie;
});

after(async () => {
  for (const id of createdJobIds) {
    await pool.query("DELETE FROM timetable_import_jobs WHERE id = $1", [id]);
  }
  await pool.end();
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
    headers: { Cookie: authCookie, Origin: BASE_URL },
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
    { method: "PATCH", headers: { Cookie: authCookie, Origin: BASE_URL } }
  );
  assert.equal(res.status, 404);

  const after = await pool.query(
    "SELECT resolved FROM timetable_import_conflicts WHERE id = $1",
    [conflict]
  );
  assert.equal(after.rows[0].resolved, false, "conflict must not have been resolved");
});
