// Planner Phase 2 API: clash detection (sentences, whole-division vs batch rules, assist faculty), concurrency,
// the structural guards (new batch / subject duration while placed) and cascade of occupancy with the term.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { pool, openSessions, newUid, scope, cleanup } from "./_util.js";
import {
  MON, TUE, WED, buildWorld, S, ops, place, revOf, occCount, occOf, dbSession, resetWorld, roomName,
} from "./_editorUtil.js";

const s = scope(newUid());
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

const facName = (n) => `Test ${n} (${s.code(n)})`;

test("faculty clash: exact sentence, details shape, nothing written", async () => {
  const xth = S(w, "X", "TH1");
  assert.equal((await ops(w, [place(w, xth, MON, 510, w.rooms.classrooms[0])])).status, 200);
  const rev0 = await revOf(w.versionId);
  // Y.TH1 is also taught by A; give it its own room so only the faculty clashes
  const r = await ops(w, [place(w, S(w, "Y", "TH1"), MON, 540, w.rooms.classrooms[2])]);
  assert.equal(r.status, 409);
  assert.equal(r.body.success, false);
  assert.equal(r.body.code, "CLASH");
  const text = `${facName("A")} is already teaching TH1 to X (Sem 3) on Monday 08:30–09:30.`;
  assert.equal(r.body.error, text);
  assert.deepEqual(r.body.details, {
    op_index: 0,
    conflicts: [{ kind: "faculty", resource_id: w.fac.A.id, resource_name: facName("A"), session_id: xth, text }],
  });
  assert.equal(await revOf(w.versionId), rev0);
  assert.equal(await occCount(w.versionId, "session_id = $2", [S(w, "Y", "TH1")]), 0);
});

test("room clash and multi-conflict: ALL conflicts are listed, error is the first sentence", async () => {
  const xth = S(w, "X", "TH1");
  const room = w.rooms.classrooms[0];
  assert.equal((await ops(w, [place(w, xth, MON, 510, room)])).status, 200);
  // different faculty and division: only the room clashes
  const roomOnly = await ops(w, [place(w, S(w, "Y", "TH2"), MON, 510, room)]);
  assert.equal(roomOnly.status, 409);
  const name = await roomName(room);
  const roomText = `Room ${name} is already used by TH1 for X (Sem 3) on Monday 08:30–09:30.`;
  assert.equal(roomOnly.body.error, roomText);
  assert.deepEqual(roomOnly.body.details.conflicts, [{ kind: "room", resource_id: room, resource_name: name, session_id: xth, text: roomText }]);
  // same faculty (A) and same room: two conflicts, faculty first
  const both = await ops(w, [place(w, S(w, "Y", "TH1"), MON, 510, room)]);
  assert.equal(both.status, 409);
  assert.deepEqual(both.body.details.conflicts.map((c) => c.kind), ["faculty", "room"]);
  assert.equal(both.body.error, both.body.details.conflicts[0].text);
  assert.equal(both.body.error, `${facName("A")} is already teaching TH1 to X (Sem 3) on Monday 08:30–09:30.`);
  assert.equal(both.body.details.conflicts[1].text, roomText);
});

test("batch clash: a whole-division lecture and a batch lab of that division cannot overlap, in either order; sentences", async () => {
  const lec = S(w, "X", "TH1");
  const lab = S(w, "X", "LB", "X1");
  // lecture first, then the lab of batch X1 (different faculty and room)
  assert.equal((await ops(w, [place(w, lec, WED, 510)])).status, 200);
  const a = await ops(w, [place(w, lab, WED, 510, w.rooms.labs[0])]);
  assert.equal(a.status, 409);
  assert.equal(a.body.code, "CLASH");
  assert.equal(a.body.error, "X (Sem 3) already has TH1 on Wednesday 08:30–09:30.");
  assert.deepEqual(a.body.details.conflicts.map((c) => [c.kind, c.session_id]), [["batch", lec]]);
  assert.equal(a.body.details.conflicts[0].resource_name, "X (Sem 3) batch X1");
  assert.ok([w.bx.X1.id].includes(a.body.details.conflicts[0].resource_id));
  // lab first, then the whole-division lecture: sentence names the batch of the holder
  await resetWorld(w);
  assert.equal((await ops(w, [place(w, lab, WED, 510, w.rooms.labs[0])])).status, 200);
  const b = await ops(w, [place(w, lec, WED, 540)]);
  assert.equal(b.status, 409);
  assert.equal(b.body.error, "X (Sem 3) batch X1 already has LB on Wednesday 08:30–10:30.");
  assert.deepEqual(b.body.details.conflicts.map((c) => c.kind), ["batch"]);
  // a lecture of ANOTHER division does not care
  assert.equal((await ops(w, [place(w, S(w, "Y", "TH1"), WED, 510)])).status, 200);
});

test("whole-division lecture vs several batch labs: every holder is reported once", async () => {
  assert.equal((await ops(w, [place(w, S(w, "X", "LB", "X1"), TUE, 510)])).status, 200);
  assert.equal((await ops(w, [place(w, S(w, "X", "LB", "X2"), TUE, 510)])).status, 200);
  const r = await ops(w, [place(w, S(w, "X", "TH1"), TUE, 510)]);
  assert.equal(r.status, 409);
  const conflicts = r.body.details.conflicts;
  assert.equal(conflicts.length, 2);
  assert.deepEqual(conflicts.map((c) => c.kind), ["batch", "batch"]);
  assert.deepEqual(conflicts.map((c) => c.session_id).sort(), [S(w, "X", "LB", "X1"), S(w, "X", "LB", "X2")].sort());
});

test("two batch labs of one division in parallel are allowed (different faculty and rooms), same-room or same-faculty are not", async () => {
  const [l1, l2] = w.rooms.labs;
  const a = await ops(w, [place(w, S(w, "X", "LB", "X1"), TUE, 645, l1), place(w, S(w, "X", "LB", "X2"), TUE, 645, l2)]);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(a.body.sessions.length, 2);
  assert.equal(a.body.rev, a.body.prev_rev + 1);
  // each lab has exactly its own batch row
  assert.deepEqual((await occOf(S(w, "X", "LB", "X1"))).filter((x) => x.kind === "batch").map((x) => x.resource_id), [w.bx.X1.id]);
  assert.deepEqual((await occOf(S(w, "X", "LB", "X2"))).filter((x) => x.kind === "batch").map((x) => x.resource_id), [w.bx.X2.id]);
  // third batch in the same lab room: CHANGED by contract 8.7 (was a room clash). Labs share a lab room by capacity:
  // X1 (8) + X3 (8) fit the 30-seat lab, so this is accepted and both rows are the shared kind
  const sameRoom = await ops(w, [place(w, S(w, "X", "LB", "X3"), TUE, 645, l1)]);
  assert.equal(sameRoom.status, 200, JSON.stringify(sameRoom.body));
  assert.deepEqual(
    (await occOf(S(w, "X", "LB", "X3"))).filter((x) => x.kind === "room" || x.kind === "lab_room").map((x) => [x.kind, x.resource_id]),
    [["lab_room", l1]],
  );
  // a faculty member cannot be in two labs: put X1's lead C on X3 via set_faculty while both are placed.
  // Moving X3 into a classroom turns its room row back into the exclusive kind.
  const free = await ops(w, [place(w, S(w, "X", "LB", "X3"), TUE, 645, w.rooms.classrooms[0])]);
  assert.equal(free.status, 200, "a manually chosen non-lab room is accepted in Phase 2");
  assert.deepEqual(
    (await occOf(S(w, "X", "LB", "X3"))).filter((x) => x.kind === "room" || x.kind === "lab_room").map((x) => [x.kind, x.resource_id]),
    [["room", w.rooms.classrooms[0]]],
  );
  const sf = await ops(w, [{ op: "set_faculty", session_id: S(w, "X", "LB", "X3"), faculty_ids: [w.fac.C.id] }]);
  assert.equal(sf.status, 409);
  assert.equal(sf.body.details.conflicts[0].kind, "faculty");
  assert.equal(sf.body.details.conflicts[0].session_id, S(w, "X", "LB", "X1"));
});

test("back-to-back is allowed (half-open ranges), one minute of overlap is not", async () => {
  // same faculty A in two divisions, 08:30-09:30 then 09:30-10:30
  assert.equal((await ops(w, [place(w, S(w, "X", "TH1"), MON, 510)])).status, 200);
  assert.equal((await ops(w, [place(w, S(w, "Y", "TH1"), MON, 570)])).status, 200);
  // same division consecutive too
  assert.equal((await ops(w, [place(w, S(w, "X", "TH2"), MON, 645)])).status, 200);
  assert.equal((await ops(w, [place(w, S(w, "X", "TH1", "ALL", 2), MON, 705)])).status, 200);
  // 09:15 start (15-minute grid) overlaps the 08:30-09:30 lecture by 15 minutes
  const over = await ops(w, [place(w, S(w, "Y", "TH1", "ALL", 2), MON, 555)]);
  assert.equal(over.status, 409);
});

test("assist faculty take part in clash detection (in both directions)", async () => {
  // X1's lab: lead C, assist E. Y.TH2 is taught by E.
  const lab = S(w, "X", "LB", "X1");
  assert.equal((await ops(w, [place(w, lab, TUE, 645, w.rooms.labs[0])])).status, 200);
  const r = await ops(w, [place(w, S(w, "Y", "TH2"), TUE, 645, w.rooms.classrooms[0])]);
  assert.equal(r.status, 409);
  assert.equal(r.body.error, `${facName("E")} is already teaching LB to X (Sem 3) batch X1 on Tuesday 10:45–12:45.`);
  assert.deepEqual(r.body.details.conflicts.map((c) => [c.kind, c.resource_id]), [["faculty", w.fac.E.id]]);
  // reverse order
  await resetWorld(w);
  assert.equal((await ops(w, [place(w, S(w, "Y", "TH2"), TUE, 705, w.rooms.classrooms[0])])).status, 200);
  const back = await ops(w, [place(w, lab, TUE, 645, w.rooms.labs[0])]);
  assert.equal(back.status, 409);
  assert.equal(back.body.error, `${facName("E")} is already teaching TH2 to Y (Sem 3) on Tuesday 11:45–12:45.`);
});

test("concurrency: two places for the same faculty and slot on different sessions -> exactly one 200, one 409 CLASH, one set of rows", async () => {
  for (let round = 0; round < 3; round++) {
    await resetWorld(w);
    const a = S(w, "X", "TH1");
    const b = S(w, "Y", "TH1"); // both taught by A
    const rev0 = await revOf(w.versionId);
    const [ra, rb] = await Promise.all([ops(w, [place(w, a, MON, 510)]), ops(w, [place(w, b, MON, 510)])]);
    const statuses = [ra.status, rb.status].sort();
    assert.deepEqual(statuses, [200, 409], `round ${round}: ${JSON.stringify([ra.body, rb.body])}`);
    const [won, lost] = ra.status === 200 ? [a, b] : [b, a];
    const loser = ra.status === 200 ? rb : ra;
    assert.equal(loser.body.code, "CLASH");
    assert.equal(await revOf(w.versionId), rev0 + 1);
    assert.ok((await occOf(won)).length > 0);
    assert.equal((await occOf(lost)).length, 0);
    assert.equal(await occCount(w.versionId, "kind = 'faculty' AND resource_id = $2", [w.fac.A.id]), 1);
    assert.equal((await dbSession(lost)).weekday, null);
  }
});

test("concurrency: many parallel requests on one version stay serial and consistent (rev == successes)", async () => {
  const sessionsToPlace = [S(w, "X", "TH1", "ALL", 1), S(w, "X", "TH1", "ALL", 2), S(w, "X", "TH2"), S(w, "Y", "TH1", "ALL", 1), S(w, "Y", "TH1", "ALL", 2), S(w, "Y", "TH2")];
  const rev0 = await revOf(w.versionId);
  // all six at the same Monday slot: X ones clash with each other (batch), Y ones too, A is shared -> at most one wins in
  // each division and A is a single resource, so exactly one wins overall... except Y.TH2 (faculty E) vs X.TH2 (B)
  const res = await Promise.all(sessionsToPlace.map((id) => ops(w, [place(w, id, MON, 510)])));
  const okCount = res.filter((r) => r.status === 200).length;
  assert.ok(res.every((r) => r.status === 200 || r.status === 409), JSON.stringify(res.map((r) => r.status)));
  assert.equal(await revOf(w.versionId), rev0 + okCount);
  assert.equal(okCount, 2, `okCount ${okCount}`); // exactly one winner per division (whole batch), A is shared but X.TH2/Y.TH2 use B/E
  // no two sessions share a resource at the same time (exclusion constraint + pre-check agree)
  const { rows: dup } = await pool.query(
    `SELECT 1 FROM planner_occupancy a JOIN planner_occupancy b
       ON a.version_id = b.version_id AND a.kind = b.kind AND a.resource_id = b.resource_id AND a.weekday = b.weekday
      AND a.during && b.during AND a.id <> b.id WHERE a.version_id = $1`,
    [w.versionId]
  );
  assert.equal(dup.length, 0);
});

// ------------------------------------------------------------------ guards

test("guard: a new batch under a division with placed whole-division sessions -> 409 HAS_PLACED_SESSIONS; allowed after unplacing", async () => {
  const lec = S(w, "X", "TH1");
  assert.equal((await ops(w, [place(w, lec, MON, 510)])).status, 200);
  const blocked = await api("POST", `/terms/${w.termId}/divisions/${w.X.id}/batches`, { name: "X4", student_count: 6 });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, "HAS_PLACED_SESSIONS");
  const names = (await api("GET", `/terms/${w.termId}/divisions`)).body.divisions.find((d) => d.id === w.X.id).batches.map((b) => b.name);
  assert.ok(!names.includes("X4"));
  // a division whose only placed session is a batch lab may get a batch? the rule is about WHOLE sessions: Y has none
  const fine = await api("POST", `/terms/${w.termId}/divisions/${w.Y.id}/batches`, { name: "Y1", student_count: 6 });
  assert.equal(fine.status, 201);
  await api("DELETE", `/terms/${w.termId}/divisions/${w.Y.id}/batches/${fine.body.batch.id}`);

  // import (dry run and real): a NEW batch row is an error, an existing batch row is fine
  const rows = [
    { semester: 3, division: "X", student_count: 24, batch: "X1", batch_size: 8 },
    { semester: 3, division: "X", student_count: 24, batch: "X9", batch_size: 4 },
  ];
  const dry = await api("POST", `/terms/${w.termId}/import/divisions?dryRun=true`, { rows });
  assert.equal(dry.status, 200);
  assert.equal(dry.body.summary.error, 1);
  assert.notEqual(dry.body.rows[0].status, "error");
  assert.equal(dry.body.rows[1].status, "error");
  assert.equal(dry.body.rows[1].errors[0].field, "batch");
  const real = await api("POST", `/terms/${w.termId}/import/divisions?dryRun=false`, { rows });
  assert.equal(real.status, 422);
  assert.equal(real.body.code, "IMPORT_HAS_ERRORS");
  assert.equal((await api("POST", `/terms/${w.termId}/import/divisions?dryRun=false`, { rows: rows.slice(0, 1) })).status, 200);

  assert.equal((await ops(w, [{ op: "unplace", session_id: lec }])).status, 200);
  const ok = await api("POST", `/terms/${w.termId}/divisions/${w.X.id}/batches`, { name: "X4", student_count: 6 });
  assert.equal(ok.status, 201);
  const real2 = await api("POST", `/terms/${w.termId}/import/divisions?dryRun=false`, { rows });
  assert.equal(real2.status, 200);
  // restore the world's batch structure for the following tests
  await api("DELETE", `/terms/${w.termId}/divisions/${w.X.id}/batches/${ok.body.batch.id}`);
  const x9 = (await api("GET", `/terms/${w.termId}/divisions`)).body.divisions.find((d) => d.id === w.X.id).batches.find((b) => b.name === "X9");
  await api("DELETE", `/terms/${w.termId}/divisions/${w.X.id}/batches/${x9.id}`);
});

test("guard: subject duration cannot change while a session of it is placed (PATCH and import); other fields can", async () => {
  const th1 = w.subj.TH1;
  assert.equal((await ops(w, [place(w, S(w, "X", "TH1"), MON, 510)])).status, 200);
  const blocked = await api("PATCH", `/terms/${w.termId}/subjects/${th1.id}`, { duration_min: 90 });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, "LOCKED_BY_PLACEMENTS");
  assert.equal((await api("GET", `/terms/${w.termId}/subjects`)).body.subjects.find((x) => x.id === th1.id).duration_min, 60);
  // same value and other fields are fine
  assert.equal((await api("PATCH", `/terms/${w.termId}/subjects/${th1.id}`, { duration_min: 60, name: "Theory One!" })).status, 200);
  // a subject without placed sessions can change
  assert.equal((await api("PATCH", `/terms/${w.termId}/subjects/${w.subj.TH3.id}`, { duration_min: 90 })).status, 200);
  // the import path is guarded as well
  const imp = await api("POST", `/terms/${w.termId}/import/subjects?dryRun=false`, {
    rows: [{ code: "TH1", name: "Theory One", kind: "theory", weekly_count: 2, duration_min: 45 }],
  });
  assert.equal(imp.status, 422);
  assert.equal(imp.body.code, "IMPORT_HAS_ERRORS");
  assert.equal(imp.body.rows[0].errors[0].field, "duration_min");
  const impDry = await api("POST", `/terms/${w.termId}/import/subjects?dryRun=true`, {
    rows: [{ code: "TH1", name: "Theory One", kind: "theory", weekly_count: 2, duration_min: 45 }],
  });
  assert.equal(impDry.status, 200);
  assert.equal(impDry.body.summary.error, 1, "the dry run predicts the failure");
  // unplaced -> allowed (and the placement rule uses the new duration)
  await resetWorld(w);
  assert.equal((await api("PATCH", `/terms/${w.termId}/subjects/${th1.id}`, { duration_min: 90 })).status, 200);
  const r = await ops(w, [place(w, S(w, "X", "TH1"), MON, 510)]);
  assert.equal(r.status, 200);
  assert.equal(r.body.sessions[0].end_min, 600);
  assert.equal(r.body.sessions[0].duration_min, 90);
  await resetWorld(w);
  await api("PATCH", `/terms/${w.termId}/subjects/${th1.id}`, { duration_min: 60 });
});

// ------------------------------------------------------------------ cascade

test("deleting a term cascades its occupancy rows", async () => {
  const cw = await buildWorld(api, s, { tag: "Cw" });
  const r = await ops(cw, [place(cw, S(cw, "X", "TH1"), MON, 510), place(cw, S(cw, "X", "LB", "X1"), TUE, 510)]);
  assert.equal(r.status, 200);
  assert.ok((await occCount(cw.versionId)) > 0);
  const del = await api("DELETE", `/terms/${cw.termId}`);
  assert.equal(del.status, 200);
  assert.equal(await occCount(cw.versionId), 0);
  const { rows: [{ n }] } = await pool.query("SELECT count(*)::int AS n FROM planner_occupancy WHERE version_id = $1", [cw.versionId]);
  assert.equal(n, 0);
});
