// Planner API: faculty, subjects, divisions + batches, offerings, room pool. CRUD, validation, IN_USE rules.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pool, openSessions, newUid, scope, cleanup, makeTerm, makeFaculty, someRooms, placeOneSession, fieldErrorsOf } from "./_util.js";

const s = scope(newUid());
const NIL = "00000000-0000-4000-8000-000000000000";
let sessions;
let api;
let t; // main term

before(async () => {
  sessions = await openSessions();
  api = sessions.api;
  t = await makeTerm(api, s);
});
after(() => cleanup(s, sessions));

// ------------------------------------------------------------------ faculty

test("faculty: create, case-insensitive duplicate short_code, validation", async () => {
  const a = await api("POST", "/faculty", { short_code: s.code("Fac"), full_name: "Fac One", department: "CSE", max_per_day: 4, max_per_week: 16 });
  assert.equal(a.status, 201);
  assert.equal(a.body.faculty.profile_id, null);
  assert.equal(a.body.faculty.linked_profile, null);
  assert.equal(a.body.faculty.is_active, true);

  const dup = await api("POST", "/faculty", { short_code: s.code("Fac").toLowerCase(), full_name: "Other" });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.code, "DUPLICATE");

  for (const bad of [{ full_name: "x" }, { short_code: `${s.code("B")}|x`, full_name: "x" }, { short_code: s.code("C"), full_name: "x", max_per_day: 0 },
    { short_code: s.code("D"), full_name: "x", email: "not-an-email" }]) {
    const res = await api("POST", "/faculty", bad);
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.equal(res.body.code, "VALIDATION_ERROR");
    assert.ok(Object.keys(fieldErrorsOf(res)).length);
  }
});

test("faculty: email auto-links profile_id, relinks on PATCH, unlinks, never steals a profile held by another row", async () => {
  const { rows: [profile] } = await pool.query("SELECT id, email, full_name FROM profiles WHERE email = 'priya.mehta@mitwpu.edu.in'");
  assert.ok(profile, "fixture profile exists in the local DB");

  const a = await api("POST", "/faculty", { short_code: s.code("Link"), full_name: "Link A", email: profile.email.toUpperCase() });
  assert.equal(a.status, 201);
  assert.equal(a.body.faculty.email, profile.email, "email is lower-cased");
  assert.equal(a.body.faculty.profile_id, profile.id);
  assert.deepEqual(a.body.faculty.linked_profile, { id: profile.id, full_name: profile.full_name, email: profile.email });

  // a second row with the same email must not fail (profile_id is UNIQUE) and must not steal the link
  const b = await api("POST", "/faculty", { short_code: s.code("LinkB"), full_name: "Link B", email: profile.email });
  assert.equal(b.status, 201);
  assert.equal(b.body.faculty.profile_id, null);

  const unlink = await api("PATCH", `/faculty/${a.body.faculty.id}`, { email: null });
  assert.equal(unlink.status, 200);
  assert.equal(unlink.body.faculty.profile_id, null);
  const relink = await api("PATCH", `/faculty/${b.body.faculty.id}`, { email: profile.email });
  assert.equal(relink.body.faculty.profile_id, profile.id);

  const none = await api("POST", "/faculty", { short_code: s.code("NoMatch"), full_name: "No Match", email: "nobody-at-all@mitwpu.edu.in" });
  assert.equal(none.status, 201);
  assert.equal(none.body.faculty.profile_id, null);
});

test("faculty: PATCH (incl. is_active, short_code clash) and list with assigned_in_term", async () => {
  const f = await makeFaculty(api, s, "Patch");
  const g = await makeFaculty(api, s, "Other");
  const p = await api("PATCH", `/faculty/${f.id}`, { full_name: "Renamed", is_active: false, max_per_week: 10 });
  assert.equal(p.status, 200);
  assert.equal(p.body.faculty.full_name, "Renamed");
  assert.equal(p.body.faculty.is_active, false);
  assert.equal(p.body.faculty.max_per_week, 10);
  assert.equal((await api("PATCH", `/faculty/${f.id}`, {})).status, 400);
  const clash = await api("PATCH", `/faculty/${f.id}`, { short_code: g.short_code.toUpperCase() });
  assert.equal(clash.status, 409);
  assert.equal(clash.body.code, "DUPLICATE");
  assert.equal((await api("PATCH", `/faculty/${NIL}`, { full_name: "x" })).status, 404);

  const term = await makeTerm(api, s);
  const subj = (await api("POST", `/terms/${term.id}/subjects`, { code: "AS", name: "A", kind: "theory", weekly_count: 1 })).body.subject;
  const div = (await api("POST", `/terms/${term.id}/divisions`, { semester: 3, name: "A", student_count: 10 })).body.division;
  await api("POST", `/terms/${term.id}/offerings`, { division_id: div.id, subject_id: subj.id, faculty: [{ faculty_id: f.id }, { faculty_id: g.id, role: "assist" }] });
  const inTerm = await api("GET", `/faculty?term_id=${term.id}`);
  assert.equal(inTerm.status, 200);
  assert.equal(inTerm.body.faculty.find((x) => x.id === f.id).assigned_in_term, 1);
  const other = await api("GET", `/faculty?term_id=${t.id}`);
  assert.equal(other.body.faculty.find((x) => x.id === f.id).assigned_in_term, 0);
  const global = await api("GET", "/faculty");
  assert.equal(global.body.faculty.find((x) => x.id === f.id).assigned_in_term, null);
  assert.equal((await api("GET", "/faculty?term_id=nope")).status, 400);
});

test("faculty: DELETE is 409 IN_USE while an offering references it, fine afterwards", async () => {
  const f = await makeFaculty(api, s, "Del");
  const term = await makeTerm(api, s);
  const subj = (await api("POST", `/terms/${term.id}/subjects`, { code: "FD", name: "A", kind: "theory", weekly_count: 1 })).body.subject;
  const div = (await api("POST", `/terms/${term.id}/divisions`, { semester: 3, name: "A", student_count: 10 })).body.division;
  const off = (await api("POST", `/terms/${term.id}/offerings`, { division_id: div.id, subject_id: subj.id, faculty: [{ faculty_id: f.id }] })).body.offering;
  const blocked = await api("DELETE", `/faculty/${f.id}`);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, "IN_USE");
  await api("PUT", `/terms/${term.id}/offerings/${off.id}/faculty`, { faculty: [] });
  assert.equal((await api("DELETE", `/faculty/${f.id}`)).status, 200);
  assert.equal((await api("DELETE", `/faculty/${f.id}`)).status, 404);
});

// ------------------------------------------------------------------ subjects

test("subjects: create with default durations, duplicates (case-insensitive), PATCH, validation", async () => {
  const term = await makeTerm(api, s, { theory_minutes: 50, lab_minutes: 90 });
  const th = await api("POST", `/terms/${term.id}/subjects`, { code: "DS", name: "Data Structures", kind: "theory", weekly_count: 4, semester_total: 60 });
  assert.equal(th.status, 201);
  assert.equal(th.body.subject.duration_min, 50);
  assert.equal(th.body.subject.allow_second_lab, false);
  const lab = await api("POST", `/terms/${term.id}/subjects`, { code: "DSL", name: "DS Lab", kind: "lab", weekly_count: 1 });
  assert.equal(lab.body.subject.duration_min, 90);
  const explicit = await api("POST", `/terms/${term.id}/subjects`, { code: "X", name: "X", kind: "theory", weekly_count: 1, duration_min: 45 });
  assert.equal(explicit.body.subject.duration_min, 45);

  const dup = await api("POST", `/terms/${term.id}/subjects`, { code: "ds", name: "Again", kind: "theory", weekly_count: 1 });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.code, "DUPLICATE");
  // same code in another term is fine
  assert.equal((await api("POST", `/terms/${t.id}/subjects`, { code: "DS", name: "Data Structures", kind: "theory", weekly_count: 4 })).status, 201);

  const bad = await api("POST", `/terms/${term.id}/subjects`, { code: "B", name: "B", kind: "practical", weekly_count: -1 });
  assert.equal(bad.status, 400);
  assert.ok(fieldErrorsOf(bad).kind && fieldErrorsOf(bad).weekly_count);

  const patched = await api("PATCH", `/terms/${term.id}/subjects/${th.body.subject.id}`, { weekly_count: 3, semester_total: null, allow_second_lab: true });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.subject.weekly_count, 3);
  assert.equal(patched.body.subject.semester_total, null);
  assert.equal((await api("PATCH", `/terms/${term.id}/subjects/${th.body.subject.id}`, { code: "DSL" })).status, 409);
  // a subject of another term is not reachable through this term
  assert.equal((await api("PATCH", `/terms/${t.id}/subjects/${th.body.subject.id}`, { name: "x" })).status, 404);

  const list = await api("GET", `/terms/${term.id}/subjects`);
  assert.deepEqual(list.body.subjects.map((x) => x.code), ["DS", "DSL", "X"]);
  assert.equal((await api("GET", `/terms/${NIL}/subjects`)).status, 404);
});

test("subjects: DELETE is 409 IN_USE with offerings", async () => {
  const term = await makeTerm(api, s);
  const subj = (await api("POST", `/terms/${term.id}/subjects`, { code: "U", name: "U", kind: "theory", weekly_count: 1 })).body.subject;
  const div = (await api("POST", `/terms/${term.id}/divisions`, { semester: 3, name: "A", student_count: 10 })).body.division;
  const off = (await api("POST", `/terms/${term.id}/offerings`, { division_id: div.id, subject_id: subj.id })).body.offering;
  const blocked = await api("DELETE", `/terms/${term.id}/subjects/${subj.id}`);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, "IN_USE");
  await api("DELETE", `/terms/${term.id}/offerings/${off.id}`);
  assert.equal((await api("DELETE", `/terms/${term.id}/subjects/${subj.id}`)).status, 200);
});

// ------------------------------------------------------------------ divisions + batches

test("divisions: create makes the whole batch; batches, ordering, validation", async () => {
  const term = await makeTerm(api, s);
  const d1 = await api("POST", `/terms/${term.id}/divisions`, {
    semester: 5, name: "B", student_count: 60, batches: [{ name: "B1", student_count: 20 }, { name: "B2", student_count: 20 }],
  });
  assert.equal(d1.status, 201);
  const div = d1.body.division;
  assert.deepEqual(div.batches.map((b) => [b.name, b.is_whole, b.student_count]), [["ALL", true, 60], ["B1", false, 20], ["B2", false, 20]]);

  await api("POST", `/terms/${term.id}/divisions`, { semester: 3, name: "Z", student_count: 10 });
  await api("POST", `/terms/${term.id}/divisions`, { semester: 3, name: "A", student_count: 10 });
  const list = await api("GET", `/terms/${term.id}/divisions`);
  assert.deepEqual(list.body.divisions.map((d) => `${d.semester}${d.name}`), ["3A", "3Z", "5B"]);
  assert.ok(list.body.divisions.every((d) => d.batches.filter((b) => b.is_whole).length === 1));

  const dup = await api("POST", `/terms/${term.id}/divisions`, { semester: 5, name: "b", student_count: 1 });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.code, "DUPLICATE");
  assert.equal((await api("POST", `/terms/${term.id}/divisions`, { semester: 13, name: "Q", student_count: 1 })).status, 400);
  assert.equal((await api("POST", `/terms/${term.id}/divisions`, { semester: 3, name: "Q", student_count: 1, batches: [{ name: "all", student_count: 1 }] })).status, 400);
  assert.equal((await api("POST", `/terms/${term.id}/divisions`, { semester: 3, name: "Q2", student_count: 1, batches: [{ name: "Q1" }, { name: "q1" }] })).status, 400);
  assert.equal((await api("POST", `/terms/${term.id}/divisions`, { semester: 3, name: "Q3", student_count: 1, home_room_id: NIL })).status, 400);
  const { rows: [{ n }] } = await pool.query("SELECT count(*)::int AS n FROM planner_divisions WHERE term_id = $1 AND name IN ('Q','Q2','Q3')", [term.id]);
  assert.equal(n, 0, "failed creates leave nothing behind");

  // PATCH: student_count mirrors to the whole batch; home room
  const [room] = await someRooms(1);
  const p = await api("PATCH", `/terms/${term.id}/divisions/${div.id}`, { student_count: 66, home_room_id: room });
  assert.equal(p.status, 200);
  assert.equal(p.body.division.student_count, 66);
  assert.equal(p.body.division.home_room_id, room);
  assert.equal(p.body.division.batches.find((b) => b.is_whole).student_count, 66);
  assert.equal((await api("PATCH", `/terms/${term.id}/divisions/${div.id}`, { name: "A", semester: 3 })).status, 409);
  const cleared = await api("PATCH", `/terms/${term.id}/divisions/${div.id}`, { home_room_id: null });
  assert.equal(cleared.body.division.home_room_id, null);

  // batches
  const nb = await api("POST", `/terms/${term.id}/divisions/${div.id}/batches`, { name: "B3", student_count: 20 });
  assert.equal(nb.status, 201);
  assert.equal(nb.body.batch.is_whole, false);
  assert.equal((await api("POST", `/terms/${term.id}/divisions/${div.id}/batches`, { name: "b3", student_count: 1 })).body.code, "DUPLICATE");
  assert.equal((await api("POST", `/terms/${term.id}/divisions/${div.id}/batches`, { name: "ALL", student_count: 1 })).status, 400);
  const pb = await api("PATCH", `/terms/${term.id}/divisions/${div.id}/batches/${nb.body.batch.id}`, { name: "B9", student_count: 15 });
  assert.equal(pb.status, 200);
  assert.equal(pb.body.batch.name, "B9");
  assert.equal((await api("DELETE", `/terms/${term.id}/divisions/${div.id}/batches/${nb.body.batch.id}`)).status, 200);
  assert.equal((await api("DELETE", `/terms/${term.id}/divisions/${div.id}/batches/${nb.body.batch.id}`)).status, 404);

  // the whole batch cannot be edited or deleted
  const whole = div.batches.find((b) => b.is_whole);
  const delWhole = await api("DELETE", `/terms/${term.id}/divisions/${div.id}/batches/${whole.id}`);
  assert.equal(delWhole.status, 400);
  assert.equal(delWhole.body.code, "VALIDATION_ERROR");
  assert.equal((await api("PATCH", `/terms/${term.id}/divisions/${div.id}/batches/${whole.id}`, { name: "X" })).status, 400);
  // a batch of another division is not reachable through this one
  const other = (await api("GET", `/terms/${term.id}/divisions`)).body.divisions.find((d) => d.name === "A");
  assert.equal((await api("DELETE", `/terms/${term.id}/divisions/${other.id}/batches/${div.batches[1].id}`)).status, 404);
});

test("divisions/batches: delete removes unplaced sessions, but 409 HAS_PLACED_SESSIONS when one is placed (nothing deleted)", async () => {
  const term = await makeTerm(api, s);
  const fac = await makeFaculty(api, s, "Placed");
  const th = (await api("POST", `/terms/${term.id}/subjects`, { code: "T", name: "T", kind: "theory", weekly_count: 2 })).body.subject;
  const lb = (await api("POST", `/terms/${term.id}/subjects`, { code: "L", name: "L", kind: "lab", weekly_count: 1 })).body.subject;
  const div = (await api("POST", `/terms/${term.id}/divisions`, { semester: 3, name: "A", student_count: 30, batches: [{ name: "A1", student_count: 15 }, { name: "A2", student_count: 15 }] })).body.division;
  for (const subject of [th, lb]) {
    const o = await api("POST", `/terms/${term.id}/offerings`, { division_id: div.id, subject_id: subject.id, faculty: [{ faculty_id: fac.id }] });
    assert.equal(o.status, 201);
  }
  const sync = (await api("POST", `/versions/${term.versionId}/sync-sessions`)).body;
  assert.equal(sync.added, 2 + 2, "2 theory on ALL + 1 lab per batch x 2");

  const [room] = await someRooms(1, { lab: true });
  const a1 = div.batches.find((b) => b.name === "A1");
  const a2 = div.batches.find((b) => b.name === "A2");
  const placed = await placeOneSession(term.versionId, room, `batch_id = '${a1.id}'`);
  assert.ok(placed);

  const count = async () => (await pool.query("SELECT count(*)::int AS n FROM planner_sessions WHERE version_id = $1", [term.versionId])).rows[0].n;
  // batch A1 has a placed session
  const blockedBatch = await api("DELETE", `/terms/${term.id}/divisions/${div.id}/batches/${a1.id}`);
  assert.equal(blockedBatch.status, 409);
  assert.equal(blockedBatch.body.code, "HAS_PLACED_SESSIONS");
  assert.equal(await count(), 4);
  // batch A2 has only unplaced sessions: deleted together with them
  assert.equal((await api("DELETE", `/terms/${term.id}/divisions/${div.id}/batches/${a2.id}`)).status, 200);
  assert.equal(await count(), 3);
  // the division delete is blocked as a whole, nothing removed
  const blockedDiv = await api("DELETE", `/terms/${term.id}/divisions/${div.id}`);
  assert.equal(blockedDiv.status, 409);
  assert.equal(blockedDiv.body.code, "HAS_PLACED_SESSIONS");
  assert.equal(await count(), 3);
  assert.equal((await api("GET", `/terms/${term.id}/divisions`)).body.divisions.length, 1);
  // the offering of the placed session is blocked too; the other offering is not
  const offs = (await api("GET", `/terms/${term.id}/offerings`)).body.offerings;
  const placedOffering = offs.find((o) => o.id === placed.offering_id);
  const otherOffering = offs.find((o) => o.id !== placed.offering_id);
  assert.equal((await api("DELETE", `/terms/${term.id}/offerings/${placedOffering.id}`)).body.code, "HAS_PLACED_SESSIONS");
  assert.equal((await api("DELETE", `/terms/${term.id}/offerings/${otherOffering.id}`)).status, 200);

  // unplace, then the division delete works and takes its sessions with it
  await pool.query("UPDATE planner_sessions SET weekday = NULL, start_min = NULL, end_min = NULL, room_id = NULL WHERE version_id = $1", [term.versionId]);
  assert.equal((await api("DELETE", `/terms/${term.id}/divisions/${div.id}`)).status, 200);
  assert.equal(await count(), 0);
});

// ------------------------------------------------------------------ offerings

test("offerings: create (lab defaults per_batch), cross-term rejection, duplicate, list shape and filter, PATCH, PUT faculty, delete", async () => {
  const term = await makeTerm(api, s);
  const f1 = await makeFaculty(api, s, "OfA");
  const f2 = await makeFaculty(api, s, "OfB");
  const th = (await api("POST", `/terms/${term.id}/subjects`, { code: "TH", name: "Theory", kind: "theory", weekly_count: 4 })).body.subject;
  const lb = (await api("POST", `/terms/${term.id}/subjects`, { code: "LB", name: "Lab", kind: "lab", weekly_count: 1 })).body.subject;
  const dA = (await api("POST", `/terms/${term.id}/divisions`, { semester: 3, name: "A", student_count: 30, batches: [{ name: "A1", student_count: 15 }] })).body.division;
  const dB = (await api("POST", `/terms/${term.id}/divisions`, { semester: 3, name: "B", student_count: 30 })).body.division;

  const oTh = await api("POST", `/terms/${term.id}/offerings`, { division_id: dA.id, subject_id: th.id, faculty: [{ faculty_id: f1.id }] });
  assert.equal(oTh.status, 201);
  assert.equal(oTh.body.offering.per_batch, false);
  assert.equal(oTh.body.offering.effective_weekly_count, 4);
  assert.equal(oTh.body.offering.weekly_count, null);
  assert.deepEqual(oTh.body.offering.subject, { code: "TH", name: "Theory", kind: "theory" });
  assert.equal(oTh.body.offering.faculty[0].short_code, f1.short_code);
  assert.equal(oTh.body.offering.faculty[0].role, "lead");

  const oLb = await api("POST", `/terms/${term.id}/offerings`, { division_id: dA.id, subject_id: lb.id, weekly_count: 2 });
  assert.equal(oLb.body.offering.per_batch, true, "lab subjects default to per_batch");
  assert.equal(oLb.body.offering.effective_weekly_count, 2);
  const explicit = await api("POST", `/terms/${term.id}/offerings`, { division_id: dB.id, subject_id: lb.id, per_batch: false });
  assert.equal(explicit.body.offering.per_batch, false);

  const dup = await api("POST", `/terms/${term.id}/offerings`, { division_id: dA.id, subject_id: th.id });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.code, "DUPLICATE");

  // division / subject of another term are rejected
  const otherTerm = await makeTerm(api, s);
  const oDiv = (await api("POST", `/terms/${otherTerm.id}/divisions`, { semester: 3, name: "X", student_count: 5 })).body.division;
  const oSub = (await api("POST", `/terms/${otherTerm.id}/subjects`, { code: "OX", name: "OX", kind: "theory", weekly_count: 1 })).body.subject;
  const crossDiv = await api("POST", `/terms/${term.id}/offerings`, { division_id: oDiv.id, subject_id: th.id });
  assert.equal(crossDiv.status, 400);
  assert.ok(fieldErrorsOf(crossDiv).division_id);
  const crossSub = await api("POST", `/terms/${term.id}/offerings`, { division_id: dB.id, subject_id: oSub.id });
  assert.equal(crossSub.status, 400);
  assert.ok(fieldErrorsOf(crossSub).subject_id);
  // faculty must exist, batch must belong to the division, no duplicate pairs
  assert.equal((await api("POST", `/terms/${term.id}/offerings`, { division_id: dB.id, subject_id: th.id, faculty: [{ faculty_id: NIL }] })).status, 400);
  assert.equal((await api("POST", `/terms/${term.id}/offerings`, { division_id: dB.id, subject_id: th.id, faculty: [{ faculty_id: f1.id, batch_id: dA.batches[1].id }] })).status, 400);
  assert.equal((await api("POST", `/terms/${term.id}/offerings`, { division_id: dB.id, subject_id: th.id, faculty: [{ faculty_id: f1.id }, { faculty_id: f1.id }] })).status, 400);
  const { rows: [{ n }] } = await pool.query(
    "SELECT count(*)::int AS n FROM planner_offerings o JOIN planner_divisions d ON d.id = o.division_id WHERE d.term_id = $1", [term.id]);
  assert.equal(n, 3, "failed creates leave no offering behind");

  // list: ordered by division then subject code, filter by division
  const all = await api("GET", `/terms/${term.id}/offerings`);
  assert.deepEqual(all.body.offerings.map((o) => `${o.division_id === dA.id ? "A" : "B"}-${o.subject.code}`), ["A-LB", "A-TH", "B-LB"]);
  const onlyB = await api("GET", `/terms/${term.id}/offerings?division_id=${dB.id}`);
  assert.equal(onlyB.body.offerings.length, 1);

  // PATCH
  const p = await api("PATCH", `/terms/${term.id}/offerings/${oTh.body.offering.id}`, { weekly_count: 5, per_batch: true });
  assert.equal(p.body.offering.effective_weekly_count, 5);
  assert.equal(p.body.offering.per_batch, true);
  const reset = await api("PATCH", `/terms/${term.id}/offerings/${oTh.body.offering.id}`, { weekly_count: null });
  assert.equal(reset.body.offering.effective_weekly_count, 4);
  assert.equal((await api("PATCH", `/terms/${term.id}/offerings/${oTh.body.offering.id}`, {})).status, 400);

  // PUT replaces the set
  const a1 = dA.batches.find((b) => b.name === "A1");
  const put = await api("PUT", `/terms/${term.id}/offerings/${oLb.body.offering.id}/faculty`, {
    faculty: [{ faculty_id: f1.id, batch_id: a1.id }, { faculty_id: f2.id, batch_id: a1.id, role: "assist" }, { faculty_id: f2.id }],
  });
  assert.equal(put.status, 200);
  assert.equal(put.body.success, true);
  assert.equal(put.body.offering.faculty.length, 3);
  const put2 = await api("PUT", `/terms/${term.id}/offerings/${oLb.body.offering.id}/faculty`, { faculty: [{ faculty_id: f2.id }] });
  assert.equal(put2.body.offering.faculty.length, 1);
  const bad = await api("PUT", `/terms/${term.id}/offerings/${oLb.body.offering.id}/faculty`, { faculty: [{ faculty_id: f1.id }, { faculty_id: "nope" }] });
  assert.equal(bad.status, 400);
  const after = (await api("GET", `/terms/${term.id}/offerings?division_id=${dA.id}`)).body.offerings.find((o) => o.id === oLb.body.offering.id);
  assert.equal(after.faculty.length, 1, "a failed PUT keeps the previous set");

  assert.equal((await api("DELETE", `/terms/${term.id}/offerings/${oLb.body.offering.id}`)).status, 200);
  assert.equal((await api("DELETE", `/terms/${term.id}/offerings/${oLb.body.offering.id}`)).status, 404);
});

// ------------------------------------------------------------------ rooms

test("available-rooms and the term room pool", async () => {
  const avail = await api("GET", "/available-rooms");
  assert.equal(avail.status, 200);
  assert.ok(avail.body.rooms.length > 0);
  const sample = avail.body.rooms[0];
  for (const k of ["id", "name", "building_name", "floor_number", "room_type", "capacity", "is_active"]) assert.ok(k in sample, k);
  assert.ok(avail.body.rooms.every((r) => r.is_active));

  const term = await makeTerm(api, s);
  const classroom = avail.body.rooms.find((r) => r.room_type === "classroom");
  const lab = avail.body.rooms.find((r) => r.room_type === "lab");
  const one = await api("POST", `/terms/${term.id}/rooms`, { room_id: classroom.id });
  assert.equal(one.status, 201);
  assert.equal(one.body.room.is_lab, false);
  assert.equal(one.body.room.building_name, classroom.building_name);
  assert.equal(one.body.room.floor_number, classroom.floor_number);
  const dup = await api("POST", `/terms/${term.id}/rooms`, { room_id: classroom.id });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.code, "DUPLICATE");

  const many = await api("POST", `/terms/${term.id}/rooms`, { room_ids: [classroom.id, lab.id] });
  assert.equal(many.status, 201);
  assert.equal(many.body.rooms.length, 1, "rooms already in the pool are skipped");
  assert.equal(many.body.rooms[0].is_lab, true, "is_lab defaults from room_type");

  assert.equal((await api("POST", `/terms/${term.id}/rooms`, { room_id: NIL })).status, 400);
  assert.equal((await api("POST", `/terms/${term.id}/rooms`, {})).status, 400);

  const list = await api("GET", `/terms/${term.id}/rooms`);
  assert.equal(list.body.rooms.length, 2);
  assert.equal((await api("GET", "/terms")).body.terms.find((x) => x.id === term.id).counts.rooms, 2);

  const flip = await api("PATCH", `/terms/${term.id}/rooms/${many.body.rooms[0].id}`, { is_lab: false });
  assert.equal(flip.status, 200);
  assert.equal(flip.body.room.is_lab, false);
  assert.equal((await api("PATCH", `/terms/${term.id}/rooms/${many.body.rooms[0].id}`, {})).status, 400);
  assert.equal((await api("PATCH", `/terms/${t.id}/rooms/${many.body.rooms[0].id}`, { is_lab: true })).status, 404);

  assert.equal((await api("DELETE", `/terms/${term.id}/rooms/${one.body.room.id}`)).status, 200);
  assert.equal((await api("DELETE", `/terms/${term.id}/rooms/${one.body.room.id}`)).status, 404);
  assert.equal((await api("GET", `/terms/${term.id}/rooms`)).body.rooms.length, 1);
  // the physical room itself is untouched
  const { rows } = await pool.query("SELECT 1 FROM rooms WHERE id = $1", [classroom.id]);
  assert.equal(rows.length, 1);
});
