// Planner Phase 2 API: snapshot, ops (place/move/unplace/lock/unlock/set_room/set_faculty), placement rules,
// room choice, all-or-nothing, rev handling, draft-only, validation. Clash sentences live in editorClash.test.js.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { pool, openSessions, newUid, scope, cleanup, http, BASE_URL } from "./_util.js";
import {
  MON, TUE, WED, buildWorld, S, ops, place, revOf, occCount, occOf, dbSession, resetWorld, occupancyIsConsistent,
  roomName, refreshSessions,
} from "./_editorUtil.js";

const s = scope(newUid());
const NIL = "00000000-0000-4000-8000-000000000000";
let sessions;
let api;
let w;

before(async () => {
  sessions = await openSessions();
  api = sessions.api;
  w = await buildWorld(api, s);
});
after(() => cleanup(s, sessions));
beforeEach(() => resetWorld(w));

// ------------------------------------------------------------------ snapshot + auth

test("GET snapshot: full shape, rev is a number, sessions/offerings/rooms/faculty match the other endpoints", async () => {
  const res = await api("GET", `/versions/${w.versionId}/snapshot`);
  assert.equal(res.status, 200);
  const b = res.body;
  assert.equal(b.success, true);
  assert.equal(typeof b.rev, "number");
  assert.equal(b.rev, await revOf(w.versionId));
  assert.deepEqual(b.version, { id: w.versionId, term_id: w.termId, version_no: 1, status: "draft" });
  assert.equal(b.term.id, w.termId);
  assert.deepEqual(b.term.working_days, [0, 1, 2, 3, 4]);
  assert.equal(b.term.day_start_min, 510);
  assert.equal(b.divisions.length, 2);
  const x = b.divisions.find((d) => d.name === "X");
  assert.deepEqual(x.batches.map((bt) => [bt.name, bt.is_whole]), [["ALL", true], ["X1", false], ["X2", false], ["X3", false]]);
  assert.deepEqual(b.subjects.map((x2) => x2.code).sort(), ["LB", "TH1", "TH2", "TH3"]);
  const off = await api("GET", `/terms/${w.termId}/offerings`);
  assert.deepEqual(b.offerings, off.body.offerings);
  const pool_ = await api("GET", `/terms/${w.termId}/rooms`);
  assert.deepEqual(b.rooms, pool_.body.rooms);
  const list = await api("GET", `/versions/${w.versionId}/sessions`);
  assert.deepEqual(b.sessions, list.body.sessions);
  assert.equal(b.sessions.length, 9);
  for (const f of Object.values(w.fac)) {
    const hit = b.faculty.find((x2) => x2.id === f.id);
    assert.ok(hit, `faculty ${f.short_code}`);
    assert.deepEqual(Object.keys(hit).sort(), ["department", "full_name", "id", "is_active", "max_per_day", "max_per_week", "short_code"]);
    assert.equal(hit.is_active, true);
  }
});

test("snapshot: unknown version 404, malformed id 404", async () => {
  const a = await api("GET", `/versions/${NIL}/snapshot`);
  assert.equal(a.status, 404);
  assert.equal(a.body.code, "NOT_FOUND");
  assert.equal((await api("GET", "/versions/not-a-uuid/snapshot")).status, 404);
});

test("ops and snapshot: non-admin 403, unauthenticated 401", async () => {
  const body = { ops: [{ op: "lock", session_id: S(w, "X", "TH1") }] };
  for (const [m, p, b] of [["GET", `/planner/versions/${w.versionId}/snapshot`], ["POST", `/planner/versions/${w.versionId}/ops`, body]]) {
    const user = await http(m, p, { cookie: sessions.user.cookie, body: b });
    assert.equal(user.status, 403, `${m} ${p} non-admin`);
    const anon = await http(m, p, { body: b });
    assert.equal(anon.status, 401, `${m} ${p} anonymous`);
  }
  assert.equal((await dbSession(S(w, "X", "TH1"))).locked, false);
});

// ------------------------------------------------------------------ validation

test("ops validation: 400 VALIDATION_ERROR with fieldErrors; unknown or foreign session is 404 with op_index", async () => {
  const sid = S(w, "X", "TH1");
  const bad = async (body, field) => {
    const r = await api("POST", `/versions/${w.versionId}/ops`, body);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 120));
    assert.equal(r.body.code, "VALIDATION_ERROR");
    if (field) assert.ok(Object.keys(r.body.details.fieldErrors).some((k) => k.startsWith(field)), `${field} in ${JSON.stringify(r.body.details)}`);
  };
  await bad({ ops: [] }, "ops");
  await bad({ ops: Array.from({ length: 51 }, () => ({ op: "lock", session_id: sid })) }, "ops");
  await bad({}, "ops");
  await bad({ ops: [{ op: "dance", session_id: sid }] });
  await bad({ ops: [{ op: "lock", session_id: "nope" }] }, "ops.0.session_id");
  await bad({ ops: [{ op: "place", session_id: sid, weekday: 7, start_min: 510 }] }, "ops.0.weekday");
  await bad({ ops: [{ op: "place", session_id: sid, weekday: 0, start_min: 510.5 }] }, "ops.0.start_min");
  await bad({ ops: [{ op: "place", session_id: sid, weekday: 0, start_min: "510" }] }, "ops.0.start_min");
  await bad({ ops: [{ op: "set_faculty", session_id: sid, faculty_ids: [] }] }, "ops.0.faculty_ids");
  await bad({ client_id: "x".repeat(65), ops: [{ op: "lock", session_id: sid }] }, "client_id");

  const missing = await api("POST", `/versions/${w.versionId}/ops`, { ops: [{ op: "lock", session_id: S(w, "X", "TH1") }, { op: "lock", session_id: NIL }] });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, "NOT_FOUND");
  assert.deepEqual(missing.body.details, { op_index: 1 });
  assert.equal((await dbSession(sid)).locked, false, "nothing applied");

  // a session of another version is "not found" here
  const other = await buildOtherVersionSession();
  const foreign = await api("POST", `/versions/${w.versionId}/ops`, { ops: [{ op: "lock", session_id: other }] });
  assert.equal(foreign.status, 404);
  assert.deepEqual(foreign.body.details, { op_index: 0 });
  assert.equal((await api("POST", "/versions/not-a-uuid/ops", { ops: [{ op: "lock", session_id: sid }] })).status, 404);
  assert.equal((await api("POST", `/versions/${NIL}/ops`, { ops: [{ op: "lock", session_id: sid }] })).status, 404);
});

async function buildOtherVersionSession() {
  const t = await api("POST", "/terms", { academic_year: s.year(), half: "even" });
  const sub = await api("POST", `/terms/${t.body.term.id}/subjects`, { code: "O1", name: "Other", kind: "theory", weekly_count: 1 });
  const div = await api("POST", `/terms/${t.body.term.id}/divisions`, { semester: 1, name: "O", student_count: 10 });
  const f = await api("POST", "/faculty", { short_code: s.code("Oth"), full_name: "Other Fac" });
  await api("POST", `/terms/${t.body.term.id}/offerings`, { division_id: div.body.division.id, subject_id: sub.body.subject.id, faculty: [{ faculty_id: f.body.faculty.id }] });
  await api("POST", `/versions/${t.body.version.id}/sync-sessions`);
  const list = await api("GET", `/versions/${t.body.version.id}/sessions`);
  return list.body.sessions[0].id;
}

// ------------------------------------------------------------------ placement rule

test("PLACEMENT_INVALID: every reason with its message, details {op_index, reason}, nothing written", async () => {
  const sid = S(w, "X", "TH1");
  const rev0 = await revOf(w.versionId);
  const expectInvalid = async (op, reason, message, index = 0, pre = []) => {
    const r = await ops(w, [...pre, op]);
    assert.equal(r.status, 422, `${reason}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.success, false);
    assert.equal(r.body.code, "PLACEMENT_INVALID");
    assert.deepEqual(r.body.details, { op_index: index, reason });
    assert.equal(r.body.error, message);
  };
  await expectInvalid(place(w, sid, 5, 510), "NOT_WORKING_DAY", "Saturday is not a working day for this term.");
  await expectInvalid(place(w, sid, MON, 511), "OFF_GRID", "08:31 is not on the 15-minute grid; sessions must start on a quarter hour.");
  await expectInvalid(place(w, sid, MON, 450), "OUTSIDE_HOURS", "Monday 07:30 is before the day starts at 08:30.");
  await expectInvalid(place(w, sid, MON, 1020), "OUTSIDE_HOURS", "Monday 17:00–18:00 runs past the end of the day at 17:45.");
  await expectInvalid(place(w, sid, MON, 600), "OVERLAPS_BREAK", "Monday 10:00–11:00 overlaps the Short break 1 (10:30–10:45).");
  await expectInvalid(place(w, sid, MON, 720), "OVERLAPS_BREAK", "Monday 12:00–13:00 overlaps the Lunch (12:45–13:30).");
  await expectInvalid(place(w, sid, MON, 510, w.rooms.outside), "ROOM_NOT_IN_POOL", "That room is not in this term's room pool.");
  // op_index of the failing op, and the earlier op is rolled back
  await expectInvalid(place(w, sid, 6, 510), "NOT_WORKING_DAY", "Sunday is not a working day for this term.", 1, [place(w, S(w, "X", "TH2"), MON, 510)]);
  assert.equal((await dbSession(S(w, "X", "TH2"))).weekday, null);
  assert.equal(await revOf(w.versionId), rev0);
  assert.equal(await occCount(w.versionId), 0);
  // a lab that starts fine but runs into lunch
  await expectInvalid(place(w, S(w, "X", "LB", "X1"), MON, 705), "OVERLAPS_BREAK", "Monday 11:45–13:45 overlaps the Lunch (12:45–13:30).");
});

test("the grid follows the term: a 30-minute grid rejects 08:45 (and the term can be changed while nothing is placed)", async () => {
  assert.equal((await api("PATCH", `/terms/${w.termId}`, { grid_minutes: 30 })).status, 200);
  try {
    const r = await ops(w, [place(w, S(w, "X", "TH1"), MON, 525)]);
    assert.equal(r.status, 422);
    assert.equal(r.body.details.reason, "OFF_GRID");
    assert.equal(r.body.error, "08:45 is not on this term's 30-minute grid; sessions start every 30 minutes from 08:30.");
    assert.equal((await ops(w, [place(w, S(w, "X", "TH1"), MON, 540)])).status, 200);
  } finally {
    await resetWorld(w);
    await api("PATCH", `/terms/${w.termId}`, { grid_minutes: 15 });
  }
});

// ------------------------------------------------------------------ place / move / unplace + occupancy

test("place: end_min comes from the subject duration, occupancy rows per contract, rev +1, response shape", async () => {
  const th = S(w, "X", "TH1");
  const rev0 = await revOf(w.versionId);
  const r = await ops(w, [place(w, th, MON, 510)], "client-1");
  assert.equal(r.status, 200);
  assert.equal(r.body.success, true);
  assert.equal(r.body.prev_rev, rev0);
  assert.equal(r.body.rev, rev0 + 1);
  assert.equal(typeof r.body.rev, "number");
  assert.equal(r.body.sessions.length, 1);
  const got = r.body.sessions[0];
  assert.equal(got.id, th);
  assert.deepEqual([got.weekday, got.start_min, got.end_min], [MON, 510, 570]);
  assert.equal(got.subject_code, "TH1");
  assert.equal(got.batch_name, "ALL");
  assert.deepEqual(got.faculty.map((f) => f.faculty_id), [w.fac.A.id]);
  assert.deepEqual(r.body.results, [{ index: 0, session_id: th, room_id: got.room_id }]);
  assert.ok(got.room_id);
  assert.equal(await revOf(w.versionId), rev0 + 1);

  // whole-batch theory: 1 faculty + 1 room + (ALL + X1 + X2 + X3) batch rows
  const rows = await occOf(th);
  assert.equal(rows.length, 6);
  assert.equal(rows.filter((x) => x.kind === "faculty").length, 1);
  assert.equal(rows.filter((x) => x.kind === "room").length, 1);
  const batchIds = rows.filter((x) => x.kind === "batch").map((x) => x.resource_id).sort();
  assert.deepEqual(batchIds, [w.X.batches.find((b) => b.is_whole).id, w.bx.X1.id, w.bx.X2.id, w.bx.X3.id].sort());
  assert.ok(rows.every((x) => x.weekday === MON && x.start_min === 510 && x.end_min === 570));

  // lab on one batch: faculty C + assist E, one room, one batch row
  const lb = S(w, "X", "LB", "X1");
  assert.equal((await ops(w, [place(w, lb, TUE, 510)])).status, 200);
  const lrows = await occOf(lb);
  assert.equal(lrows.length, 4);
  assert.deepEqual(lrows.filter((x) => x.kind === "faculty").map((x) => x.resource_id).sort(), [w.fac.C.id, w.fac.E.id].sort());
  assert.deepEqual(lrows.filter((x) => x.kind === "batch").map((x) => x.resource_id), [w.bx.X1.id]);
  assert.ok(lrows.every((x) => x.start_min === 510 && x.end_min === 630));
  assert.ok(await occupancyIsConsistent(w.versionId));
});

test("move frees the old slot and place of a placed session behaves like move; unplace removes every row", async () => {
  const th = S(w, "X", "TH1");
  const other = S(w, "Y", "TH1");
  assert.equal((await ops(w, [place(w, th, MON, 510)])).status, 200);
  const room = (await dbSession(th)).room_id;
  // Y.TH1 has the same faculty A: Mon 08:30 is taken ...
  const blocked = await ops(w, [place(w, other, MON, 510)]);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, "CLASH");
  // ... move X.TH1 away -> the slot is free again
  const mv = await ops(w, [{ op: "move", session_id: th, weekday: WED, start_min: 570 }]);
  assert.equal(mv.status, 200);
  assert.deepEqual(mv.body.results, [{ index: 0, session_id: th, room_id: room }], "a free current room is kept");
  const rows = await occOf(th);
  assert.equal(rows.length, 6);
  assert.ok(rows.every((x) => x.weekday === WED && x.start_min === 570 && x.end_min === 630));
  assert.equal((await ops(w, [place(w, other, MON, 510)])).status, 200);
  // "place" on a placed session = move
  const again = await ops(w, [place(w, th, WED, 645)]);
  assert.equal(again.status, 200);
  assert.deepEqual([(await dbSession(th)).weekday, (await dbSession(th)).start_min, (await dbSession(th)).end_min], [WED, 645, 705]);
  assert.equal((await occOf(th)).length, 6);
  assert.equal(await occCount(w.versionId, "session_id = $2", [th]), 6);

  // unplace
  const rev0 = await revOf(w.versionId);
  const un = await ops(w, [{ op: "unplace", session_id: th }]);
  assert.equal(un.status, 200);
  assert.equal(un.body.rev, rev0 + 1);
  assert.deepEqual(un.body.results, [{ index: 0, session_id: th, room_id: null }]);
  assert.deepEqual(await dbSession(th), { weekday: null, start_min: null, end_min: null, room_id: null, locked: false });
  assert.equal((await occOf(th)).length, 0);
  assert.equal(un.body.sessions[0].weekday, null);
  assert.ok(await occupancyIsConsistent(w.versionId));
  // already unplaced -> no change, no rev bump
  const noop = await ops(w, [{ op: "unplace", session_id: th }]);
  assert.equal(noop.status, 200);
  assert.equal(noop.body.rev, rev0 + 1);
  assert.equal(noop.body.prev_rev, rev0 + 1);
  assert.deepEqual(noop.body.sessions, []);
});

test("occupancy is zero for unplaced sessions; a fresh sync adds none", async () => {
  assert.equal(await occCount(w.versionId), 0);
  await api("POST", `/versions/${w.versionId}/sync-sessions`);
  assert.equal(await occCount(w.versionId), 0);
});

// ------------------------------------------------------------------ rooms

test("auto room: theory uses the home room, then another free classroom; labs get a lab; NO_ROOM_AVAILABLE when none is free", async () => {
  const classroomSet = new Set(w.rooms.classrooms);
  const labSet = new Set(w.rooms.labs);
  // Y gets the home room classrooms[1] for this part of the test (contract 10.3: a division with home rooms only uses them)
  assert.equal((await w.api("PATCH", `/terms/${w.termId}/divisions/${w.Y.id}`, { home_room_ids: [w.rooms.classrooms[1]] })).status, 200);
  const y1 = await ops(w, [place(w, S(w, "Y", "TH1", "ALL", 1), MON, 570)]);
  assert.equal(y1.body.results[0].room_id, w.rooms.classrooms[1]);
  // X has none: any free classroom, never the busy home room of Y at the same time
  const x2 = await ops(w, [place(w, S(w, "X", "TH2"), MON, 570)]);
  assert.equal(x2.status, 200);
  const xr = x2.body.results[0].room_id;
  assert.ok(classroomSet.has(xr));
  assert.notEqual(xr, w.rooms.classrooms[1]);
  // Y's home room is busy: a second Y theory elsewhere in time is back in the home room (free again)
  const y2 = await ops(w, [place(w, S(w, "Y", "TH2"), MON, 705)]);
  assert.equal(y2.body.results[0].room_id, w.rooms.classrooms[1]);
  assert.equal((await w.api("PATCH", `/terms/${w.termId}/divisions/${w.Y.id}`, { home_room_ids: [] })).status, 200); // the rest places Y freely

  // labs (contract 8.7, CHANGED from "one lab room per batch lab"): the three 8-student batch labs of X share ONE lab
  // room (best fit = the fullest lab that still has space, ties: smallest capacity). The pool's labs seat 30 and 62.
  const l1 = await ops(w, [place(w, S(w, "X", "LB", "X1"), TUE, 510)]);
  const l2 = await ops(w, [place(w, S(w, "X", "LB", "X2"), TUE, 510)]);
  const l3 = await ops(w, [place(w, S(w, "X", "LB", "X3"), TUE, 510)]);
  for (const l of [l1, l2, l3]) assert.equal(l.status, 200, JSON.stringify(l.body));
  const lr = [l1, l2, l3].map((l) => l.body.results[0].room_id);
  assert.ok(lr.every((r) => labSet.has(r)));
  assert.equal(new Set(lr).size, 1, "all three batches packed into one lab room");
  assert.equal(await occCount(w.versionId, "kind = 'lab_room' AND resource_id = $2", [lr[0]]), 3);
  assert.equal(await occCount(w.versionId, "kind = 'room' AND resource_id = ANY($2::uuid[])", [w.rooms.labs]), 0);
  // a lab room that carries an EXCLUSIVE session is "in use": with both labs held by theory sessions there is nothing left
  assert.equal((await ops(w, [place(w, S(w, "Y", "TH1"), TUE, 645, w.rooms.labs[0]), place(w, S(w, "Y", "TH2"), TUE, 705, w.rooms.labs[1])])).status, 200);
  const l4 = await ops(w, [place(w, S(w, "X", "LB", "X2"), TUE, 645)]);
  assert.equal(l4.status, 409);
  assert.equal(l4.body.code, "NO_ROOM_AVAILABLE");
  assert.equal(l4.body.error, "All 2 labs are already in use at that time.");
  assert.deepEqual(l4.body.details, { op_index: 0 });
  assert.equal((await dbSession(S(w, "X", "LB", "X2"))).start_min, 510, "X2 stays where it was");
  // an explicit room bypasses the auto pick: manual lab room choice is not kind-checked in Phase 2
  const manual = await ops(w, [place(w, S(w, "X", "TH1"), WED, 510, w.rooms.labs[0])]);
  assert.equal(manual.status, 200);
  assert.equal(manual.body.results[0].room_id, w.rooms.labs[0]);
});

test("no lab room in the pool: NO_ROOM_AVAILABLE explains it", async () => {
  const labsInPool = (await api("GET", `/terms/${w.termId}/rooms`)).body.rooms.filter((r) => r.is_lab);
  for (const r of labsInPool) await api("PATCH", `/terms/${w.termId}/rooms/${r.id}`, { is_lab: false });
  try {
    const r = await ops(w, [place(w, S(w, "X", "LB", "X1"), TUE, 510)]);
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "NO_ROOM_AVAILABLE");
    assert.equal(r.body.error, "No lab room is in this term's room pool. Add one on the Rooms tab.");
  } finally {
    for (const r of labsInPool) await api("PATCH", `/terms/${w.termId}/rooms/${r.id}`, { is_lab: true });
  }
});

// ------------------------------------------------------------------ lock

test("lock semantics: locked sessions refuse move/unplace/set_room/set_faculty; lock/unlock are idempotent; unlock then OK", async () => {
  const th = S(w, "X", "TH1");
  assert.equal((await ops(w, [place(w, th, MON, 510)])).status, 200);
  const rev0 = await revOf(w.versionId);
  const lock = await ops(w, [{ op: "lock", session_id: th }]);
  assert.equal(lock.status, 200);
  assert.equal(lock.body.rev, rev0 + 1);
  assert.equal(lock.body.sessions[0].locked, true);
  const again = await ops(w, [{ op: "lock", session_id: th }]);
  assert.deepEqual([again.body.rev, again.body.prev_rev, again.body.sessions], [rev0 + 1, rev0 + 1, []]);

  const room = (await dbSession(th)).room_id;
  const refused = [
    { op: "move", session_id: th, weekday: TUE, start_min: 510 },
    place(w, th, TUE, 510),
    { op: "unplace", session_id: th },
    { op: "set_room", session_id: th, room_id: w.rooms.classrooms.find((r) => r !== room) },
    { op: "set_faculty", session_id: th, faculty_ids: [w.fac.B.id] },
  ];
  for (const op of refused) {
    const r = await ops(w, [op]);
    assert.equal(r.status, 409, op.op);
    assert.equal(r.body.code, "SESSION_LOCKED");
    assert.deepEqual(r.body.details, { op_index: 0 });
  }
  assert.deepEqual((await dbSession(th)).weekday, MON);
  assert.equal(await revOf(w.versionId), rev0 + 1);

  // a locked session rejected inside a batch rolls the whole request back, with the right op_index
  const mixed = await ops(w, [{ op: "lock", session_id: S(w, "X", "TH2") }, { op: "unplace", session_id: th }]);
  assert.equal(mixed.status, 409);
  assert.deepEqual(mixed.body.details, { op_index: 1 });
  assert.equal((await dbSession(S(w, "X", "TH2"))).locked, false);

  const unlock = await ops(w, [{ op: "unlock", session_id: th }]);
  assert.equal(unlock.status, 200);
  assert.equal(unlock.body.sessions[0].locked, false);
  assert.equal((await ops(w, [{ op: "unlock", session_id: th }])).body.sessions.length, 0);
  assert.equal((await ops(w, [{ op: "move", session_id: th, weekday: TUE, start_min: 510 }])).status, 200);
  // lock and unlock never touch occupancy
  assert.equal((await occOf(th)).length, 6);
});

// ------------------------------------------------------------------ set_room

test("set_room: needs a placed session, a pool room and a free room; keeps one room occupancy row", async () => {
  const th = S(w, "X", "TH1");
  const unplaced = await ops(w, [{ op: "set_room", session_id: th, room_id: w.rooms.classrooms[0] }]);
  assert.equal(unplaced.status, 400);
  assert.equal(unplaced.body.code, "VALIDATION_ERROR");
  assert.equal(unplaced.body.error, "Place the session before choosing a room");

  assert.equal((await ops(w, [place(w, th, MON, 510, w.rooms.classrooms[0])])).status, 200);
  const y = S(w, "Y", "TH2");
  assert.equal((await ops(w, [place(w, y, MON, 510, w.rooms.classrooms[1])])).status, 200);

  const outside = await ops(w, [{ op: "set_room", session_id: th, room_id: w.rooms.outside }]);
  assert.equal(outside.status, 422);
  assert.deepEqual(outside.body.details, { op_index: 0, reason: "ROOM_NOT_IN_POOL" });

  const busy = await ops(w, [{ op: "set_room", session_id: th, room_id: w.rooms.classrooms[1] }]);
  assert.equal(busy.status, 409);
  assert.equal(busy.body.code, "CLASH");
  assert.equal(busy.body.details.conflicts.length, 1);
  assert.equal(busy.body.details.conflicts[0].kind, "room");
  assert.equal(busy.body.details.conflicts[0].session_id, y);
  assert.equal((await dbSession(th)).room_id, w.rooms.classrooms[0]);
  assert.equal((await occOf(th)).length, 6, "rows restored after the rejected change");

  const rev0 = await revOf(w.versionId);
  const same = await ops(w, [{ op: "set_room", session_id: th, room_id: w.rooms.classrooms[0] }]);
  assert.equal(same.body.sessions.length, 0);
  const free = await ops(w, [{ op: "set_room", session_id: th, room_id: w.rooms.classrooms[2] }]);
  assert.equal(free.status, 200);
  assert.equal(free.body.rev, rev0 + 1);
  assert.equal(free.body.sessions[0].room_id, w.rooms.classrooms[2]);
  const rows = await occOf(th);
  assert.deepEqual(rows.filter((x) => x.kind === "room").map((x) => x.resource_id), [w.rooms.classrooms[2]]);
  assert.equal(rows.length, 6);
});

// ------------------------------------------------------------------ all-or-nothing, rev

test("all-or-nothing: a failing 2nd op leaves the 1st unapplied and rev unchanged; ops see earlier writes", async () => {
  const x1 = S(w, "X", "TH1", "ALL", 1);
  const x2 = S(w, "X", "TH1", "ALL", 2);
  const rev0 = await revOf(w.versionId);
  const r = await ops(w, [place(w, x1, MON, 510), place(w, x2, MON, 510)]);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "CLASH");
  assert.equal(r.body.details.op_index, 1, "the second op clashes with the first one's write");
  assert.equal((await dbSession(x1)).weekday, null);
  assert.equal(await revOf(w.versionId), rev0);
  assert.equal(await occCount(w.versionId), 0);

  // several changing ops = ONE rev bump
  const ok = await ops(w, [place(w, x1, MON, 510), place(w, x2, MON, 570), { op: "lock", session_id: x1 }]);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.prev_rev, rev0);
  assert.equal(ok.body.rev, rev0 + 1);
  assert.equal(ok.body.sessions.length, 2);
  assert.equal(await revOf(w.versionId), rev0 + 1);
  assert.deepEqual(ok.body.results.map((x) => x.index), [0, 1, 2]);

  // rev goes up by exactly 1 per successful changing request
  let rev = rev0 + 1;
  for (const op of [{ op: "unlock", session_id: x1 }, { op: "move", session_id: x2, weekday: MON, start_min: 645 }, { op: "unplace", session_id: x2 }]) {
    const rr = await ops(w, [op]);
    assert.equal(rr.body.prev_rev, rev);
    assert.equal(rr.body.rev, rev + 1);
    rev += 1;
  }
  // a no-op request: same slot and room again
  const cur = await dbSession(x1);
  const noop = await ops(w, [{ op: "move", session_id: x1, weekday: cur.weekday, start_min: cur.start_min }, { op: "unlock", session_id: x1 }]);
  assert.equal(noop.status, 200);
  assert.deepEqual([noop.body.rev, noop.body.prev_rev, noop.body.sessions], [rev, rev, []]);
  assert.equal(noop.body.results.length, 2);
  assert.equal(await revOf(w.versionId), rev);
});

// ------------------------------------------------------------------ draft only

test("NOT_DRAFT: ops on a published version are refused (snapshot still reads)", async () => {
  await pool.query("UPDATE planner_versions SET status = 'published' WHERE id = $1", [w.versionId]);
  const r = await ops(w, [place(w, S(w, "X", "TH1"), MON, 510)]);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "NOT_DRAFT");
  assert.equal(r.body.success, false);
  assert.equal((await dbSession(S(w, "X", "TH1"))).weekday, null);
  const snap = await api("GET", `/versions/${w.versionId}/snapshot`);
  assert.equal(snap.status, 200);
  assert.equal(snap.body.version.status, "published");
  await pool.query("UPDATE planner_versions SET status = 'draft' WHERE id = $1", [w.versionId]);
  assert.equal((await ops(w, [place(w, S(w, "X", "TH1"), MON, 510)])).status, 200);
});

// ------------------------------------------------------------------ set_faculty (own world: it rewrites session faculty)

test("set_faculty: replaces faculty, clash-checks placed sessions, rewrites faculty occupancy, validates faculty", async () => {
  const fw = await buildWorld(api, s, { tag: "W2" });
  const th = S(fw, "X", "TH1");
  const yE = S(fw, "Y", "TH2"); // faculty E
  // unplaced: just replaces the set
  const rev0 = await revOf(fw.versionId);
  const un = await ops(fw, [{ op: "set_faculty", session_id: th, faculty_ids: [fw.fac.B.id, fw.fac.B.id, fw.fac.C.id] }]);
  assert.equal(un.status, 200);
  assert.deepEqual(un.body.sessions[0].faculty.map((f) => f.faculty_id).sort(), [fw.fac.B.id, fw.fac.C.id].sort());
  assert.equal(un.body.rev, rev0 + 1);
  assert.equal((await occOf(th)).length, 0);
  assert.equal((await ops(fw, [{ op: "set_faculty", session_id: th, faculty_ids: [fw.fac.C.id, fw.fac.B.id] }])).body.sessions.length, 0, "same set = no change");

  // placed: occupancy follows
  assert.equal((await ops(fw, [place(fw, th, MON, 510)])).status, 200);
  assert.equal((await occOf(th)).filter((x) => x.kind === "faculty").length, 2);
  assert.equal((await ops(fw, [place(fw, yE, MON, 510)])).status, 200);
  const clash = await ops(fw, [{ op: "set_faculty", session_id: th, faculty_ids: [fw.fac.E.id] }]);
  assert.equal(clash.status, 409);
  assert.equal(clash.body.code, "CLASH");
  assert.deepEqual(clash.body.details.conflicts.map((c) => [c.kind, c.resource_id, c.session_id]), [["faculty", fw.fac.E.id, yE]]);
  assert.equal(clash.body.error, `Test W2E (${s.code("W2E")}) is already teaching TH2 to Y (Sem 3) on Monday 08:30–09:30.`);
  assert.deepEqual((await occOf(th)).filter((x) => x.kind === "faculty").map((x) => x.resource_id).sort(), [fw.fac.B.id, fw.fac.C.id].sort());
  const okSet = await ops(fw, [{ op: "set_faculty", session_id: th, faculty_ids: [fw.fac.D.id] }]);
  assert.equal(okSet.status, 200);
  assert.deepEqual((await occOf(th)).filter((x) => x.kind === "faculty").map((x) => x.resource_id), [fw.fac.D.id]);

  // validation: unknown, inactive
  const ghost = await ops(fw, [{ op: "set_faculty", session_id: th, faculty_ids: [NIL] }]);
  assert.equal(ghost.status, 400);
  assert.equal(ghost.body.code, "VALIDATION_ERROR");
  const f = (await api("POST", "/faculty", { short_code: s.code("Ina"), full_name: "Inactive Person" })).body.faculty;
  await api("PATCH", `/faculty/${f.id}`, { is_active: false });
  const inactive = await ops(fw, [{ op: "set_faculty", session_id: th, faculty_ids: [f.id] }]);
  assert.equal(inactive.status, 400);
  assert.equal(inactive.body.code, "VALIDATION_ERROR");
  const snap = await api("GET", `/versions/${fw.versionId}/snapshot`);
  assert.ok(!snap.body.faculty.some((x) => x.id === f.id), "inactive faculty is not in the snapshot");
});

test("refreshSessions keeps working after sync (helper sanity)", async () => {
  await refreshSessions(w);
  assert.equal(w.sessions.size, 9);
});
