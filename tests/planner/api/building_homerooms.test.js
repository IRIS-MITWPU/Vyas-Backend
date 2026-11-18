// Planner API, contract 10: term building (pool filtering, change + confirm flow) and home classrooms (max 2 per division).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pool, openSessions, newUid, scope, cleanup, makeTerm, makeFaculty, someRooms, placeOneSession, fieldErrorsOf } from "./_util.js";

const s = scope(newUid());
let sessions;
let api;
let A; // classrooms of building 1: [{id, building_id}]
let B; // classrooms of building 2

before(async () => {
  sessions = await openSessions();
  api = sessions.api;
  const { rows } = await pool.query(
    `SELECT r.id, b.id AS building_id, b.name AS building FROM rooms r JOIN floors f ON f.id = r.floor_id JOIN buildings b ON b.id = f.building_id
      WHERE r.is_active AND r.room_type = 'classroom' ORDER BY b.name, r.name`
  );
  const byB = new Map();
  for (const r of rows) (byB.get(r.building_id) || byB.set(r.building_id, []).get(r.building_id)).push(r);
  const big = [...byB.values()].filter((l) => l.length >= 2);
  [A, B] = big.length >= 2 ? big : [null, null];
});
after(() => cleanup(s, sessions));

const need = (t) => {
  if (!A || !B) t.skip("needs two buildings with at least two classrooms each");
  return !!(A && B);
};

test("term building: create with building_id, bad building is a field error, PATCH null clears it", async (t) => {
  if (!need(t)) return;
  const ok = await api("POST", "/terms", { academic_year: s.year(), half: "odd", building_id: A[0].building_id });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.term.building_id, A[0].building_id);
  const id = ok.body.term.id;
  assert.equal((await api("GET", `/terms/${id}`)).body.term.building_id, A[0].building_id);
  const bad = await api("POST", "/terms", { academic_year: s.year(), half: "odd", building_id: "00000000-0000-4000-8000-000000000000" });
  assert.equal(bad.status, 400);
  assert.ok(fieldErrorsOf(bad).building_id);
  assert.equal((await api("POST", "/terms", { academic_year: s.year(), half: "odd", building_id: "nope" })).status, 400);
  const cleared = await api("PATCH", `/terms/${id}`, { building_id: null });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.term.building_id, null);
  const none = await makeTerm(api, s);
  assert.equal(none.term.building_id, null, "a term without a building keeps null (no restriction)");
});

test("available-rooms carries building_id; ?term_id= restricts to the term's building", async (t) => {
  if (!need(t)) return;
  const term = await makeTerm(api, s, { building_id: A[0].building_id });
  const all = await api("GET", "/available-rooms");
  assert.ok(all.body.rooms.every((r) => r.building_id));
  assert.ok(new Set(all.body.rooms.map((r) => r.building_id)).size >= 2);
  const mine = await api("GET", `/available-rooms?term_id=${term.id}`);
  assert.equal(mine.status, 200);
  assert.ok(mine.body.rooms.length > 0 && mine.body.rooms.every((r) => r.building_id === A[0].building_id));
  const free = await makeTerm(api, s);
  assert.equal((await api("GET", `/available-rooms?term_id=${free.id}`)).body.rooms.length, all.body.rooms.length, "no building: every room");
  assert.equal((await api("GET", "/available-rooms?term_id=nope")).status, 400);
});

test("pool: a room of another building is 422 ROOM_WRONG_BUILDING, one of the term's building is added", async (t) => {
  if (!need(t)) return;
  const term = await makeTerm(api, s, { building_id: A[0].building_id });
  const wrong = await api("POST", `/terms/${term.id}/rooms`, { room_id: B[0].id });
  assert.equal(wrong.status, 422);
  assert.equal(wrong.body.code, "ROOM_WRONG_BUILDING");
  const mixed = await api("POST", `/terms/${term.id}/rooms`, { room_ids: [A[0].id, B[0].id] });
  assert.equal(mixed.status, 422, "all or nothing");
  assert.equal((await api("GET", `/terms/${term.id}/rooms`)).body.rooms.length, 0);
  const good = await api("POST", `/terms/${term.id}/rooms`, { room_ids: [A[0].id, A[1].id] });
  assert.equal(good.status, 201);
  assert.ok(good.body.rooms.every((r) => r.building_id === A[0].building_id));
});

test("pool reads only the term's building even when a stale row of another building exists", async (t) => {
  if (!need(t)) return;
  const term = await makeTerm(api, s);
  assert.equal((await api("POST", `/terms/${term.id}/rooms`, { room_ids: [A[0].id, B[0].id] })).status, 201);
  // stale row: set the building directly in SQL (the API would have removed the row)
  await pool.query("UPDATE planner_terms SET building_id = $2 WHERE id = $1", [term.id, A[0].building_id]);
  const list = await api("GET", `/terms/${term.id}/rooms`);
  assert.deepEqual(list.body.rooms.map((r) => r.room_id), [A[0].id]);
  const snap = await api("GET", `/versions/${term.versionId}/snapshot`);
  assert.deepEqual(snap.body.rooms.map((r) => r.room_id), [A[0].id]);
});

test("changing the building: 409 BUILDING_CHANGE_NEEDS_CONFIRM with counts, then confirm_unplace removes rooms and unplaces sessions", async (t) => {
  if (!need(t)) return;
  const term = await makeTerm(api, s);
  const fac = await makeFaculty(api, s, "Bld");
  const subj = (await api("POST", `/terms/${term.id}/subjects`, { code: "BL", name: "Building subject", kind: "theory", weekly_count: 2 })).body.subject;
  const div = (await api("POST", `/terms/${term.id}/divisions`, { semester: 3, name: "B-A", student_count: 30 })).body.division;
  assert.equal((await api("POST", `/terms/${term.id}/offerings`, { division_id: div.id, subject_id: subj.id, faculty: [{ faculty_id: fac.id }] })).status, 201);
  assert.equal((await api("POST", `/versions/${term.versionId}/sync-sessions`)).status, 200);
  assert.equal((await api("POST", `/terms/${term.id}/rooms`, { room_ids: [A[0].id, B[0].id, B[1].id] })).status, 201);
  const placed = await placeOneSession(term.versionId, B[0].id); // a session sits in a room of building B
  const before = Number((await pool.query("SELECT rev FROM planner_versions WHERE id = $1", [term.versionId])).rows[0].rev);

  const refused = await api("PATCH", `/terms/${term.id}`, { building_id: A[0].building_id });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "BUILDING_CHANGE_NEEDS_CONFIRM");
  assert.deepEqual([refused.body.details.rooms, refused.body.details.placed_sessions], [2, 1]);
  assert.equal((await api("GET", `/terms/${term.id}`)).body.term.building_id, null, "nothing changed");

  // a locked session outside the new building blocks the change even with confirm
  await pool.query("UPDATE planner_sessions SET locked = true WHERE id = $1", [placed.id]);
  const locked = await api("PATCH", `/terms/${term.id}`, { building_id: A[0].building_id, confirm_unplace: true });
  assert.equal(locked.status, 409);
  assert.equal(locked.body.code, "LOCKED_BY_PLACEMENTS");
  assert.deepEqual(locked.body.details.fields, ["building_id"]);
  await pool.query("UPDATE planner_sessions SET locked = false WHERE id = $1", [placed.id]);

  const done = await api("PATCH", `/terms/${term.id}`, { building_id: A[0].building_id, confirm_unplace: true });
  assert.equal(done.status, 200);
  assert.equal(done.body.term.building_id, A[0].building_id);
  assert.equal("confirm_unplace" in done.body.term, false);
  const pool2 = await api("GET", `/terms/${term.id}/rooms`);
  assert.deepEqual(pool2.body.rooms.map((r) => r.room_id), [A[0].id]);
  const { rows: [row] } = await pool.query("SELECT weekday, room_id FROM planner_sessions WHERE id = $1", [placed.id]);
  assert.deepEqual([row.weekday, row.room_id], [null, null], "the session is unplaced");
  const after2 = Number((await pool.query("SELECT rev FROM planner_versions WHERE id = $1", [term.versionId])).rows[0].rev);
  assert.equal(after2, before + 1, "rev bumped once so open editors refetch");
  // nothing left outside: a further change to the same building needs no confirm
  assert.equal((await api("PATCH", `/terms/${term.id}`, { building_id: A[0].building_id })).status, 200);
});

test("division home classrooms: at most 2, distinct, classrooms only, derived home_room_ids, legacy home_room_id", async (t) => {
  const term = await makeTerm(api, s);
  const [r1, r2, r3] = await classrooms(3);
  const [lab] = await someRooms(1, { lab: true });
  const url = `/terms/${term.id}/divisions`;

  const two = await api("POST", url, { semester: 3, name: "H1", student_count: 30, home_room_ids: [r1, r2] });
  assert.equal(two.status, 201);
  assert.deepEqual(two.body.division.home_room_ids, [r1, r2]);
  assert.equal(two.body.division.home_room_id, r1);
  const div = two.body.division;

  const three = await api("PATCH", `${url}/${div.id}`, { home_room_ids: [r1, r2, r3] });
  assert.equal(three.status, 400, "a division has at most 2 home classrooms");
  assert.equal((await api("PATCH", `${url}/${div.id}`, { home_room_ids: [r1, r1] })).status, 400);
  const labRes = await api("PATCH", `${url}/${div.id}`, { home_room_ids: [lab] });
  assert.equal(labRes.status, 400);
  assert.ok(fieldErrorsOf(labRes)["home_room_ids.0"], "a lab room is not a classroom");
  assert.equal((await api("PATCH", `${url}/${div.id}`, { home_room_ids: ["00000000-0000-4000-8000-000000000000"] })).status, 400);

  // legacy home_room_id sets the first room and keeps the second
  const legacy = await api("PATCH", `${url}/${div.id}`, { home_room_id: r3 });
  assert.deepEqual(legacy.body.division.home_room_ids, [r3, r2]);
  const cleared1 = await api("PATCH", `${url}/${div.id}`, { home_room_id: null });
  assert.deepEqual(cleared1.body.division.home_room_ids, [r2], "the second room moves up");
  const cleared = await api("PATCH", `${url}/${div.id}`, { home_room_ids: [] });
  assert.deepEqual([cleared.body.division.home_room_ids, cleared.body.division.home_room_id], [[], null]);
  const listed = await api("GET", url);
  assert.deepEqual(listed.body.divisions.find((d) => d.id === div.id).home_room_ids, []);

  // the pool's own is_lab flag decides: a classroom the term marks as a lab is not a home room
  assert.equal((await api("POST", `/terms/${term.id}/rooms`, { room_id: r1, is_lab: true })).status, 201);
  const poolLab = await api("PATCH", `${url}/${div.id}`, { home_room_ids: [r1] });
  assert.equal(poolLab.status, 400);
});

test("division home classrooms must be in the term's building", async (t) => {
  if (!need(t)) return;
  const term = await makeTerm(api, s, { building_id: A[0].building_id });
  const div = (await api("POST", `/terms/${term.id}/divisions`, { semester: 3, name: "H2", student_count: 30 })).body.division;
  const wrong = await api("PATCH", `/terms/${term.id}/divisions/${div.id}`, { home_room_ids: [B[0].id] });
  assert.equal(wrong.status, 400);
  assert.ok(fieldErrorsOf(wrong)["home_room_ids.0"]);
  const ok = await api("PATCH", `/terms/${term.id}/divisions/${div.id}`, { home_room_ids: [A[0].id, A[1].id] });
  assert.deepEqual(ok.body.division.home_room_ids, [A[0].id, A[1].id]);
});

test("editor ops: theory of a division with home classrooms can only be placed in them (ROOM_NOT_HOME)", async () => {
  const term = await makeTerm(api, s);
  const [home, other] = await classrooms(2);
  const fac = await makeFaculty(api, s, "Home");
  const subj = (await api("POST", `/terms/${term.id}/subjects`, { code: "HM", name: "Home subject", kind: "theory", weekly_count: 2 })).body.subject;
  const div = (await api("POST", `/terms/${term.id}/divisions`, { semester: 3, name: "H3", student_count: 30 })).body.division;
  assert.equal((await api("POST", `/terms/${term.id}/offerings`, { division_id: div.id, subject_id: subj.id, faculty: [{ faculty_id: fac.id }] })).status, 201);
  assert.equal((await api("POST", `/terms/${term.id}/rooms`, { room_ids: [home, other] })).status, 201);
  assert.equal((await api("PATCH", `/terms/${term.id}/divisions/${div.id}`, { home_room_ids: [home] })).status, 200);
  await api("POST", `/versions/${term.versionId}/sync-sessions`);
  const snap = (await api("GET", `/versions/${term.versionId}/snapshot`)).body;
  assert.deepEqual(snap.divisions.find((d) => d.id === div.id).home_room_ids, [home]);
  const [s1, s2] = snap.sessions.map((x) => x.id);

  const wrong = await api("POST", `/versions/${term.versionId}/ops`, { ops: [{ op: "place", session_id: s1, weekday: 0, start_min: 510, room_id: other }] });
  assert.equal(wrong.status, 422);
  assert.equal(wrong.body.code, "PLACEMENT_INVALID");
  assert.equal(wrong.body.details.reason, "ROOM_NOT_HOME");

  const auto = await api("POST", `/versions/${term.versionId}/ops`, { ops: [{ op: "place", session_id: s1, weekday: 0, start_min: 510 }] });
  assert.equal(auto.status, 200);
  assert.equal(auto.body.sessions[0].room_id, home, "auto room = the home classroom");

  const setRoom = await api("POST", `/versions/${term.versionId}/ops`, { ops: [{ op: "set_room", session_id: s1, room_id: other }] });
  assert.equal(setRoom.status, 422);
  assert.equal(setRoom.body.details.reason, "ROOM_NOT_HOME");

  // a division without home rooms is unrestricted
  assert.equal((await api("PATCH", `/terms/${term.id}/divisions/${div.id}`, { home_room_ids: [] })).status, 200);
  const free = await api("POST", `/versions/${term.versionId}/ops`, { ops: [{ op: "place", session_id: s2, weekday: 1, start_min: 510, room_id: other }] });
  assert.equal(free.status, 200);
});

async function classrooms(n) {
  const { rows } = await pool.query("SELECT id FROM rooms WHERE is_active AND room_type = 'classroom' ORDER BY name LIMIT $1", [n]);
  return rows.map((r) => r.id);
}
