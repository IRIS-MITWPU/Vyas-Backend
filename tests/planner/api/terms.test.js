// Planner API: auth gates, health, terms CRUD, settings lock, delete step-up.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { http, pool, openSessions, newUid, scope, cleanup, makeTerm, makeFaculty, someRooms, placeOneSession, fieldErrorsOf, plannerApi } from "./_util.js";

const s = scope(newUid());
let sessions;
let api;

before(async () => {
  sessions = await openSessions();
  api = sessions.api;
});
after(() => cleanup(s, sessions));

test("401 without a session, on every kind of route", async () => {
  for (const [m, p] of [["GET", "/planner/terms"], ["POST", "/planner/terms"], ["GET", "/planner/health"], ["GET", "/planner/faculty"]]) {
    const res = await http(m, p, { body: m === "POST" ? {} : undefined });
    assert.equal(res.status, 401, `${m} ${p}`);
  }
});

test("403 for a signed-in non-admin", async () => {
  for (const [m, p] of [["GET", "/terms"], ["GET", "/faculty"], ["GET", "/available-rooms"], ["GET", "/health"]]) {
    const res = await sessions.userApi(m, p);
    assert.equal(res.status, 403, `${m} ${p}`);
  }
});

test("GET /planner/health for an admin", async () => {
  const res = await api("GET", "/health");
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.module, "planner");
  assert.equal(res.body.user.is_admin, true);
});

test("unknown planner route is a JSON 404", async () => {
  const res = await api("GET", "/nope");
  assert.equal(res.status, 404);
  assert.equal(res.body.success, false);
});

test("create term: 201, draft version 1, 23 default rules, defaults and date strings", async () => {
  const res = await api("POST", "/terms", { academic_year: s.year(), half: "even", start_date: "2026-07-27", end_date: "2026-11-08" });
  assert.equal(res.status, 201);
  assert.equal(res.body.success, true);
  const { term, version } = res.body;
  assert.equal(term.branch, "CSE");
  assert.equal(term.start_date, "2026-07-27");
  assert.equal(term.end_date, "2026-11-08");
  assert.deepEqual(term.working_days, [0, 1, 2, 3, 4]);
  assert.equal(term.day_start_min, 510);
  assert.equal(term.breaks.length, 3);
  assert.equal(version.version_no, 1);
  assert.equal(version.status, "draft");
  assert.equal(Number(version.rev), 0);
  const { rows: [{ n }] } = await pool.query("SELECT count(*)::int AS n FROM planner_rule_config WHERE term_id = $1", [term.id]);
  assert.equal(n, 23);
});

test("duplicate (year, half, branch) is 409 DUPLICATE and leaves no half-created rows", async () => {
  const year = s.year();
  assert.equal((await api("POST", "/terms", { academic_year: year, half: "odd" })).status, 201);
  const dup = await api("POST", "/terms", { academic_year: year, half: "odd" });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.code, "DUPLICATE");
  assert.equal(dup.body.success, false);
  const { rows: [{ n }] } = await pool.query("SELECT count(*)::int AS n FROM planner_terms WHERE academic_year = $1", [year]);
  assert.equal(n, 1);
  // same year, other half / other branch is fine
  assert.equal((await api("POST", "/terms", { academic_year: year, half: "even" })).status, 201);
  assert.equal((await api("POST", "/terms", { academic_year: year, half: "odd", branch: "ECE" })).status, 201);
});

test("validation: 400 VALIDATION_ERROR with details.fieldErrors", async () => {
  const bad = await api("POST", "/terms", { academic_year: "", half: "summer", day_start_min: 600, day_end_min: 500 });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, "VALIDATION_ERROR");
  const fe = fieldErrorsOf(bad);
  assert.ok(fe.academic_year, "academic_year flagged");
  assert.ok(fe.half, "half flagged");

  const order = await api("POST", "/terms", { academic_year: s.year(), half: "odd", day_start_min: 600, day_end_min: 500 });
  assert.equal(order.status, 400);
  assert.ok(fieldErrorsOf(order).day_end_min);

  const dates = await api("POST", "/terms", { academic_year: s.year(), half: "odd", start_date: "2026-12-01", end_date: "2026-11-01" });
  assert.equal(dates.status, 400);
  assert.ok(fieldErrorsOf(dates).end_date);

  const notDate = await api("POST", "/terms", { academic_year: s.year(), half: "odd", start_date: "2026-02-31" });
  assert.equal(notDate.status, 400);
  assert.ok(fieldErrorsOf(notDate).start_date);
});

test("list and get: counts, draft_version_id, versions, 404s", async () => {
  const t = await makeTerm(api, s);
  const list = await api("GET", "/terms");
  assert.equal(list.status, 200);
  const row = list.body.terms.find((x) => x.id === t.id);
  assert.ok(row);
  assert.equal(row.draft_version_id, t.versionId);
  assert.deepEqual(row.counts, { divisions: 0, subjects: 0, offerings: 0, rooms: 0, sessions: 0 });

  const one = await api("GET", `/terms/${t.id}`);
  assert.equal(one.status, 200);
  assert.equal(one.body.draft_version_id, t.versionId);
  assert.equal(one.body.versions.length, 1);
  assert.equal(one.body.term.id, t.id);

  const missing = await api("GET", "/terms/00000000-0000-4000-8000-000000000000");
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, "NOT_FOUND");
  const malformed = await api("GET", "/terms/not-a-uuid");
  assert.equal(malformed.status, 404);
  assert.equal(malformed.body.code, "NOT_FOUND");
});

test("PATCH: partial update, null clears dates, validation, duplicate", async () => {
  const t = await makeTerm(api, s, { start_date: "2026-07-27", end_date: "2026-11-08" });
  const a = await api("PATCH", `/terms/${t.id}`, { end_date: null, start_date: null });
  assert.equal(a.status, 200);
  assert.equal(a.body.term.start_date, null);
  assert.equal(a.body.term.end_date, null);

  const b = await api("PATCH", `/terms/${t.id}`, { day_end_min: 1080, working_days: [0, 1, 2, 3, 4, 5], theory_minutes: 50 });
  assert.equal(b.status, 200);
  assert.equal(b.body.term.day_end_min, 1080);
  assert.deepEqual(b.body.term.working_days, [0, 1, 2, 3, 4, 5]);

  const empty = await api("PATCH", `/terms/${t.id}`, {});
  assert.equal(empty.status, 400);
  const inverted = await api("PATCH", `/terms/${t.id}`, { day_start_min: 2000 });
  assert.equal(inverted.status, 400);
  assert.equal(inverted.body.code, "VALIDATION_ERROR");

  const other = await makeTerm(api, s);
  const clash = await api("PATCH", `/terms/${other.id}`, { academic_year: t.term.academic_year });
  assert.equal(clash.status, 409);
  assert.equal(clash.body.code, "DUPLICATE");
  assert.equal((await api("PATCH", "/terms/00000000-0000-4000-8000-000000000000", { branch: "X" })).status, 404);
});

test("PATCH time settings: 409 LOCKED_BY_PLACEMENTS once a session is placed; other fields and unchanged values are fine", async () => {
  const t = await makeTerm(api, s);
  const fac = await makeFaculty(api, s, "Lock");
  const subj = (await api("POST", `/terms/${t.id}/subjects`, { code: "LK", name: "Lock subject", kind: "theory", weekly_count: 2 })).body.subject;
  const div = (await api("POST", `/terms/${t.id}/divisions`, { semester: 3, name: "L-A", student_count: 30 })).body.division;
  const off = await api("POST", `/terms/${t.id}/offerings`, { division_id: div.id, subject_id: subj.id, faculty: [{ faculty_id: fac.id }] });
  assert.equal(off.status, 201);
  const sync = await api("POST", `/versions/${t.versionId}/sync-sessions`);
  assert.equal(sync.status, 200);
  assert.equal(sync.body.added, 2);

  // before placement: allowed
  assert.equal((await api("PATCH", `/terms/${t.id}`, { grid_minutes: 15, day_end_min: 1060 })).status, 200);

  const [room] = await someRooms(1);
  await placeOneSession(t.versionId, room);

  const locked = await api("PATCH", `/terms/${t.id}`, { day_end_min: 1000 });
  assert.equal(locked.status, 409);
  assert.equal(locked.body.code, "LOCKED_BY_PLACEMENTS");
  assert.deepEqual(locked.body.details.fields, ["day_end_min"]);
  const breaks = await api("PATCH", `/terms/${t.id}`, { breaks: [] });
  assert.equal(breaks.status, 409);
  const days = await api("PATCH", `/terms/${t.id}`, { working_days: [0, 1, 2] });
  assert.equal(days.status, 409);

  // unchanged value and non-time fields are fine
  assert.equal((await api("PATCH", `/terms/${t.id}`, { day_end_min: 1060 })).status, 200);
  assert.equal((await api("PATCH", `/terms/${t.id}`, { start_date: "2026-08-01", end_date: "2026-11-01" })).status, 200);
  const stored = await pool.query("SELECT day_end_min FROM planner_terms WHERE id = $1", [t.id]);
  assert.equal(stored.rows[0].day_end_min, 1060);

  // deleting a term that has a placed session must not 500 (NO ACTION FKs cascade in one statement)
  const stale = await pool.query("UPDATE sessions SET reauth_at = NOW() WHERE id = $1", [sessions.admin.sessionId]);
  assert.equal(stale.rowCount, 1);
  const del = await api("DELETE", `/terms/${t.id}`);
  assert.equal(del.status, 200);
  assert.equal(del.body.success, true);
  const { rows: [{ n }] } = await pool.query("SELECT count(*)::int AS n FROM planner_sessions WHERE version_id = $1", [t.versionId]);
  assert.equal(n, 0);
  // faculty is global and untouched
  const stillThere = await pool.query("SELECT 1 FROM planner_faculty WHERE id = $1", [fac.id]);
  assert.equal(stillThere.rowCount, 1);
});

test("DELETE /terms/:id needs a fresh authentication (REAUTH_REQUIRED when stale), cascades children", async () => {
  const t = await makeTerm(api, s);
  await api("POST", `/terms/${t.id}/subjects`, { code: "DEL", name: "To be deleted", kind: "theory", weekly_count: 1 });
  await api("POST", `/terms/${t.id}/divisions`, { semester: 3, name: "D-A", student_count: 10 });
  const [room] = await someRooms(1);
  await api("POST", `/terms/${t.id}/rooms`, { room_id: room });

  // stale session: last re-authentication an hour ago
  await pool.query("UPDATE sessions SET reauth_at = NOW() - INTERVAL '1 hour' WHERE id = $1", [sessions.admin.sessionId]);
  const stale = await api("DELETE", `/terms/${t.id}`);
  assert.equal(stale.status, 403);
  assert.equal(stale.body.code, "REAUTH_REQUIRED");
  assert.equal((await api("GET", `/terms/${t.id}`)).status, 200, "term still there");

  // fresh again
  await pool.query("UPDATE sessions SET reauth_at = NOW() WHERE id = $1", [sessions.admin.sessionId]);
  const ok = await api("DELETE", `/terms/${t.id}`);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { success: true });
  assert.equal((await api("GET", `/terms/${t.id}`)).status, 404);
  assert.equal((await api("DELETE", `/terms/${t.id}`)).status, 404);
  for (const table of ["planner_subjects", "planner_divisions", "planner_term_rooms", "planner_versions", "planner_rule_config"]) {
    const { rows: [{ n }] } = await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE term_id = $1`, [t.id]);
    assert.equal(n, 0, table);
  }
});

test("a non-admin cannot delete (403 before step-up)", async () => {
  const t = await makeTerm(api, s);
  const res = await plannerApi(sessions.user.cookie)("DELETE", `/terms/${t.id}`);
  assert.equal(res.status, 403);
  assert.notEqual(res.body.code, "REAUTH_REQUIRED");
});
