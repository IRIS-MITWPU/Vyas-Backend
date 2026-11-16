// Planner Phase 2 amendment (contract 8.7): lab rooms are shared by capacity.
// Own scenario (no breaks, so labs can overlap partially at any quarter hour):
//   labs LA, LB2 (capacity 62), classrooms CA, CB (capacity 60); subject LB (lab 120 min), TH (theory 60 min);
//   divisions D1..D3 (60 students, two batches of 30), D4 (60 students, no batches -> whole-batch lab of 60).
//   LB faculty: D1 P1=F1 P2=F2 | D2 Q1=F1 Q2=F3 | D3 R1=F4 R2=F5 | D4 F9;  TH faculty: D1 F6, D2 F7, D3 F8.
// Times are minutes (540 = 09:00); a lab runs 120 minutes, a lecture 60.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { pool, openSessions, newUid, scope, cleanup, makeTerm, makeFaculty } from "./_util.js";
import { MON, TUE, ops, place, revOf, occCount, occOf, dbSession, resetWorld, roomName } from "./_editorUtil.js";

const s = scope(newUid());
let sessions;
let api;
let w;

const T9 = 540;
const T = (h, m = 0) => h * 60 + m;

async function buildShareWorld() {
  const term = await makeTerm(api, s, { breaks: [] });
  const fac = {};
  for (let i = 1; i <= 9; i++) fac[`F${i}`] = await makeFaculty(api, s, `F${i}`);
  const labs = (await pool.query("SELECT id FROM rooms WHERE is_active AND room_type = 'lab' AND capacity = 62 ORDER BY name LIMIT 2")).rows.map((r) => r.id);
  const classrooms = (await pool.query("SELECT id FROM rooms WHERE is_active AND room_type = 'classroom' AND capacity >= 60 ORDER BY name LIMIT 2")).rows.map((r) => r.id);
  assert.equal(labs.length, 2, "need two 62-seat labs in the dev DB");
  assert.equal(classrooms.length, 2, "need two 60+ seat classrooms in the dev DB");
  const add = await api("POST", `/terms/${term.id}/rooms`, { room_ids: [...labs, ...classrooms] });
  assert.equal(add.status, 201, JSON.stringify(add.body));
  const poolRows = (await api("GET", `/terms/${term.id}/rooms`)).body.rooms;

  const mk = async (body) => (await api("POST", `/terms/${term.id}/subjects`, body)).body.subject;
  const LB = await mk({ code: "LB", name: "Lab", kind: "lab", weekly_count: 1 });
  const TH = await mk({ code: "TH", name: "Theory", kind: "theory", weekly_count: 1 });

  const div = async (name, batches) => {
    const r = await api("POST", `/terms/${term.id}/divisions`, { semester: 3, name, student_count: 60, ...(batches ? { batches: batches.map((n) => ({ name: n, student_count: 30 })) } : {}) });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.division;
  };
  const D1 = await div("D1", ["P1", "P2"]);
  const D2 = await div("D2", ["Q1", "Q2"]);
  const D3 = await div("D3", ["R1", "R2"]);
  const D4 = await div("D4", null);
  const bt = (d) => Object.fromEntries(d.batches.map((b) => [b.name, b.id]));
  const off = async (d, subject, faculty) => {
    const r = await api("POST", `/terms/${term.id}/offerings`, { division_id: d.id, subject_id: subject.id, faculty });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  };
  const f = (n, extra = {}) => ({ faculty_id: fac[n].id, ...extra });
  await off(D1, LB, [f("F1", { batch_id: bt(D1).P1 }), f("F2", { batch_id: bt(D1).P2 })]);
  await off(D2, LB, [f("F1", { batch_id: bt(D2).Q1 }), f("F3", { batch_id: bt(D2).Q2 })]);
  await off(D3, LB, [f("F4", { batch_id: bt(D3).R1 }), f("F5", { batch_id: bt(D3).R2 })]);
  await off(D4, LB, [f("F9")]);
  await off(D1, TH, [f("F6")]);
  await off(D2, TH, [f("F7")]);
  await off(D3, TH, [f("F8")]);
  const sync = await api("POST", `/versions/${term.versionId}/sync-sessions`);
  assert.equal(sync.body.added, 10, JSON.stringify(sync.body));

  const ses = new Map();
  for (const d of [D1, D2, D3, D4]) {
    const r = await api("GET", `/versions/${term.versionId}/sessions?division_id=${d.id}`);
    for (const x of r.body.sessions) ses.set(`${d.name}/${x.subject_code}/${x.batch_name}`, x.id);
  }
  return { term, termId: term.id, versionId: term.versionId, api, fac, rooms: { LA: labs[0], LB2: labs[1], CA: classrooms[0], CB: classrooms[1] }, poolRows, ses, divs: { D1, D2, D3, D4 } };
}

/** Session id: sid('D1','LB','P1'); lectures use batch 'ALL'. */
const sid = (div, code, batch = "ALL") => {
  const id = w.ses.get(`${div}/${code}/${batch}`);
  if (!id) throw new Error(`no session ${div}/${code}/${batch}`);
  return id;
};
const P1 = () => sid("D1", "LB", "P1");
const P2 = () => sid("D1", "LB", "P2");
const Q1 = () => sid("D2", "LB", "Q1");
const Q2 = () => sid("D2", "LB", "Q2");
const R1 = () => sid("D3", "LB", "R1");
const R2 = () => sid("D3", "LB", "R2");

const roomRows = async (sessionId) => (await occOf(sessionId)).filter((x) => x.kind === "room" || x.kind === "lab_room").map((x) => [x.kind, x.resource_id]);
const facName = (n) => `Test ${n} (${s.code(n)})`;

before(async () => {
  sessions = await openSessions();
  api = sessions.api;
  w = await buildShareWorld();
});
after(() => cleanup(s, sessions));
beforeEach(() => resetWorld(w));

const at = (sessionId, wd, start, room) => place(w, sessionId, wd, start, room);

// ------------------------------------------------------------------ the happy path

test("two 30-student batch labs of different divisions share a 62-seat lab: both succeed, two lab_room rows, no clash", async () => {
  const { LA } = w.rooms;
  const rev0 = await revOf(w.versionId);
  const a = await ops(w, [at(P1(), MON, T9, LA)]);
  const b = await ops(w, [at(R1(), MON, T9, LA)]);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(b.status, 200, JSON.stringify(b.body));
  assert.equal(b.body.rev, rev0 + 2);
  assert.deepEqual(b.body.results, [{ index: 0, session_id: R1(), room_id: LA }]);
  assert.deepEqual(await roomRows(P1()), [["lab_room", LA]]);
  assert.deepEqual(await roomRows(R1()), [["lab_room", LA]]);
  assert.equal(await occCount(w.versionId, "kind = 'lab_room' AND resource_id = $2", [LA]), 2);
  assert.equal(await occCount(w.versionId, "kind = 'room'"), 0);
  // every other row is the usual exclusive kind: 1 faculty + 1 batch (+ the shared room row) per lab
  for (const id of [P1(), R1()]) {
    const kinds = (await occOf(id)).map((x) => x.kind).sort();
    assert.deepEqual(kinds, ["batch", "faculty", "lab_room"]);
  }
  // the public session shape is unchanged
  assert.equal(a.body.sessions[0].room_id, LA);
  assert.equal(Object.hasOwn(a.body.sessions[0], "shared_room"), false);
});

test("a whole request may place both labs; two batches of ONE division may also share the room", async () => {
  const { LA } = w.rooms;
  const both = await ops(w, [at(P1(), TUE, T9, LA), at(P2(), TUE, T9, LA)]);
  assert.equal(both.status, 200, JSON.stringify(both.body));
  assert.equal(both.body.sessions.length, 2);
  assert.equal(await occCount(w.versionId, "kind = 'lab_room' AND resource_id = $2", [LA]), 2);
});

test("a third 30-student batch in the full room and time: 409 CLASH with reason ROOM_CAPACITY and the capacity sentence", async () => {
  const { LA } = w.rooms;
  assert.equal((await ops(w, [at(P1(), MON, T9, LA)])).status, 200);
  assert.equal((await ops(w, [at(R1(), MON, T9, LA)])).status, 200);
  const rev0 = await revOf(w.versionId);
  const r = await ops(w, [at(Q2(), MON, T9, LA)]);
  assert.equal(r.status, 409);
  assert.equal(r.body.success, false);
  assert.equal(r.body.code, "CLASH");
  const text = `Room ${await roomName(LA)} (capacity 62) would hold 90 students on Monday 09:00–11:00; it already has LB for D1 (Sem 3) batch P1 (30 students) and LB for D3 (Sem 3) batch R1 (30 students).`;
  assert.equal(r.body.error, text);
  assert.equal(r.body.details.op_index, 0);
  assert.equal(r.body.details.reason, "ROOM_CAPACITY");
  assert.equal(r.body.details.conflicts.length, 1);
  const c = r.body.details.conflicts[0];
  assert.deepEqual(Object.keys(c).sort(), ["kind", "resource_id", "resource_name", "session_id", "text"]);
  assert.equal(c.kind, "room", "the frontend types only know 'room'");
  assert.equal(c.resource_id, LA);
  assert.equal(c.resource_name, await roomName(LA));
  assert.equal(c.text, text);
  assert.ok([P1(), R1()].includes(c.session_id));
  assert.equal(await revOf(w.versionId), rev0, "nothing written");
  assert.equal((await occOf(Q2())).length, 0);
  assert.equal((await dbSession(Q2())).weekday, null);
  assert.equal(JSON.stringify(r.body).includes("planner_occupancy"), false, "no raw database text");
});

test("capacity rejection inside a batch of ops rolls everything back and reports the op index", async () => {
  const { LA } = w.rooms;
  const rev0 = await revOf(w.versionId);
  const r = await ops(w, [at(P1(), MON, T9, LA), at(R1(), MON, T9, LA), at(Q2(), MON, T9, LA)]);
  assert.equal(r.status, 409);
  assert.equal(r.body.details.op_index, 2);
  assert.equal(r.body.details.reason, "ROOM_CAPACITY");
  assert.equal(await revOf(w.versionId), rev0);
  assert.equal(await occCount(w.versionId), 0);
  assert.equal((await dbSession(P1())).weekday, null);
});

test("the whole batch of a division without batches counts as the division's students (60 + 30 > 62)", async () => {
  const { LA } = w.rooms;
  const whole = sid("D4", "LB", "ALL");
  assert.equal((await ops(w, [at(whole, MON, T9, LA)])).status, 200, "a lone 60-student lab fits");
  assert.deepEqual(await roomRows(whole), [["lab_room", LA]]);
  const r = await ops(w, [at(P1(), MON, T9, LA)]);
  assert.equal(r.status, 409);
  assert.equal(r.body.details.reason, "ROOM_CAPACITY");
  assert.equal(r.body.error, `Room ${await roomName(LA)} (capacity 62) would hold 90 students on Monday 09:00–11:00; it already has LB for D4 (Sem 3) (60 students).`);
  // and the other way round: the 60-student lab does not fit next to a 30-student one
  await resetWorld(w);
  assert.equal((await ops(w, [at(P1(), MON, T9, LA)])).status, 200);
  const back = await ops(w, [at(whole, MON, T9, LA)]);
  assert.equal(back.status, 409);
  assert.equal(back.body.details.reason, "ROOM_CAPACITY");
});

// ------------------------------------------------------------------ peak concurrency over partially overlapping ranges

test("partial overlaps: the PEAK load decides, not the sum of everything that overlaps (this term has no breaks)", async () => {
  const { LA } = w.rooms;
  // A 09:00-11:00 (P1), C 11:00-13:00 (R1): back to back, each 30
  assert.equal((await ops(w, [at(P1(), MON, T(9), LA)])).status, 200);
  assert.equal((await ops(w, [at(R1(), MON, T(11), LA)])).status, 200);
  // B 10:00-12:00 (P2) overlaps BOTH but never at the same time as both: peak 60 <= 62 -> fits (a naive sum would be 90)
  const b = await ops(w, [at(P2(), MON, T(10), LA)]);
  assert.equal(b.status, 200, JSON.stringify(b.body));
  assert.equal(await occCount(w.versionId, "kind = 'lab_room' AND resource_id = $2", [LA]), 3);
  // D 10:30-12:30 (R2): during 10:30-11:00 A + B + D = 90 -> rejected, and the sentence lists the real neighbours
  const d = await ops(w, [at(R2(), MON, T(10, 30), LA)]);
  assert.equal(d.status, 409);
  assert.equal(d.body.details.reason, "ROOM_CAPACITY");
  assert.match(d.body.error, /would hold 90 students on Monday 10:30–12:30; it already has /);
  assert.equal((await occOf(R2())).length, 0);
  // E 12:00-14:00 (R2 again) only meets C (11:00-13:00) and nothing else: peak 60 -> fits
  const e = await ops(w, [at(R2(), MON, T(12), LA)]);
  assert.equal(e.status, 200, JSON.stringify(e.body));
});

test("partial overlaps: adjacent labs (half-open ranges) never add up, one quarter hour of overlap with a full room does", async () => {
  const { LA } = w.rooms;
  assert.equal((await ops(w, [at(P1(), MON, T(9), LA), at(R1(), MON, T(9), LA)])).status, 200); // 60 until 11:00
  assert.equal((await ops(w, [at(Q2(), MON, T(11), LA)])).status, 200, "starts exactly when the others end");
  const over = await ops(w, [at(R2(), MON, T(10, 45), LA)]); // 10:45-12:45 overlaps 10:45-11:00 with the 60 and the Q2
  assert.equal(over.status, 409);
  assert.equal(over.body.details.reason, "ROOM_CAPACITY");
});

// ------------------------------------------------------------------ exclusive vs shared

test("exclusive vs shared: a lecture in a lab room that hosts a shared lab clashes, and the other way round", async () => {
  const { LA } = w.rooms;
  // shared first, lecture (D2 TH, 60 students) second: the existing room sentence, holder = the lab
  assert.equal((await ops(w, [at(P1(), MON, T9, LA)])).status, 200);
  const lec = await ops(w, [at(sid("D2", "TH"), MON, T9, LA)]);
  assert.equal(lec.status, 409);
  assert.equal(lec.body.code, "CLASH");
  assert.equal(lec.body.details.reason, undefined, "exclusive-vs-shared mixes are plain room clashes");
  assert.deepEqual(lec.body.details.conflicts.map((c) => c.kind), ["room"]);
  assert.equal(lec.body.error, `Room ${await roomName(LA)} is already used by LB for D1 (Sem 3) batch P1 on Monday 09:00–11:00.`);
  // a lecture later than the lab is fine
  assert.equal((await ops(w, [at(sid("D2", "TH"), MON, T(11), LA)])).status, 200);
  // lecture first, shared lab second
  await resetWorld(w);
  assert.equal((await ops(w, [at(sid("D2", "TH"), MON, T9, LA)])).status, 200);
  const lab = await ops(w, [at(P1(), MON, T(9, 30), LA)]);
  assert.equal(lab.status, 409);
  assert.equal(lab.body.details.reason, undefined);
  assert.equal(lab.body.error, `Room ${await roomName(LA)} is already used by TH for D2 (Sem 3) on Monday 09:00–10:00.`);
  assert.equal((await ops(w, [at(P1(), MON, T(10), LA)])).status, 200, "back to back with the lecture");
});

test("a shared lab and an exclusive session that touch only part of the lab's time still clash (partial overlap, exclusive side)", async () => {
  const { LA } = w.rooms;
  assert.equal((await ops(w, [at(P1(), MON, T(9), LA)])).status, 200); // 09:00-11:00
  const r = await ops(w, [at(sid("D3", "TH"), MON, T(10, 30), LA)]);
  assert.equal(r.status, 409);
  assert.deepEqual(r.body.details.conflicts.map((c) => c.kind), ["room"]);
});

test("a lab in a classroom (is_lab false) is exclusive, and so is a lab in a lab room the term marks as a non-lab", async () => {
  const { CA, LB2 } = w.rooms;
  assert.equal((await ops(w, [at(P1(), MON, T9, CA)])).status, 200);
  assert.deepEqual(await roomRows(P1()), [["room", CA]]);
  const second = await ops(w, [at(R1(), MON, T9, CA)]);
  assert.equal(second.status, 409);
  assert.equal(second.body.details.reason, undefined, "a classroom is never a capacity case");
  assert.equal(second.body.error, `Room ${await roomName(CA)} is already used by LB for D1 (Sem 3) batch P1 on Monday 09:00–11:00.`);

  // flip the pool row of a REAL lab room to is_lab = false: labs there are exclusive as well
  const row = w.poolRows.find((r) => r.room_id === LB2);
  assert.equal((await api("PATCH", `/terms/${w.termId}/rooms/${row.id}`, { is_lab: false })).status, 200);
  try {
    assert.equal((await ops(w, [at(R1(), TUE, T9, LB2)])).status, 200);
    assert.deepEqual(await roomRows(R1()), [["room", LB2]]);
    const clash = await ops(w, [at(P2(), TUE, T9, LB2)]);
    assert.equal(clash.status, 409);
    assert.equal(clash.body.details.reason, undefined);
    // flipping is_lab back is refused while a session is placed in the room (LOCKED_BY_PLACEMENTS) ...
    const refused = await api("PATCH", `/terms/${w.termId}/rooms/${row.id}`, { is_lab: true });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, "LOCKED_BY_PLACEMENTS");
  } finally {
    // ... so unplace first, then restore
    await ops(w, [{ op: "unplace", session_id: R1() }]);
    assert.equal((await api("PATCH", `/terms/${w.termId}/rooms/${row.id}`, { is_lab: true })).status, 200);
  }
});

// ------------------------------------------------------------------ faculty inside a shared room

test("faculty clashes are still enforced inside a shared room (the same teacher on both batches)", async () => {
  const { LA } = w.rooms;
  assert.equal((await ops(w, [at(P1(), MON, T9, LA)])).status, 200); // F1
  const r = await ops(w, [at(Q1(), MON, T(10), LA)]); // F1 again, room would fit (30 + 30)
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "CLASH");
  assert.equal(r.body.details.reason, undefined);
  assert.deepEqual(r.body.details.conflicts.map((c) => [c.kind, c.resource_id]), [["faculty", w.fac.F1.id]]);
  assert.equal(r.body.error, `${facName("F1")} is already teaching LB to D1 (Sem 3) batch P1 on Monday 09:00–11:00.`);
  // a different teacher is fine
  assert.equal((await ops(w, [at(Q2(), MON, T(10), LA)])).status, 200);
  // set_faculty on a placed shared lab: the clash is found, the shared room row survives the rewrite
  const sf = await ops(w, [{ op: "set_faculty", session_id: Q2(), faculty_ids: [w.fac.F1.id] }]);
  assert.equal(sf.status, 409);
  assert.deepEqual(sf.body.details.conflicts.map((c) => c.kind), ["faculty"]);
  assert.deepEqual(await roomRows(Q2()), [["lab_room", LA]]);
  const ok = await ops(w, [{ op: "set_faculty", session_id: Q2(), faculty_ids: [w.fac.F7.id, w.fac.F3.id] }]);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(await roomRows(Q2()), [["lab_room", LA]], "set_faculty keeps the shared kind");
  assert.equal((await occOf(Q2())).filter((x) => x.kind === "faculty").length, 2);
});

// ------------------------------------------------------------------ auto room pick

test("auto-pick packs the next lab batch into the room already in use while it fits, and another lab when it is full", async () => {
  const { LA, LB2 } = w.rooms; // LA sorts before LB2 by name
  const first = await ops(w, [place(w, P1(), MON, T9)]);
  const second = await ops(w, [place(w, R1(), MON, T9)]);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.results[0].room_id, LA, "empty labs: smallest capacity, then name");
  assert.equal(second.body.results[0].room_id, LA, "fullest room that still fits: packed together");
  const third = await ops(w, [place(w, Q2(), MON, T9)]);
  assert.equal(third.status, 200, JSON.stringify(third.body));
  assert.equal(third.body.results[0].room_id, LB2, "LA holds 60 of 62: the third batch moves to the other lab");
  const fourth = await ops(w, [place(w, P2(), MON, T9)]);
  assert.equal(fourth.body.results[0].room_id, LB2, "and the fourth packs into that second lab");
  assert.equal(await occCount(w.versionId, "kind = 'lab_room' AND resource_id = $2", [LA]), 2);
  assert.equal(await occCount(w.versionId, "kind = 'lab_room' AND resource_id = $2", [LB2]), 2);
  // a fifth cannot go anywhere: both labs hold 60 of 62
  const fifth = await ops(w, [place(w, R2(), MON, T9)]);
  assert.equal(fifth.status, 409);
  assert.equal(fifth.body.code, "NO_ROOM_AVAILABLE");
  assert.equal(fifth.body.error, "No lab has space for 30 more students at that time.");
  assert.deepEqual(fifth.body.details, { op_index: 0 });
});

test("auto-pick: a session already in a shared lab keeps it when moved to a slot where it still fits", async () => {
  const { LA } = w.rooms;
  assert.equal((await ops(w, [place(w, P1(), MON, T9)])).body.results[0].room_id, LA);
  assert.equal((await ops(w, [place(w, R1(), TUE, T9)])).body.results[0].room_id, LA);
  const mv = await ops(w, [{ op: "move", session_id: P1(), weekday: TUE, start_min: T9 }]);
  assert.equal(mv.status, 200, JSON.stringify(mv.body));
  assert.equal(mv.body.results[0].room_id, LA, "30 + 30 fits: the current room is kept");
  assert.equal(await occCount(w.versionId, "kind = 'lab_room' AND resource_id = $2 AND weekday = 1", [LA]), 2);
  // add a third lab to Tuesday auto: LA is at 60, so it goes elsewhere
  assert.notEqual((await ops(w, [place(w, Q2(), TUE, T9)])).body.results[0].room_id, LA);
});

// ------------------------------------------------------------------ moving between shared and exclusive rooms

test("move / set_room / unplace rewrite the room row kind (verified in planner_occupancy)", async () => {
  const { LA, CA } = w.rooms;
  assert.equal((await ops(w, [at(P1(), MON, T9, LA)])).status, 200);
  assert.deepEqual(await roomRows(P1()), [["lab_room", LA]]);
  // lab room -> classroom via move: lab_room -> room
  assert.equal((await ops(w, [{ op: "move", session_id: P1(), weekday: MON, start_min: T9, room_id: CA }])).status, 200);
  assert.deepEqual(await roomRows(P1()), [["room", CA]]);
  // classroom -> lab room via set_room: room -> lab_room
  assert.equal((await ops(w, [{ op: "set_room", session_id: P1(), room_id: LA }])).status, 200);
  assert.deepEqual(await roomRows(P1()), [["lab_room", LA]]);
  // a plain move to another slot keeps the shared kind
  assert.equal((await ops(w, [{ op: "move", session_id: P1(), weekday: TUE, start_min: T(10) }])).status, 200);
  assert.deepEqual(await roomRows(P1()), [["lab_room", LA]]);
  assert.equal((await occOf(P1())).every((x) => x.weekday === TUE && x.start_min === T(10) && x.end_min === T(12)), true);
  // set_room into a classroom that is busy -> room clash; the old shared row is restored
  assert.equal((await ops(w, [at(sid("D3", "TH"), TUE, T(10), CA)])).status, 200);
  const busy = await ops(w, [{ op: "set_room", session_id: P1(), room_id: CA }]);
  assert.equal(busy.status, 409);
  assert.deepEqual(await roomRows(P1()), [["lab_room", LA]]);
  // unplace removes every row
  assert.equal((await ops(w, [{ op: "unplace", session_id: P1() }])).status, 200);
  assert.equal((await occOf(P1())).length, 0);
  // set_room INTO a shared lab is capacity checked: fill LA with 60, then try a third
  assert.equal((await ops(w, [at(R1(), MON, T9, LA), at(Q2(), MON, T9, LA)])).status, 200);
  assert.equal((await ops(w, [at(P2(), MON, T9, CA)])).status, 200);
  const full = await ops(w, [{ op: "set_room", session_id: P2(), room_id: LA }]);
  assert.equal(full.status, 409);
  assert.equal(full.body.details.reason, "ROOM_CAPACITY");
  assert.deepEqual(await roomRows(P2()), [["room", CA]], "the session stays in its classroom");
});

test("a shared lab room can be freed again: after unplacing one batch a third fits", async () => {
  const { LA } = w.rooms;
  assert.equal((await ops(w, [at(P1(), MON, T9, LA), at(R1(), MON, T9, LA)])).status, 200);
  assert.equal((await ops(w, [at(Q2(), MON, T9, LA)])).status, 409);
  assert.equal((await ops(w, [{ op: "unplace", session_id: P1() }])).status, 200);
  assert.equal((await ops(w, [at(Q2(), MON, T9, LA)])).status, 200);
});

// ------------------------------------------------------------------ concurrency

test("concurrency: two parallel lab places that together exceed the capacity -> exactly one wins (version lock + pre-check)", async () => {
  const { LA } = w.rooms;
  for (let round = 0; round < 3; round++) {
    await resetWorld(w);
    assert.equal((await ops(w, [at(P1(), MON, T9, LA)])).status, 200);
    const rev0 = await revOf(w.versionId);
    const [a, b] = await Promise.all([ops(w, [at(R1(), MON, T9, LA)]), ops(w, [at(R2(), MON, T9, LA)])]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409], `round ${round}: ${JSON.stringify([a.body, b.body])}`);
    const loser = a.status === 409 ? a : b;
    assert.equal(loser.body.code, "CLASH");
    assert.equal(loser.body.details.reason, "ROOM_CAPACITY");
    assert.equal(await revOf(w.versionId), rev0 + 1);
    assert.equal(await occCount(w.versionId, "kind = 'lab_room' AND resource_id = $2", [LA]), 2, "60 of 62, never 90");
  }
});

test("concurrency: two parallel auto-picked labs next to one placed lab end up in different rooms, both succeed", async () => {
  const { LA, LB2 } = w.rooms;
  assert.equal((await ops(w, [at(P1(), MON, T9, LA)])).status, 200);
  const [a, b] = await Promise.all([ops(w, [place(w, R1(), MON, T9)]), ops(w, [place(w, R2(), MON, T9)])]);
  assert.deepEqual([a.status, b.status], [200, 200], JSON.stringify([a.body, b.body]));
  assert.deepEqual([a.body.results[0].room_id, b.body.results[0].room_id].sort(), [LA, LB2].sort());
  const { rows } = await pool.query(
    `SELECT resource_id, count(*)::int AS n FROM planner_occupancy WHERE version_id = $1 AND kind = 'lab_room' GROUP BY 1`, [w.versionId]
  );
  assert.ok(rows.every((r) => r.n <= 2));
});

// ------------------------------------------------------------------ housekeeping

test("occupancy of the world stays consistent: no row for unplaced sessions, no overlapping exclusive rows", async () => {
  const { LA } = w.rooms;
  assert.equal((await ops(w, [at(P1(), MON, T9, LA), at(R1(), MON, T9, LA), at(sid("D1", "TH"), TUE, T9, w.rooms.CA)])).status, 200);
  const { rows: [r] } = await pool.query(
    `SELECT count(*) FILTER (WHERE s.weekday IS NULL)::int AS orphan,
            (SELECT count(*)::int FROM planner_occupancy a JOIN planner_occupancy b
               ON a.version_id = b.version_id AND a.kind = b.kind AND a.resource_id = b.resource_id AND a.weekday = b.weekday
              AND a.during && b.during AND a.id <> b.id WHERE a.version_id = $1 AND a.kind <> 'lab_room') AS exclusive_overlaps
       FROM planner_occupancy o JOIN planner_sessions s ON s.id = o.session_id WHERE o.version_id = $1`,
    [w.versionId]
  );
  assert.deepEqual(r, { orphan: 0, exclusive_overlaps: 0 });
});

// ------------------------------------------------------------------ a session bigger than the room on its own

test("a lab whose own students exceed the room capacity is rejected even when the room is empty (ROOM_CAPACITY, no 'already has' part)", async () => {
  const { LA } = w.rooms;
  const { rows: [small] } = await pool.query(
    "SELECT id, name FROM rooms WHERE is_active AND room_type = 'lab' AND capacity BETWEEN 30 AND 40 ORDER BY name LIMIT 1"
  );
  assert.ok(small, "need a small lab (capacity 30-40) in the dev DB");
  const cap = (await pool.query("SELECT capacity FROM rooms WHERE id = $1", [small.id])).rows[0].capacity;
  const added = await api("POST", `/terms/${w.termId}/rooms`, { room_id: small.id, is_lab: true });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  try {
    const whole = sid("D4", "LB", "ALL"); // 60 students
    const rev0 = await revOf(w.versionId);
    const r = await ops(w, [at(whole, MON, T9, small.id)]);
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.code, "CLASH");
    assert.equal(r.body.details.reason, "ROOM_CAPACITY");
    assert.equal(r.body.error, `Room ${small.name} (capacity ${cap}) would hold 60 students on Monday 09:00–11:00.`);
    assert.deepEqual(r.body.details.conflicts.map((c) => [c.kind, c.resource_id, c.session_id]), [["room", small.id, whole]]);
    assert.equal(await revOf(w.versionId), rev0);
    assert.equal((await occOf(whole)).length, 0);
    // the same lab in a big enough room is fine; set_room into the small one is rejected and the session stays put
    assert.equal((await ops(w, [at(whole, MON, T9, LA)])).status, 200);
    const sr = await ops(w, [{ op: "set_room", session_id: whole, room_id: small.id }]);
    assert.equal(sr.status, 409);
    assert.equal(sr.body.details.reason, "ROOM_CAPACITY");
    assert.deepEqual(await roomRows(whole), [["lab_room", LA]]);
    // a 30-student batch fits a 30-seat room exactly; a second one does not
    await resetWorld(w);
    assert.equal((await ops(w, [at(P1(), MON, T9, small.id)])).status, 200);
    // auto pick never offers the small room to the 60-student lab, so it lands in a 62-seat lab
    const auto = await ops(w, [place(w, whole, TUE, T9)]);
    assert.equal(auto.status, 200, JSON.stringify(auto.body));
    assert.equal(auto.body.results[0].room_id, LA);
    // a classroom stays unchecked (not shareable): a lab in a classroom is exclusive, capacity is not compared
    assert.equal((await ops(w, [at(R1(), MON, T9, w.rooms.CA)])).status, 200);
  } finally {
    await resetWorld(w);
    const row = (await api("GET", `/terms/${w.termId}/rooms`)).body.rooms.find((x) => x.room_id === small.id);
    if (row) await api("DELETE", `/terms/${w.termId}/rooms/${row.id}`);
  }
});
