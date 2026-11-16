// GET /planner/sessions/:id/candidates and /suggestions (contract 9.4). Needs a server at BASE_URL started with
// RUN_WORKERS=false PLANNER_ENABLED=true.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { openSessions, newUid, scope, cleanup, fieldErrorsOf } from "./_util.js";
import { buildWorld, S, ops, place, MON, TUE } from "./_editorUtil.js";

const s = scope(newUid());
let sessions;
let w;

before(async () => {
  sessions = await openSessions();
  w = await buildWorld(sessions.api, s);
});
after(() => cleanup(s, sessions));

const cands = (id) => w.api("GET", `/sessions/${id}/candidates`);
const sugg = (id, q = "") => w.api("GET", `/sessions/${id}/suggestions${q}`);
const NOPE = "00000000-0000-4000-8000-000000000000";

test("unknown / malformed session ids are 404 and non-admins are refused", async () => {
  for (const id of [NOPE, "not-a-uuid"]) {
    for (const path of ["candidates", "suggestions"]) {
      const res = await w.api("GET", `/sessions/${id}/${path}`);
      assert.equal(res.status, 404, `${id} ${path}`);
      assert.equal(res.body.code, "NOT_FOUND");
    }
  }
  assert.equal((await sessions.userApi("GET", `/sessions/${S(w, "X", "TH1", "ALL", 1)}/candidates`)).status, 403);
});

test("candidates of an unplaced theory session: every slot passes the hard checks, ascending score, full shape", async () => {
  const sid = S(w, "X", "TH1", "ALL", 1);
  const res = await cands(sid);
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(typeof res.body.rev, "number");
  assert.equal(res.body.session_id, sid);
  const c = res.body.candidates;
  assert.ok(c.length > 10);
  for (const x of c) {
    assert.ok(Number.isInteger(x.weekday) && x.weekday >= 0 && x.weekday <= 6);
    assert.equal(x.end_min - x.start_min, 60);
    assert.match(x.room_id, /^[0-9a-f-]{36}$/);
    assert.equal(typeof x.room_name, "string");
    assert.equal(typeof x.score, "number");
  }
  const scores = c.map((x) => x.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => a - b));
  // the best candidate really is placeable
  const r = await ops(w, [{ op: "place", session_id: sid, weekday: c[0].weekday, start_min: c[0].start_min, room_id: c[0].room_id }]);
  assert.equal(r.status, 200, JSON.stringify(r.body));
});

test("suggestions: default 5, ops are place for an unplaced session and move for a placed one (current slot excluded)", async () => {
  const unplaced = S(w, "Y", "TH2");
  const a = await sugg(unplaced);
  assert.equal(a.status, 200);
  assert.equal(typeof a.body.rev, "number");
  assert.equal(a.body.session_id, unplaced);
  assert.equal(a.body.none_reason, undefined);
  assert.equal(a.body.suggestions.length, 5);
  for (const x of a.body.suggestions) {
    assert.equal(typeof x.reason, "string");
    assert.ok(x.reason.length > 0);
    assert.equal(typeof x.room_name, "string");
    assert.deepEqual(x.ops, [{ op: "place", session_id: unplaced, weekday: x.weekday, start_min: x.start_min, room_id: x.room_id }]);
  }
  const scores = a.body.suggestions.map((x) => x.score);
  assert.deepEqual(scores, [...scores].sort((p, q) => p - q));
  // the first suggestion's ops are directly applicable
  const ap = await ops(w, a.body.suggestions[0].ops);
  assert.equal(ap.status, 200, JSON.stringify(ap.body));

  const b = await sugg(unplaced, "?limit=3");
  assert.equal(b.body.suggestions.length, 3);
  for (const x of b.body.suggestions) {
    assert.equal(x.ops[0].op, "move");
    assert.ok(!(x.weekday === a.body.suggestions[0].weekday && x.start_min === a.body.suggestions[0].start_min));
  }
});

test("limit validation: 1..20, whole numbers only (400 with fieldErrors.limit); 20 is accepted", async () => {
  const sid = S(w, "X", "TH2");
  for (const bad of ["0", "21", "abc", "-1", "2.5", ""]) {
    const res = await sugg(sid, `?limit=${bad}`);
    assert.equal(res.status, 400, `limit=${bad}`);
    assert.equal(res.body.code, "VALIDATION_ERROR");
    assert.ok(fieldErrorsOf(res).limit, `limit=${bad}`);
  }
  const one = await sugg(sid, "?limit=1");
  assert.equal(one.body.suggestions.length, 1);
  const max = await sugg(sid, "?limit=20");
  assert.equal(max.status, 200);
  assert.ok(max.body.suggestions.length <= 20 && max.body.suggestions.length > 5);
});

test("a lab session is suggested on its own, in a lab room", async () => {
  const sid = S(w, "X", "LB", "X2");
  const res = await sugg(sid, "?limit=3");
  assert.equal(res.status, 200);
  assert.ok(res.body.suggestions.length > 0);
  for (const x of res.body.suggestions) {
    assert.equal(x.end_min - x.start_min, 120);
    assert.ok(w.rooms.labs.includes(x.room_id), "lab room");
    assert.equal(x.ops.length, 1);
    assert.equal(x.ops[0].session_id, sid);
  }
});

test("a locked session has no suggestions: none_reason LOCKED with slot counts", async () => {
  const sid = S(w, "X", "TH1", "ALL", 2);
  const placed = await ops(w, [place(w, sid, TUE, 510, w.rooms.classrooms[0]), { op: "lock", session_id: sid }]);
  assert.equal(placed.status, 200, JSON.stringify(placed.body));
  const res = await sugg(sid);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.suggestions, []);
  assert.equal(res.body.none_reason.code, "LOCKED");
  assert.equal(typeof res.body.none_reason.text, "string");
  for (const k of ["total", "free", "faculty", "batch", "room"]) assert.equal(typeof res.body.none_reason.slots[k], "number", k);
  // candidates still answer (read-only, any state)
  assert.equal((await cands(sid)).status, 200);
});

test("suggestions are read-only: nothing moved and rev unchanged", async () => {
  const sid = S(w, "Y", "TH1", "ALL", 2);
  const a = await sugg(sid);
  const b = await sugg(sid);
  assert.equal(a.body.rev, b.body.rev);
  assert.deepEqual(a.body.suggestions, b.body.suggestions);
  const snap = await w.api("GET", `/versions/${w.versionId}/snapshot`);
  assert.equal(snap.body.rev, b.body.rev);
  assert.equal(snap.body.sessions.find((x) => x.id === sid).weekday, null);
  assert.ok(MON === 0);
});
