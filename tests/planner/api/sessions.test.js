// Planner API: session sync (counts, idempotency, placed-session guard), summary/list, readiness.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pool, openSessions, newUid, scope, cleanup, makeTerm, makeFaculty, someRooms } from "./_util.js";
import { fixtureRows, importAll, importEntity, addFixturePool } from "./_fixtures.js";

const s = scope(newUid());
const NIL = "00000000-0000-4000-8000-000000000000";
let sessions;
let api;

before(async () => {
  sessions = await openSessions();
  api = sessions.api;
});
after(() => cleanup(s, sessions));

const sessionCount = async (versionId, where = "TRUE") =>
  (await pool.query(`SELECT count(*)::int AS n FROM planner_sessions WHERE version_id = $1 AND ${where}`, [versionId])).rows[0].n;
const revOf = async (versionId) => Number((await pool.query("SELECT rev FROM planner_versions WHERE id = $1", [versionId])).rows[0].rev);

test("small term: theory 4/week on the whole batch + 1 lab per batch, session faculty copied, idempotent, rev bumps only on change", async () => {
  const term = await makeTerm(api, s);
  const fa = await makeFaculty(api, s, "SyA");
  const fb = await makeFaculty(api, s, "SyB");
  const fc = await makeFaculty(api, s, "SyC");
  const th = (await api("POST", `/terms/${term.id}/subjects`, { code: "TH", name: "Theory", kind: "theory", weekly_count: 4 })).body.subject;
  const lb = (await api("POST", `/terms/${term.id}/subjects`, { code: "LB", name: "Lab", kind: "lab", weekly_count: 1 })).body.subject;
  const div = (await api("POST", `/terms/${term.id}/divisions`, {
    semester: 3, name: "A", student_count: 60, batches: [{ name: "A1", student_count: 20 }, { name: "A2", student_count: 20 }, { name: "A3", student_count: 20 }],
  })).body.division;
  const [, a1, a2, a3] = div.batches; // whole batch first, then A1..A3
  await api("POST", `/terms/${term.id}/offerings`, { division_id: div.id, subject_id: th.id, faculty: [{ faculty_id: fa.id }] });
  await api("POST", `/terms/${term.id}/offerings`, {
    division_id: div.id, subject_id: lb.id,
    faculty: [{ faculty_id: fb.id, batch_id: a1.id }, { faculty_id: fc.id, batch_id: a2.id }, { faculty_id: fc.id, batch_id: a3.id }, { faculty_id: fa.id, role: "assist" }],
  });

  assert.equal(await revOf(term.versionId), 0);
  const sync = await api("POST", `/versions/${term.versionId}/sync-sessions`);
  assert.equal(sync.status, 200);
  assert.equal(sync.body.success, true);
  assert.equal(sync.body.added, 4 + 3);
  assert.equal(sync.body.removed, 0);
  assert.equal(sync.body.kept, 0);
  assert.deepEqual(sync.body.placed_surplus, []);
  assert.deepEqual(sync.body.by_division, [{ division_id: div.id, semester: 3, name: "A", required: 7, existing: 7 }]);
  assert.equal(await revOf(term.versionId), 1);

  const list = await api("GET", `/versions/${term.versionId}/sessions`);
  assert.equal(list.status, 200);
  assert.equal(list.body.sessions.length, 7);
  const theory = list.body.sessions.filter((x) => x.subject_code === "TH");
  assert.deepEqual(theory.map((x) => [x.batch_name, x.seq]), [["ALL", 1], ["ALL", 2], ["ALL", 3], ["ALL", 4]]);
  assert.ok(theory.every((x) => x.kind === "theory" && x.duration_min === 60 && x.weekday === null && x.locked === false));
  assert.deepEqual(theory[0].faculty.map((f) => f.faculty_id), [fa.id]);
  const labs = list.body.sessions.filter((x) => x.subject_code === "LB");
  assert.deepEqual(labs.map((x) => x.batch_name), ["A1", "A2", "A3"]);
  assert.ok(labs.every((x) => x.duration_min === 120));
  // batch-specific faculty first, then the offering-wide (batch_id NULL) assistant
  assert.deepEqual(labs[0].faculty.map((f) => f.faculty_id).sort(), [fa.id, fb.id].sort());
  assert.deepEqual(labs[1].faculty.map((f) => f.faculty_id).sort(), [fa.id, fc.id].sort());
  const filtered = await api("GET", `/versions/${term.versionId}/sessions?division_id=${div.id}`);
  assert.equal(filtered.body.sessions.length, 7);
  assert.equal((await api("GET", `/versions/${term.versionId}/sessions?division_id=${NIL}`)).body.sessions.length, 0);

  const summary = await api("GET", `/versions/${term.versionId}/sessions/summary`);
  assert.equal(summary.status, 200);
  assert.equal(summary.body.rev, 1);
  assert.deepEqual(summary.body.divisions, [{ division_id: div.id, semester: 3, name: "A", required: 7, placed: 0, unplaced: 7 }]);

  // idempotent: nothing changes, rev stays
  const again = await api("POST", `/versions/${term.versionId}/sync-sessions`);
  assert.equal(again.body.added, 0);
  assert.equal(again.body.removed, 0);
  assert.equal(again.body.kept, 7);
  assert.equal(await revOf(term.versionId), 1);
  assert.equal(await sessionCount(term.versionId), 7);

  // more theory sessions: only the missing ones are added (seq 5, 6)
  const offs = (await api("GET", `/terms/${term.id}/offerings`)).body.offerings;
  const thOff = offs.find((o) => o.subject.code === "TH");
  await api("PATCH", `/terms/${term.id}/offerings/${thOff.id}`, { weekly_count: 6 });
  const more = await api("POST", `/versions/${term.versionId}/sync-sessions`);
  assert.equal(more.body.added, 2);
  assert.equal(more.body.kept, 7);
  assert.equal(await revOf(term.versionId), 2);
  // fewer again: unplaced sessions with the highest seq go first
  await api("PATCH", `/terms/${term.id}/offerings/${thOff.id}`, { weekly_count: 3 });
  const fewer = await api("POST", `/versions/${term.versionId}/sync-sessions`);
  assert.equal(fewer.body.removed, 3);
  const seqs = (await pool.query("SELECT seq FROM planner_sessions WHERE version_id = $1 AND offering_id = $2 ORDER BY seq", [term.versionId, thOff.id])).rows.map((r) => r.seq);
  assert.deepEqual(seqs, [1, 2, 3]);

  // changing the offering's faculty is reflected on its sessions by the next sync (and counts as a change)
  const revBefore = await revOf(term.versionId);
  await api("PUT", `/terms/${term.id}/offerings/${thOff.id}/faculty`, { faculty: [{ faculty_id: fb.id }] });
  const refresh = await api("POST", `/versions/${term.versionId}/sync-sessions`);
  assert.equal(refresh.body.added, 0);
  assert.equal(refresh.body.removed, 0);
  assert.equal(refresh.body.faculty_updated, 3);
  assert.equal(await revOf(term.versionId), revBefore + 1);
  const after = (await api("GET", `/versions/${term.versionId}/sessions`)).body.sessions.filter((x) => x.subject_code === "TH");
  assert.ok(after.every((x) => x.faculty.length === 1 && x.faculty[0].faculty_id === fb.id));
  assert.equal((await api("POST", `/versions/${term.versionId}/sync-sessions`)).body.faculty_updated, 0);

  // new batch on a per_batch offering: sync adds the lab session for it
  await api("POST", `/terms/${term.id}/divisions/${div.id}/batches`, { name: "A4", student_count: 5 });
  const withBatch = await api("POST", `/versions/${term.versionId}/sync-sessions`);
  assert.equal(withBatch.body.added, 1);
});

test("a division without real batches puts per_batch labs on the whole batch", async () => {
  const term = await makeTerm(api, s);
  const f = await makeFaculty(api, s, "NoB");
  const lb = (await api("POST", `/terms/${term.id}/subjects`, { code: "LB", name: "Lab", kind: "lab", weekly_count: 2 })).body.subject;
  const div = (await api("POST", `/terms/${term.id}/divisions`, { semester: 3, name: "A", student_count: 30 })).body.division;
  await api("POST", `/terms/${term.id}/offerings`, { division_id: div.id, subject_id: lb.id, faculty: [{ faculty_id: f.id }] });
  const sync = await api("POST", `/versions/${term.versionId}/sync-sessions`);
  assert.equal(sync.body.added, 2);
  const rows = (await api("GET", `/versions/${term.versionId}/sessions`)).body.sessions;
  assert.deepEqual(rows.map((x) => x.batch_name), ["ALL", "ALL"]);
});

test("sync: only drafts, 404 for unknown version, admin only", async () => {
  const term = await makeTerm(api, s);
  assert.equal((await api("POST", `/versions/${NIL}/sync-sessions`)).status, 404);
  assert.equal((await api("POST", "/versions/nope/sync-sessions")).status, 404);
  assert.equal((await api("GET", `/versions/${NIL}/sessions`)).status, 404);
  assert.equal((await api("GET", `/versions/${NIL}/sessions/summary`)).status, 404);
  assert.equal((await sessions.userApi("POST", `/versions/${term.versionId}/sync-sessions`)).status, 403);

  await pool.query("UPDATE planner_versions SET status = 'historical' WHERE id = $1", [term.versionId]);
  const res = await api("POST", `/versions/${term.versionId}/sync-sessions`);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "VALIDATION_ERROR");
  assert.equal(res.body.success, false);
});

test("sync never deletes a placed session: surplus is reported in placed_surplus", async () => {
  const term = await makeTerm(api, s);
  const f = await makeFaculty(api, s, "Guard");
  const th = (await api("POST", `/terms/${term.id}/subjects`, { code: "TH", name: "Theory", kind: "theory", weekly_count: 4 })).body.subject;
  const div = (await api("POST", `/terms/${term.id}/divisions`, { semester: 3, name: "A", student_count: 30 })).body.division;
  const off = (await api("POST", `/terms/${term.id}/offerings`, { division_id: div.id, subject_id: th.id, faculty: [{ faculty_id: f.id }] })).body.offering;
  assert.equal((await api("POST", `/versions/${term.versionId}/sync-sessions`)).body.added, 4);
  const [room] = await someRooms(1);

  // place seq 4 (the one a plain "delete the highest seq" would remove first) with a direct UPDATE
  const { rows: [placed] } = await pool.query(
    `UPDATE planner_sessions SET weekday = 1, start_min = 540, end_min = 600, room_id = $2
      WHERE version_id = $1 AND seq = 4 RETURNING id`,
    [term.versionId, room]
  );
  const summary = await api("GET", `/versions/${term.versionId}/sessions/summary`);
  assert.deepEqual([summary.body.divisions[0].placed, summary.body.divisions[0].unplaced], [1, 3]);

  // 4 -> 2: unplaced seq 3 and 2 go, placed seq 4 stays
  await api("PATCH", `/terms/${term.id}/offerings/${off.id}`, { weekly_count: 2 });
  const s1 = await api("POST", `/versions/${term.versionId}/sync-sessions`);
  assert.equal(s1.status, 200);
  assert.equal(s1.body.removed, 2);
  assert.deepEqual(s1.body.placed_surplus, []);
  assert.deepEqual((await pool.query("SELECT seq FROM planner_sessions WHERE version_id = $1 ORDER BY seq", [term.versionId])).rows.map((r) => r.seq), [1, 4]);

  // 2 -> 0: the unplaced one goes, the placed one is surplus but must survive
  await api("PATCH", `/terms/${term.id}/offerings/${off.id}`, { weekly_count: 0 });
  const s2 = await api("POST", `/versions/${term.versionId}/sync-sessions`);
  assert.equal(s2.body.removed, 1);
  assert.equal(s2.body.kept, 1);
  assert.equal(s2.body.placed_surplus.length, 1);
  assert.equal(s2.body.placed_surplus[0].offering_id, off.id);
  assert.equal(s2.body.placed_surplus[0].count, 1);
  const row = (await pool.query("SELECT weekday, start_min, end_min, room_id FROM planner_sessions WHERE id = $1", [placed.id])).rows[0];
  assert.deepEqual(row, { weekday: 1, start_min: 540, end_min: 600, room_id: room }, "placed session untouched");

  // stable on repeat; and the placed session is reported again, never deleted
  const s3 = await api("POST", `/versions/${term.versionId}/sync-sessions`);
  assert.equal(s3.body.removed, 0);
  assert.equal(s3.body.placed_surplus[0].count, 1);
  assert.equal(await sessionCount(term.versionId), 1);

  // the same guard holds when the offering is made per_batch with real batches: sessions on the whole batch become surplus
  await api("PATCH", `/terms/${term.id}/offerings/${off.id}`, { weekly_count: 1, per_batch: true });
  // Phase 2: the API refuses a new batch under a placed whole-division session (HAS_PLACED_SESSIONS) ...
  const refused = await api("POST", `/terms/${term.id}/divisions/${div.id}/batches`, { name: "A1", student_count: 10 });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "HAS_PLACED_SESSIONS");
  // ... so the batch is inserted directly to keep exercising the sync guard for data that predates that rule
  await pool.query("INSERT INTO planner_batches (division_id, name, student_count) VALUES ($1, 'A1', 10)", [div.id]);
  const s4 = await api("POST", `/versions/${term.versionId}/sync-sessions`);
  assert.equal(s4.body.added, 1, "one session for batch A1");
  assert.equal(s4.body.placed_surplus.length, 1, "the placed whole-batch session is reported, not removed");
  assert.equal(await sessionCount(term.versionId, "weekday IS NOT NULL"), 1);
});

test("readiness: errors surface through the API with plain-English messages and entity links", async () => {
  const missing = await api("GET", `/terms/${NIL}/readiness`);
  assert.equal(missing.status, 404);

  const term = await makeTerm(api, s);
  const empty = await api("GET", `/terms/${term.id}/readiness`);
  assert.equal(empty.status, 200);
  assert.equal(empty.body.success, true);
  assert.equal(empty.body.ready, false);
  assert.ok(empty.body.errors.some((e) => e.code === "NO_ROOMS_IN_POOL"));

  const f = await makeFaculty(api, s, "Rd", { max_per_week: 1 });
  const th = (await api("POST", `/terms/${term.id}/subjects`, { code: "TH", name: "Theory", kind: "theory", weekly_count: 4 })).body.subject;
  const lb = (await api("POST", `/terms/${term.id}/subjects`, { code: "LB", name: "Lab", kind: "lab", weekly_count: 1 })).body.subject;
  await api("POST", `/terms/${term.id}/subjects`, { code: "UN", name: "Unused", kind: "theory", weekly_count: 1 });
  const div = (await api("POST", `/terms/${term.id}/divisions`, { semester: 3, name: "A", student_count: 30, batches: [{ name: "A1", student_count: 15 }] })).body.division;
  const o1 = (await api("POST", `/terms/${term.id}/offerings`, { division_id: div.id, subject_id: th.id })).body.offering;
  await api("POST", `/terms/${term.id}/divisions`, { semester: 3, name: "EmptyDiv", student_count: 10 });
  await api("POST", `/terms/${term.id}/offerings`, { division_id: div.id, subject_id: lb.id, faculty: [{ faculty_id: f.id }] });

  const rd = await api("GET", `/terms/${term.id}/readiness`);
  assert.equal(rd.status, 200);
  assert.equal(rd.body.ready, false);
  assert.equal(rd.body.counts.errors, rd.body.errors.length);
  assert.equal(rd.body.counts.warnings, rd.body.warnings.length);
  const byCode = (c) => [...rd.body.errors, ...rd.body.warnings, ...rd.body.info].filter((i) => i.code === c);
  const noFac = byCode("OFFERING_NO_FACULTY")[0];
  assert.ok(noFac, "offering without faculty");
  assert.deepEqual(noFac.entity, { type: "offering", id: o1.id, tab: "offerings" });
  assert.equal(noFac.severity, "error");
  assert.ok(noFac.message.length > 10);
  assert.ok(byCode("DIVISION_NO_OFFERINGS").length, "EmptyDiv has no offerings");
  assert.equal(byCode("DIVISION_NO_OFFERINGS")[0].entity.type, "division");
  assert.ok(byCode("SUBJECT_UNUSED").length);
  assert.ok(byCode("NO_LAB_ROOM").length, "lab offering but no lab room in the pool");
  assert.ok(byCode("NO_DATES").length);
  assert.equal(rd.body.stats.divisions, 2);
  assert.equal(rd.body.stats.subjects, 3);
  assert.equal(rd.body.stats.faculty_assigned, 1);
  assert.equal(rd.body.stats.rooms, 0);
  assert.equal(rd.body.stats.teachable_minutes_per_day, 480);

  // fix: faculty on the theory offering, a dated term, rooms incl. a lab, a weekly cap that fits
  await api("PUT", `/terms/${term.id}/offerings/${o1.id}/faculty`, { faculty: [{ faculty_id: f.id }] });
  const overload = await api("GET", `/terms/${term.id}/readiness`);
  assert.ok(overload.body.errors.some((e) => e.code === "FACULTY_WEEKLY_OVERLOAD" && e.entity.type === "faculty" && e.entity.tab === "faculty"),
    "5 sessions against max_per_week 1");
  await api("PATCH", `/faculty/${f.id}`, { max_per_week: 40, max_per_day: 8 });
  const [classroom] = await someRooms(1);
  const [lab] = await someRooms(1, { lab: true });
  await api("POST", `/terms/${term.id}/rooms`, { room_ids: [classroom, lab] });
  await api("DELETE", `/terms/${term.id}/divisions/${(await api("GET", `/terms/${term.id}/divisions`)).body.divisions.find((d) => d.name === "EmptyDiv").id}`);
  const subjects = (await api("GET", `/terms/${term.id}/subjects`)).body.subjects;
  await api("DELETE", `/terms/${term.id}/subjects/${subjects.find((x) => x.code === "UN").id}`);
  const ok = await api("GET", `/terms/${term.id}/readiness`);
  assert.deepEqual(ok.body.errors, [], JSON.stringify(ok.body.errors));
  assert.equal(ok.body.ready, true);
});

test("15-division semester: import all four sheets, readiness ready, sync = 230 sessions, second sync adds 0", async () => {
  const term = await makeTerm(api, s, { start_date: "2026-07-27", end_date: "2026-11-08" });
  const rows = fixtureRows(s);
  const imp = await importAll(api, term.id, rows);
  for (const [entity, res] of Object.entries(imp)) assert.equal(res.status, 200, `${entity}: ${JSON.stringify(res.body).slice(0, 300)}`);
  await addFixturePool(api, term.id);

  const rd = await api("GET", `/terms/${term.id}/readiness`);
  assert.equal(rd.status, 200);
  assert.equal(rd.body.ready, true, JSON.stringify(rd.body.errors));
  assert.equal(rd.body.counts.errors, 0);
  assert.equal(rd.body.stats.divisions, 15);
  assert.equal(rd.body.stats.sessions_required, 230);
  assert.equal(rd.body.stats.term_weeks, 15);

  const sync = await api("POST", `/versions/${term.versionId}/sync-sessions`);
  assert.equal(sync.status, 200);
  assert.equal(sync.body.added, 230);
  assert.equal(sync.body.removed, 0);
  assert.equal(sync.body.by_division.length, 15);
  assert.equal(sync.body.by_division.reduce((n, d) => n + d.required, 0), 230);
  assert.ok(sync.body.by_division.every((d) => d.required === d.existing));
  assert.equal(await sessionCount(term.versionId), 230);
  // every session has faculty, and labs exist per batch
  const { rows: [{ n: noFaculty }] } = await pool.query(
    `SELECT count(*)::int AS n FROM planner_sessions ps WHERE ps.version_id = $1
       AND NOT EXISTS (SELECT 1 FROM planner_session_faculty f WHERE f.session_id = ps.id)`, [term.versionId]);
  assert.equal(noFaculty, 0);

  const again = await api("POST", `/versions/${term.versionId}/sync-sessions`);
  assert.equal(again.body.added, 0);
  assert.equal(again.body.removed, 0);
  assert.equal(again.body.kept, 230);
  assert.equal(await revOf(term.versionId), 1);

  const summary = await api("GET", `/versions/${term.versionId}/sessions/summary`);
  assert.equal(summary.body.divisions.length, 15);
  assert.equal(summary.body.divisions.reduce((n, d) => n + d.required, 0), 230);
  assert.equal(summary.body.divisions.reduce((n, d) => n + d.unplaced, 0), 230);
  const all = await api("GET", `/versions/${term.versionId}/sessions`);
  assert.equal(all.body.sessions.length, 230);
  assert.equal((await api("GET", "/terms")).body.terms.find((x) => x.id === term.id).counts.sessions, 230);

  // re-importing the offerings changes nothing about the sessions
  const re = await importEntity(api, term.id, "offerings", rows.offerings);
  assert.equal(re.status, 200);
  assert.equal((await api("POST", `/versions/${term.versionId}/sync-sessions`)).body.added, 0);

  // deleting the term takes everything with it (no 500) and leaves the global faculty
  await pool.query("UPDATE sessions SET reauth_at = NOW() WHERE id = $1", [sessions.admin.sessionId]);
  assert.equal((await api("DELETE", `/terms/${term.id}`)).status, 200);
  assert.equal(await sessionCount(term.versionId), 0);
  const { rows: [{ n: facultyLeft }] } = await pool.query("SELECT count(*)::int AS n FROM planner_faculty WHERE short_code LIKE $1", [`${s.prefixCode}%`]);
  assert.ok(facultyLeft >= 12);
});
