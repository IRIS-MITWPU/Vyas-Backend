// Planner API: regressions found in code review (breaks lock compare, sync vs placed sessions,
// faculty delete message, readiness gaps). Import-related fixes are tested in import.test.js.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pool, openSessions, newUid, scope, cleanup, makeTerm, makeFaculty, someRooms, placeOneSession } from "./_util.js";

const s = scope(newUid());
let sessions;
let api;

before(async () => {
  sessions = await openSessions();
  api = sessions.api;
});
after(() => cleanup(s, sessions));

const sf = async (sessionId) =>
  (await pool.query("SELECT faculty_id FROM planner_session_faculty WHERE session_id = $1 ORDER BY faculty_id", [sessionId])).rows.map((r) => r.faculty_id);
const revOf = async (versionId) => Number((await pool.query("SELECT rev FROM planner_versions WHERE id = $1", [versionId])).rows[0].rev);

async function termWithSessions(name, weekly) {
  const t = await makeTerm(api, s);
  const fac = await makeFaculty(api, s, name);
  const subj = (await api("POST", `/terms/${t.id}/subjects`, { code: "RF", name: "Review subject", kind: "theory", weekly_count: weekly })).body.subject;
  const div = (await api("POST", `/terms/${t.id}/divisions`, { semester: 3, name: "R-A", student_count: 30 })).body.division;
  const off = (await api("POST", `/terms/${t.id}/offerings`, { division_id: div.id, subject_id: subj.id, faculty: [{ faculty_id: fac.id }] })).body.offering;
  const sync = await api("POST", `/versions/${t.versionId}/sync-sessions`);
  assert.equal(sync.status, 200);
  assert.equal(sync.body.added, weekly);
  return { t, fac, off, div };
}

test("PATCH /terms: re-sending identical breaks (any key or list order) is not LOCKED_BY_PLACEMENTS; a changed break is", async () => {
  const { t } = await termWithSessions("Brk", 2);
  const [room] = await someRooms(1);
  await placeOneSession(t.versionId, room);

  // jsonb stores keys as label, end_min, start_min: sending them in API order used to look like a change
  const stored = (await api("GET", `/terms/${t.id}`)).body.term.breaks;
  assert.equal(stored.length, 3);
  const sameOrder = [
    { start_min: 630, end_min: 645, label: "Short break 1" },
    { start_min: 765, end_min: 810, label: "Lunch" },
    { start_min: 930, end_min: 945, label: "Short break 2" },
  ];
  const same = await api("PATCH", `/terms/${t.id}`, { breaks: sameOrder });
  assert.equal(same.status, 200, JSON.stringify(same.body));
  assert.equal((await api("PATCH", `/terms/${t.id}`, { breaks: stored })).status, 200, "the stored shape, echoed back");
  assert.equal((await api("PATCH", `/terms/${t.id}`, { breaks: [...sameOrder].reverse() })).status, 200, "list order is not a change");

  const moved = await api("PATCH", `/terms/${t.id}`, { breaks: [{ ...sameOrder[0], end_min: 660 }, sameOrder[1], sameOrder[2]] });
  assert.equal(moved.status, 409);
  assert.equal(moved.body.code, "LOCKED_BY_PLACEMENTS");
  assert.deepEqual(moved.body.details.fields, ["breaks"]);
  const relabelled = await api("PATCH", `/terms/${t.id}`, { breaks: [{ ...sameOrder[0], label: "Tea" }, sameOrder[1], sameOrder[2]] });
  assert.equal(relabelled.status, 409);
  assert.equal((await api("PATCH", `/terms/${t.id}`, { breaks: sameOrder.slice(0, 2) })).status, 409, "a removed break is a change");
  const unchanged = (await api("GET", `/terms/${t.id}`)).body.term.breaks;
  assert.equal(unchanged.length, 3, "nothing was written by the refused patches");
});

test("sync-sessions refreshes faculty of unplaced sessions only: a placed session keeps its faculty and does not move rev", async () => {
  const { t, fac, off } = await termWithSessions("Plc", 2);
  const other = await makeFaculty(api, s, "PlcB");
  const [room] = await someRooms(1);
  const placed = await placeOneSession(t.versionId, room, "seq = 1");
  const { rows: [unplaced] } = await pool.query("SELECT id FROM planner_sessions WHERE version_id = $1 AND weekday IS NULL", [t.versionId]);
  assert.deepEqual(await sf(placed.id), [fac.id]);

  // the offering now has someone else
  assert.equal((await api("PUT", `/terms/${t.id}/offerings/${off.id}/faculty`, { faculty: [{ faculty_id: other.id }] })).status, 200);
  const rev0 = await revOf(t.versionId);
  const sync = await api("POST", `/versions/${t.versionId}/sync-sessions`);
  assert.equal(sync.status, 200);
  assert.equal(sync.body.faculty_updated, 1, "only the unplaced session was refreshed");
  assert.deepEqual(await sf(unplaced.id), [other.id]);
  assert.deepEqual(await sf(placed.id), [fac.id], "placed session untouched");
  assert.equal(await revOf(t.versionId), rev0 + 1);

  // now only the placed session is out of date: nothing happens and rev stays
  await pool.query("UPDATE planner_sessions SET weekday = 2, start_min = 600, end_min = 660, room_id = $2 WHERE id = $1", [unplaced.id, room]);
  assert.equal((await api("PUT", `/terms/${t.id}/offerings/${off.id}/faculty`, { faculty: [{ faculty_id: fac.id }] })).status, 200);
  const rev1 = await revOf(t.versionId);
  const again = await api("POST", `/versions/${t.versionId}/sync-sessions`);
  assert.equal(again.status, 200);
  assert.equal(again.body.faculty_updated, 0);
  assert.equal(again.body.added + again.body.removed, 0);
  assert.equal(again.body.rev, rev1);
  assert.equal(await revOf(t.versionId), rev1, "rev not bumped for a placed session");
  assert.deepEqual(await sf(unplaced.id), [other.id], "placed (now both) sessions keep the faculty they had");
  assert.deepEqual(await sf(placed.id), [fac.id]);
});

test("DELETE /faculty: when only generated sessions still reference the faculty, 409 IN_USE says so", async () => {
  const { t, fac, off } = await termWithSessions("Del", 1);
  // remove the offering assignment; the generated session still carries the faculty
  assert.equal((await api("PUT", `/terms/${t.id}/offerings/${off.id}/faculty`, { faculty: [] })).status, 200);
  const refs = await pool.query("SELECT (SELECT count(*)::int FROM planner_offering_faculty WHERE faculty_id = $1) AS o, (SELECT count(*)::int FROM planner_session_faculty WHERE faculty_id = $1) AS s", [fac.id]);
  assert.deepEqual(refs.rows[0], { o: 0, s: 1 });
  const blocked = await api("DELETE", `/faculty/${fac.id}`);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, "IN_USE");
  assert.match(blocked.body.error, /offerings or generated sessions/);
  assert.deepEqual(blocked.body.details, { offerings: 0, sessions: 1 });

  // a plain offering reference gets the same accurate wording
  const f2 = await makeFaculty(api, s, "Del2");
  await api("PUT", `/terms/${t.id}/offerings/${off.id}/faculty`, { faculty: [{ faculty_id: f2.id }] });
  const blocked2 = await api("DELETE", `/faculty/${f2.id}`);
  assert.equal(blocked2.status, 409);
  assert.equal(blocked2.body.code, "IN_USE");
  assert.match(blocked2.body.error, /offerings or generated sessions/);

  // after the next sync the stale session assignment is gone and the first faculty can be deleted
  assert.equal((await api("POST", `/versions/${t.versionId}/sync-sessions`)).status, 200);
  assert.equal((await api("DELETE", `/faculty/${fac.id}`)).status, 200);
});

test("readiness: an empty term is not ready (NO_DIVISIONS); NO_CLASSROOM_ROOM when only lab rooms are pooled", async () => {
  const empty = await makeTerm(api, s);
  const e = await api("GET", `/terms/${empty.id}/readiness`);
  assert.equal(e.status, 200);
  assert.equal(e.body.ready, false);
  const nd = e.body.errors.find((i) => i.code === "NO_DIVISIONS");
  assert.ok(nd, "NO_DIVISIONS reported");
  assert.deepEqual(nd.entity, { type: "term", id: empty.id, tab: "divisions" });

  const { t } = await termWithSessions("Rdy", 1);
  const [lab] = await someRooms(1, { lab: true });
  const [classroom] = await someRooms(1);
  await api("POST", `/terms/${t.id}/rooms`, { room_ids: [lab] });
  const labOnly = await api("GET", `/terms/${t.id}/readiness`);
  assert.ok(!labOnly.body.errors.some((i) => i.code === "NO_DIVISIONS"), "a term with divisions has no NO_DIVISIONS");
  const w = labOnly.body.warnings.find((i) => i.code === "NO_CLASSROOM_ROOM");
  assert.ok(w, "warning when no non-lab room is pooled");
  assert.deepEqual(w.entity, { type: "term", id: t.id, tab: "rooms" });

  await api("POST", `/terms/${t.id}/rooms`, { room_ids: [classroom] });
  const both = await api("GET", `/terms/${t.id}/readiness`);
  assert.ok(![...both.body.errors, ...both.body.warnings, ...both.body.info].some((i) => i.code === "NO_CLASSROOM_ROOM"));
  assert.equal(both.body.ready, true, JSON.stringify(both.body.errors));
});
