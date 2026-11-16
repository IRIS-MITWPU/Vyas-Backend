// Service-level tests of applyPlacements (contract 9.5): the bulk commit path of the generator / regenerate / undo.
// There is no route for it, so the test imports services/planner/editor.js directly (same local DB as the server);
// the fixtures are built through the real API like the other editor tests (a server must be running at BASE_URL,
// started with RUN_WORKERS=false PLANNER_ENABLED=true). Everything is namespaced zz_planner_test_<uid> and removed
// in cleanup().
//
// World (see _editorUtil.js): division X (3 batches X1-X3, 8 students each) and Y; sessions
//   X: TH1#1 TH1#2 (A), TH2#1 (B) on the whole batch; LB on X1 (C lead + E assist), X2 (D), X3 (F)
//   Y: TH1#1 TH1#2 (A), TH2#1 (E).   Default grid: day 08:30 (510) .. 17:45 (1065), breaks 630-645, 765-810, 930-945.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { pool, openSessions, newUid, scope, cleanup } from "./_util.js";
import { MON, TUE, WED, buildWorld, refreshSessions, S, resetWorld, revOf, occCount, occOf, dbSession } from "./_editorUtil.js";
import { applyPlacements } from "../../../services/planner/editor.js";

const s = scope(newUid());
let sessions;
let w;

before(async () => {
  sessions = await openSessions();
  w = await buildWorld(sessions.api, s);
});
after(() => cleanup(s, sessions));
beforeEach(() => resetWorld(w));

const THU = 3;
const FRI = 4;
const H = (h, m = 0) => h * 60 + m;

const XTH1 = () => S(w, "X", "TH1", "ALL", 1);
const XTH1b = () => S(w, "X", "TH1", "ALL", 2);
const XTH2 = () => S(w, "X", "TH2");
const X1 = () => S(w, "X", "LB", "X1");
const X2 = () => S(w, "X", "LB", "X2");
const X3 = () => S(w, "X", "LB", "X3");
const YTH1 = () => S(w, "Y", "TH1", "ALL", 1);
const YTH1b = () => S(w, "Y", "TH1", "ALL", 2);
const YTH2 = () => S(w, "Y", "TH2");

const pl = (session_id, weekday, start_min, room_id) => ({ session_id, weekday, start_min, room_id });
const unit = (unit_id, ...placements) => ({ unit_id, placements });
const apply = (body, opts) => applyPlacements(w.versionId, body, opts);
const kindsOf = async (id) => (await occOf(id)).map((r) => r.kind).sort();
const roomKind = async (id) => (await occOf(id)).filter((r) => r.kind === "room" || r.kind === "lab_room").map((r) => r.kind);

// ------------------------------------------------------------------ happy path

test("a lab block of 3 batches plus theory units in one call: all applied, one rev bump, public sessions returned", async () => {
  const [LA] = w.rooms.labs;
  const [C0, C1] = w.rooms.classrooms;
  const rev0 = await revOf(w.versionId);
  const r = await apply({
    units: [
      unit("lab-x", pl(X1(), MON, H(8, 30), LA), pl(X2(), MON, H(8, 30), LA), pl(X3(), MON, H(8, 30), LA)),
      unit("th-x1", pl(XTH1(), MON, H(10, 45), C0)),
      unit("th-y1", pl(YTH1(), TUE, H(8, 30), C1)),
    ],
  });
  assert.deepEqual(r.applied_units, ["lab-x", "th-x1", "th-y1"]);
  assert.deepEqual(r.refused_units, []);
  assert.deepEqual(r.skipped_locked, []);
  assert.equal(r.prev_rev, rev0);
  assert.equal(r.rev, rev0 + 1);
  assert.equal(typeof r.rev, "number");
  assert.equal(r.chunks, 1);
  assert.equal(r.cancelled, false);
  assert.equal(await revOf(w.versionId), rev0 + 1);
  assert.deepEqual(r.sessions.map((x) => x.id).sort(), [X1(), X2(), X3(), XTH1(), YTH1()].sort());
  const x1 = r.sessions.find((x) => x.id === X1());
  assert.equal(x1.room_id, LA);
  assert.equal(x1.weekday, MON);
  assert.equal(x1.start_min, H(8, 30));
  assert.equal(x1.end_min, H(10, 30)); // lab = 120 min, server computes end_min
  assert.deepEqual(await dbSession(XTH1()), { weekday: MON, start_min: H(10, 45), end_min: H(11, 45), room_id: C0, locked: false });
  // the 3 batch labs share the lab by capacity
  assert.equal(await occCount(w.versionId, "kind = 'lab_room' AND resource_id = $2", [LA]), 3);
});

test("explicit room kinds: lab in a lab room is shared (lab_room), lab in a classroom and theory in a lab room are exclusive (room)", async () => {
  const [LA] = w.rooms.labs;
  const [C0] = w.rooms.classrooms;
  const r = await apply({
    units: [
      unit("lab-in-lab", pl(X1(), MON, H(8, 30), LA)),
      unit("lab-in-class", pl(X2(), TUE, H(8, 30), C0)),
      unit("theory-in-lab", pl(XTH1(), WED, H(8, 30), LA)),
      unit("theory-in-class", pl(YTH1(), THU, H(8, 30), C0)),
    ],
  });
  assert.equal(r.refused_units.length, 0, JSON.stringify(r.refused_units));
  assert.deepEqual(await roomKind(X1()), ["lab_room"]);
  assert.deepEqual(await roomKind(X2()), ["room"]);
  assert.deepEqual(await roomKind(XTH1()), ["room"]);
  assert.deepEqual(await roomKind(YTH1()), ["room"]);
  const rows = await occOf(X1());
  assert.deepEqual(rows.filter((x) => x.kind === "lab_room").map((x) => [x.resource_id, x.weekday, x.start_min, x.end_min]), [[LA, MON, H(8, 30), H(10, 30)]]);
  // whole-batch theory: faculty + room + whole-batch row + one row per non-whole batch of the division
  assert.deepEqual(await kindsOf(XTH1()), ["batch", "batch", "batch", "batch", "faculty", "room"]);
  // lab of X1 has lead + assist faculty rows and one batch row
  assert.deepEqual(await kindsOf(X1()), ["batch", "faculty", "faculty", "lab_room"]);
});

test("explicit rooms are still validated: a room outside the term pool and an off-grid start refuse the unit", async () => {
  const [C0] = w.rooms.classrooms;
  const r = await apply({
    units: [
      unit("outside", pl(XTH1(), MON, H(8, 30), w.rooms.outside)),
      unit("offgrid", pl(XTH2(), MON, H(8, 40), C0)),
      unit("fine", pl(YTH1(), MON, H(8, 30), C0)),
    ],
  });
  assert.deepEqual(r.applied_units, ["fine"]);
  assert.deepEqual(r.refused_units.map((x) => [x.unit_id, x.code]), [["outside", "PLACEMENT_INVALID"], ["offgrid", "PLACEMENT_INVALID"]]);
  assert.equal(r.refused_units[0].op_index, 0);
  assert.match(r.refused_units[0].message, /pool/i);
  assert.equal((await dbSession(XTH1())).weekday, null);
});

test("place of an already placed session behaves as move (and an identical re-place changes nothing)", async () => {
  const [C0, C1] = w.rooms.classrooms;
  await apply({ units: [unit("a", pl(XTH2(), MON, H(8, 30), C0))] });
  const rev1 = await revOf(w.versionId);
  const moved = await apply({ units: [unit("a", pl(XTH2(), TUE, H(9, 30), C1))] });
  assert.deepEqual(moved.applied_units, ["a"]);
  assert.equal(moved.rev, rev1 + 1);
  assert.deepEqual(await dbSession(XTH2()), { weekday: TUE, start_min: H(9, 30), end_min: H(10, 30), room_id: C1, locked: false });
  assert.equal((await occOf(XTH2())).filter((r) => r.kind === "room").length, 1);
  assert.ok((await occOf(XTH2())).every((r) => r.weekday === TUE));
  const same = await apply({ units: [unit("a", pl(XTH2(), TUE, H(9, 30), C1))] });
  assert.deepEqual(same.applied_units, ["a"]);
  assert.equal(same.rev, same.prev_rev, "no change -> no rev bump");
  assert.deepEqual(same.sessions, []);
});

// ------------------------------------------------------------------ refused units

test("a refused unit rolls back ALL its placements (no half block) while the other units apply; the clash sentence is reported", async () => {
  const [LA] = w.rooms.labs;
  const [C0] = w.rooms.classrooms;
  // pre-existing: Y TH2 (faculty E) on Wednesday 08:30; X3 already placed on Tuesday 08:30 (must stay there)
  await apply({ units: [unit("pre", pl(YTH2(), WED, H(8, 30), C0)), unit("pre3", pl(X3(), TUE, H(8, 30), LA))] });
  const x3Before = await occOf(X3());
  const rev0 = await revOf(w.versionId);
  const r = await apply({
    units: [
      // X3 is moved (index 0), X2 is fine, X1 (lead C + assist E) clashes on E at index 2: the whole block must be undone, X3 back on Tuesday
      unit("block", pl(X3(), THU, H(8, 30), LA), pl(X2(), WED, H(8, 30), LA), pl(X1(), WED, H(8, 30), LA)),
      unit("ok", pl(XTH2(), THU, H(10, 45), C0)),
    ],
  });
  assert.deepEqual(r.applied_units, ["ok"]);
  assert.equal(r.refused_units.length, 1);
  const ref = r.refused_units[0];
  assert.equal(ref.unit_id, "block");
  assert.equal(ref.code, "CLASH");
  assert.equal(ref.op_index, 2);
  assert.match(ref.message, /already teaching/);
  // nothing of the block persisted
  assert.equal((await dbSession(X2())).weekday, null);
  assert.equal((await dbSession(X1())).weekday, null);
  assert.deepEqual(await dbSession(X3()), { weekday: TUE, start_min: H(8, 30), end_min: H(10, 30), room_id: LA, locked: false });
  assert.deepEqual(await occOf(X2()), []);
  assert.deepEqual(await occOf(X1()), []);
  assert.deepEqual(await occOf(X3()), x3Before);
  // the applied unit is there, one bump for the chunk, only changed sessions returned
  assert.equal((await dbSession(XTH2())).weekday, THU);
  assert.equal(r.rev, rev0 + 1);
  assert.deepEqual(r.sessions.map((x) => x.id), [XTH2()]);
});

test("a chunk whose units are all refused does not bump rev", async () => {
  const [C0] = w.rooms.classrooms;
  await apply({ units: [unit("pre", pl(YTH1(), MON, H(8, 30), C0))] });
  const rev0 = await revOf(w.versionId);
  const r = await apply({ units: [unit("same-faculty", pl(XTH1(), MON, H(8, 30), w.rooms.classrooms[1]))] });
  assert.equal(r.refused_units[0].code, "CLASH"); // faculty A teaches both TH1s
  assert.deepEqual(r.applied_units, []);
  assert.equal(r.rev, rev0);
  assert.equal(r.prev_rev, rev0);
  assert.equal(await revOf(w.versionId), rev0);
  assert.deepEqual(r.sessions, []);
  assert.equal(r.chunks, 1);
});

test("shared-lab capacity is enforced for explicit rooms: the block is refused as a ROOM_CAPACITY clash and rolled back", async () => {
  const [LA] = w.rooms.labs;
  const cap = (await pool.query("SELECT capacity FROM rooms WHERE id = $1", [LA])).rows[0].capacity;
  // make two batches big enough that together they exceed the room (data of this test's own term)
  const big = Math.floor(cap / 2) + 1;
  await pool.query("UPDATE planner_batches SET student_count = $2 WHERE id = ANY($1::uuid[])", [[w.bx.X1.id, w.bx.X2.id], big]);
  try {
    const r = await apply({ units: [unit("lab", pl(X3(), MON, H(8, 30), LA), pl(X1(), MON, H(8, 30), LA), pl(X2(), MON, H(8, 30), LA))] });
    assert.deepEqual(r.applied_units, []);
    assert.equal(r.refused_units.length, 1);
    assert.equal(r.refused_units[0].code, "CLASH");
    assert.equal(r.refused_units[0].op_index, 2);
    assert.match(r.refused_units[0].message, /capacity/);
    assert.equal(await occCount(w.versionId), 0, "the whole block was rolled back");
    assert.equal((await dbSession(X3())).weekday, null);
  } finally {
    await pool.query("UPDATE planner_batches SET student_count = 8 WHERE id = ANY($1::uuid[])", [[w.bx.X1.id, w.bx.X2.id]]);
  }
});

test("a locked session in a unit refuses the unit with SESSION_LOCKED (earlier placements of the unit are rolled back)", async () => {
  const [LA] = w.rooms.labs;
  await pool.query("UPDATE planner_sessions SET locked = true WHERE id = $1", [X2()]);
  const r = await apply({ units: [unit("block", pl(X1(), MON, H(8, 30), LA), pl(X2(), MON, H(8, 30), LA), pl(X3(), MON, H(8, 30), LA))] });
  assert.deepEqual(r.applied_units, []);
  assert.deepEqual(r.refused_units.map((x) => [x.unit_id, x.code, x.op_index]), [["block", "SESSION_LOCKED", 1]]);
  assert.equal((await dbSession(X1())).weekday, null);
  assert.equal(await occCount(w.versionId), 0);
});

test("an unknown session id refuses its unit (NOT_FOUND), other units apply", async () => {
  const [C0] = w.rooms.classrooms;
  const ghost = "00000000-0000-4000-8000-000000000000";
  const r = await apply({ units: [unit("ghost", pl(ghost, MON, H(8, 30), C0)), unit("ok", pl(XTH1(), MON, H(8, 30), C0))] });
  assert.deepEqual(r.applied_units, ["ok"]);
  assert.deepEqual(r.refused_units.map((x) => [x.unit_id, x.code, x.op_index]), [["ghost", "NOT_FOUND", 0]]);
});

// ------------------------------------------------------------------ chunking

test("chunk=2 over 5 single-placement units makes 3 chunks, rev bumps once per chunk, prev_rev is the rev before the first", async () => {
  const [C0, C1, C2] = w.rooms.classrooms;
  const rev0 = await revOf(w.versionId);
  const infos = [];
  const r = await apply(
    {
      units: [
        unit("u1", pl(XTH1(), MON, H(8, 30), C0)),
        unit("u2", pl(XTH1b(), TUE, H(8, 30), C0)),
        unit("u3", pl(XTH2(), WED, H(8, 30), C0)),
        unit("u4", pl(YTH1(), THU, H(8, 30), C1)),
        unit("u5", pl(YTH2(), FRI, H(8, 30), C2)),
      ],
    },
    { chunk: 2, onChunk: async (i) => { infos.push({ ...i, dbRev: await revOf(w.versionId) }); } }
  );
  assert.equal(r.chunks, 3);
  assert.equal(r.prev_rev, rev0);
  assert.equal(r.rev, rev0 + 3);
  assert.deepEqual(r.applied_units, ["u1", "u2", "u3", "u4", "u5"]);
  assert.equal(r.sessions.length, 5);
  assert.deepEqual(infos.map((i) => [i.chunk_index, i.chunks, i.rev, i.dbRev]), [[0, 3, rev0 + 1, rev0 + 1], [1, 3, rev0 + 2, rev0 + 2], [2, 3, rev0 + 3, rev0 + 3]]);
  assert.deepEqual(infos.map((i) => i.applied_units), [["u1", "u2"], ["u3", "u4"], ["u5"]]);
  assert.ok(infos.every((i) => Array.isArray(i.refused_units) && i.refused_units.length === 0));
});

test("a unit is never split across chunks; an oversized unit gets its own chunk", async () => {
  const [LA] = w.rooms.labs;
  const [C0, C1] = w.rooms.classrooms;
  const infos = [];
  const r = await apply(
    {
      units: [
        unit("t1", pl(XTH1(), MON, H(8, 30), C0)),
        unit("t2", pl(YTH1(), TUE, H(8, 30), C1)),
        unit("lab", pl(X1(), WED, H(8, 30), LA), pl(X2(), WED, H(8, 30), LA), pl(X3(), WED, H(8, 30), LA)), // 3 > chunk 2
        unit("t3", pl(XTH2(), THU, H(8, 30), C0)),
      ],
    },
    { chunk: 2, onChunk: (i) => { infos.push(i); } }
  );
  assert.equal(r.chunks, 3);
  assert.deepEqual(infos.map((i) => i.applied_units), [["t1", "t2"], ["lab"], ["t3"]]);
  assert.equal(r.rev, r.prev_rev + 3);
  // the block is complete
  for (const id of [X1(), X2(), X3()]) assert.equal((await dbSession(id)).weekday, WED);
});

test("a refused unit in a later chunk does not disturb earlier committed chunks", async () => {
  const [C0, C1] = w.rooms.classrooms;
  const r = await apply(
    {
      units: [
        unit("a", pl(YTH1(), MON, H(8, 30), C0)),
        unit("b", pl(XTH1(), MON, H(8, 30), C1)), // faculty A busy at the same time (Y TH1) -> refused
        unit("c", pl(XTH2(), MON, H(8, 30), C1)),
      ],
    },
    { chunk: 1 }
  );
  assert.deepEqual(r.applied_units, ["a", "c"]);
  assert.deepEqual(r.refused_units.map((x) => x.unit_id), ["b"]);
  assert.equal(r.chunks, 3);
  assert.equal(r.rev, r.prev_rev + 2, "the all-refused chunk does not bump");
});

test("isCancelled is checked between chunks: committed chunks stay, the rest is skipped", async () => {
  const [C0] = w.rooms.classrooms;
  const rev0 = await revOf(w.versionId);
  let committed = 0;
  const r = await apply(
    {
      units: [
        unit("u1", pl(XTH1(), MON, H(8, 30), C0)),
        unit("u2", pl(XTH1b(), TUE, H(8, 30), C0)),
        unit("u3", pl(XTH2(), WED, H(8, 30), C0)),
      ],
    },
    { chunk: 1, onChunk: () => { committed++; }, isCancelled: () => committed >= 2 }
  );
  assert.equal(r.cancelled, true);
  assert.equal(r.chunks, 2);
  assert.deepEqual(r.applied_units, ["u1", "u2"]);
  assert.equal(r.prev_rev, rev0);
  assert.equal(r.rev, rev0 + 2);
  assert.equal((await dbSession(XTH2())).weekday, null);
  assert.equal(await revOf(w.versionId), rev0 + 2);
});

test("isCancelled already true: nothing is committed and the current rev is returned", async () => {
  const [C0] = w.rooms.classrooms;
  const rev0 = await revOf(w.versionId);
  const r = await apply({ units: [unit("u", pl(XTH1(), MON, H(8, 30), C0))] }, { isCancelled: () => true });
  assert.equal(r.cancelled, true);
  assert.equal(r.chunks, 0);
  assert.equal(r.rev, rev0);
  assert.equal(r.prev_rev, rev0);
  assert.deepEqual(r.applied_units, []);
  assert.equal((await dbSession(XTH1())).weekday, null);
});

// ------------------------------------------------------------------ unplace_ids

test("unplace_ids run first, so a unit may reuse the freed slot in the same call", async () => {
  const [C0, C1] = w.rooms.classrooms;
  await apply({ units: [unit("pre", pl(XTH1(), MON, H(8, 30), C0))] });
  const rev0 = await revOf(w.versionId);

  // without unplacing: Y TH1 (same faculty A, same slot) is refused
  const refused = await apply({ units: [unit("y", pl(YTH1(), MON, H(8, 30), C1))] });
  assert.equal(refused.refused_units[0].code, "CLASH");

  const r = await apply({ unplace_ids: [XTH1()], units: [unit("y", pl(YTH1(), MON, H(8, 30), C1))] });
  assert.deepEqual(r.applied_units, ["y"]);
  assert.deepEqual(r.refused_units, []);
  assert.equal(r.prev_rev, rev0);
  assert.equal(r.rev, rev0 + 1, "unplace + units of the first chunk share one bump");
  assert.equal((await dbSession(XTH1())).weekday, null);
  assert.deepEqual(await occOf(XTH1()), []);
  assert.equal((await dbSession(YTH1())).weekday, MON);
  assert.deepEqual(r.sessions.map((x) => x.id).sort(), [XTH1(), YTH1()].sort());
  assert.equal(r.sessions.find((x) => x.id === XTH1()).weekday, null);
});

test("unplace_ids with no units: a single chunk that only unplaces (no-op for sessions that are not placed)", async () => {
  const [C0] = w.rooms.classrooms;
  await apply({ units: [unit("pre", pl(XTH1(), MON, H(8, 30), C0), )] });
  const rev0 = await revOf(w.versionId);
  const infos = [];
  const r = await apply({ unplace_ids: [XTH1(), XTH2()], units: [] }, { onChunk: (i) => { infos.push(i); } });
  assert.equal(r.chunks, 1);
  assert.equal(r.rev, rev0 + 1);
  assert.deepEqual(r.sessions.map((x) => x.id), [XTH1()]);
  assert.equal(infos.length, 1);
  assert.equal(await occCount(w.versionId), 0);
  // nothing left to unplace: no bump
  const again = await apply({ unplace_ids: [XTH1(), XTH2()], units: [] });
  assert.equal(again.rev, rev0 + 1);
  assert.equal(again.prev_rev, rev0 + 1);
  assert.equal(again.chunks, 1);
});

test("unplace_ids go in the FIRST chunk only (not counted against the chunk size)", async () => {
  const [C0] = w.rooms.classrooms;
  await apply({ units: [unit("pre1", pl(XTH1(), MON, H(8, 30), C0)), unit("pre2", pl(XTH2(), TUE, H(8, 30), C0))] });
  const rev0 = await revOf(w.versionId);
  const infos = [];
  // chunk 0: unplace x2 + unit a; chunk 1: unit b which needs the slot freed in chunk 0
  const r = await apply(
    {
      unplace_ids: [XTH1(), XTH2()],
      units: [unit("a", pl(YTH2(), TUE, H(8, 30), C0)), unit("b", pl(YTH1b(), MON, H(8, 30), C0))],
    },
    { chunk: 1, onChunk: (i) => { infos.push(i); } }
  );
  assert.equal(r.chunks, 2);
  assert.equal(r.rev, rev0 + 2);
  assert.deepEqual(infos.map((i) => i.applied_units), [["a"], ["b"]]);
  assert.equal((await dbSession(XTH1())).weekday, null);
  assert.equal((await dbSession(XTH2())).weekday, null);
});

test("a locked session in unplace_ids is skipped silently and reported in skipped_locked", async () => {
  const [C0, C1] = w.rooms.classrooms;
  await apply({ units: [unit("pre", pl(XTH1(), MON, H(8, 30), C0), ), unit("pre2", pl(XTH2(), TUE, H(8, 30), C0))] });
  await pool.query("UPDATE planner_sessions SET locked = true WHERE id = $1", [XTH1()]);
  const rev0 = await revOf(w.versionId);
  const r = await apply({ unplace_ids: [XTH1(), XTH2()], units: [unit("y", pl(YTH1(), WED, H(8, 30), C1))] });
  assert.deepEqual(r.skipped_locked, [XTH1()]);
  assert.deepEqual(r.applied_units, ["y"]);
  assert.equal((await dbSession(XTH1())).weekday, MON, "locked session stays placed");
  assert.equal((await dbSession(XTH2())).weekday, null);
  assert.equal(r.rev, rev0 + 1);

  // only a locked id: nothing changed, no bump
  const only = await apply({ unplace_ids: [XTH1()], units: [] });
  assert.deepEqual(only.skipped_locked, [XTH1()]);
  assert.equal(only.rev, only.prev_rev);
  assert.deepEqual(only.sessions, []);
});

test("an unknown id in unplace_ids aborts the call with NOT_FOUND before anything is committed", async () => {
  const [C0] = w.rooms.classrooms;
  const rev0 = await revOf(w.versionId);
  await assert.rejects(
    apply({ unplace_ids: ["00000000-0000-4000-8000-000000000000"], units: [unit("u", pl(XTH1(), MON, H(8, 30), C0))] }),
    (e) => e.code === "NOT_FOUND" && e.status === 404
  );
  assert.equal(await revOf(w.versionId), rev0);
  assert.equal((await dbSession(XTH1())).weekday, null);
});

// ------------------------------------------------------------------ draft check + validation

test("a non-draft version aborts the call with NOT_DRAFT and changes nothing", async () => {
  const [C0] = w.rooms.classrooms;
  const rev0 = await revOf(w.versionId);
  await pool.query("UPDATE planner_versions SET status = 'published' WHERE id = $1", [w.versionId]);
  await assert.rejects(
    apply({ units: [unit("u", pl(XTH1(), MON, H(8, 30), C0))] }),
    (e) => e.code === "NOT_DRAFT" && e.status === 409
  );
  assert.equal(await revOf(w.versionId), rev0);
  assert.equal((await dbSession(XTH1())).weekday, null);
});

test("an unknown version is NOT_FOUND", async () => {
  const [C0] = w.rooms.classrooms;
  await assert.rejects(
    applyPlacements("00000000-0000-4000-8000-000000000000", { units: [unit("u", pl(XTH1(), MON, H(8, 30), C0))] }),
    (e) => e.code === "NOT_FOUND"
  );
});

test("body validation: unique unit ids, unique sessions, non-empty placements, required uuid room_id, bad weekday", async () => {
  const [C0] = w.rooms.classrooms;
  const bad = async (body, key) => {
    await assert.rejects(apply(body), (e) => e.code === "VALIDATION_ERROR" && (!key || Object.keys(e.details.fieldErrors).some((k) => k.startsWith(key))), JSON.stringify(body));
  };
  await bad({ units: [unit("a", pl(XTH1(), MON, 510, C0)), unit("a", pl(XTH2(), MON, 600, C0))] }, "units.1.unit_id");
  await bad({ units: [unit("a", pl(XTH1(), MON, 510, C0)), unit("b", pl(XTH1(), TUE, 510, C0))] }, "units.1.placements.0.session_id");
  await bad({ units: [unit("a")] }, "units.0.placements");
  await bad({ units: [unit("a", { session_id: XTH1(), weekday: MON, start_min: 510 })] }, "units.0.placements.0.room_id");
  await bad({ units: [unit("a", pl(XTH1(), MON, 510, "not-a-uuid"))] }, "units.0.placements.0.room_id");
  await bad({ units: [unit("a", pl(XTH1(), 9, 510, C0))] }, "units.0.placements.0.weekday");
  await bad({ units: [unit("", pl(XTH1(), MON, 510, C0))] }, "units.0.unit_id");
  await bad({ unplace_ids: ["nope"], units: [] }, "unplace_ids");
  await bad({}, "units");
  await bad({ units: [unit("x".repeat(65), pl(XTH1(), MON, 510, C0))] }, "units.0.unit_id");
  await bad({ units: [{ unit_id: "a", placements: [pl(XTH1(), MON, 510, C0)], fallback: [] }] }, "units.0.fallback");
  await bad({ units: [unit("a", { ...pl(XTH1(), MON, 510, C0), expect: { weekday: 9, start_min: 510, room_id: C0 } })] }, "units.0.placements.0.expect");
  // too many placements per call (the cap is 20000)
  const many = Array.from({ length: 20001 }, (_, i) => unit(`u${i}`, pl(crypto.randomUUID(), MON, 510, C0)));
  await bad({ units: many }, "units");
  assert.equal(await occCount(w.versionId), 0);
});

test("an empty call is a no-op that reports the current rev", async () => {
  const rev0 = await revOf(w.versionId);
  const r = await apply({ units: [] });
  assert.deepEqual([r.rev, r.prev_rev, r.chunks, r.applied_units, r.refused_units, r.sessions], [rev0, rev0, 0, [], [], []]);
});

// ------------------------------------------------------------------ independent SQL check of a bigger run

test("after a bigger run: no faculty / batch / room overlaps (independent SQL) and the occupancy row count is the expected one", async () => {
  const [LA, LB] = w.rooms.labs;
  const [C0, C1, C2] = w.rooms.classrooms;
  const r = await apply(
    {
      units: [
        unit("lab-x", pl(X1(), MON, H(8, 30), LA), pl(X2(), MON, H(8, 30), LA), pl(X3(), MON, H(8, 30), LB)),
        unit("x-th1a", pl(XTH1(), MON, H(10, 45), C0)),
        unit("x-th1b", pl(XTH1b(), TUE, H(8, 30), C0)),
        unit("x-th2", pl(XTH2(), TUE, H(9, 30), C1)),
        unit("y-th1a", pl(YTH1(), MON, H(8, 30), C1)),
        unit("y-th1b", pl(YTH1b(), WED, H(8, 30), C2)),
        unit("y-th2", pl(YTH2(), WED, H(9, 30), C2)),
      ],
    },
    { chunk: 3 }
  );
  assert.equal(r.refused_units.length, 0, JSON.stringify(r.refused_units));
  assert.equal(r.applied_units.length, 7);
  assert.equal(r.chunks, 3); // [lab-x 3], [x-th1a x-th1b x-th2], [y-th1a y-th1b y-th2]
  assert.equal(r.rev, r.prev_rev + 3);
  await refreshSessions(w);

  // 3 X whole-batch theory: 1 faculty + 1 room + (whole + 3 batch rows) = 6; X lab batches: 2+1+1, 1+1+1, 1+1+1;
  // 3 Y theory (no non-whole batches): 1 + 1 + 1
  const expected = 3 * 6 + (4 + 3 + 3) + 3 * 3;
  assert.equal(await occCount(w.versionId), expected);
  assert.equal(await occCount(w.versionId, "kind = 'lab_room'"), 3);

  // every row of a placed session, none for unplaced ones, and the row's slot equals the session's slot
  const { rows: bad } = await pool.query(
    `SELECT o.id FROM planner_occupancy o JOIN planner_sessions s ON s.id = o.session_id
      WHERE o.version_id = $1 AND (s.weekday IS NULL OR o.weekday <> s.weekday OR lower(o.during) <> s.start_min OR upper(o.during) <> s.end_min)`,
    [w.versionId]
  );
  assert.equal(bad.length, 0);

  // independent overlap check on the sessions themselves (not on the occupancy table the service wrote)
  const { rows: facClash } = await pool.query(
    `SELECT a.id, b.id FROM planner_sessions a JOIN planner_sessions b ON a.id < b.id AND a.version_id = b.version_id AND a.weekday = b.weekday
       AND a.start_min < b.end_min AND b.start_min < a.end_min
       JOIN planner_session_faculty fa ON fa.session_id = a.id JOIN planner_session_faculty fb ON fb.session_id = b.id AND fb.faculty_id = fa.faculty_id
      WHERE a.version_id = $1`,
    [w.versionId]
  );
  assert.equal(facClash.length, 0, "no faculty member teaches two overlapping sessions");
  const { rows: roomClash } = await pool.query(
    `SELECT a.id, b.id FROM planner_sessions a JOIN planner_sessions b ON a.id < b.id AND a.version_id = b.version_id AND a.weekday = b.weekday
       AND a.room_id = b.room_id AND a.start_min < b.end_min AND b.start_min < a.end_min
      WHERE a.version_id = $1 AND NOT EXISTS (SELECT 1 FROM planner_occupancy o WHERE o.session_id IN (a.id, b.id) AND o.kind = 'lab_room')`,
    [w.versionId]
  );
  assert.equal(roomClash.length, 0, "no classroom hosts two overlapping sessions");
  const { rows: batchClash } = await pool.query(
    `SELECT a.id, b.id FROM planner_sessions a JOIN planner_sessions b ON a.id < b.id AND a.version_id = b.version_id AND a.weekday = b.weekday
       AND a.start_min < b.end_min AND b.start_min < a.end_min
       JOIN planner_batches ba ON ba.id = a.batch_id JOIN planner_batches bb ON bb.id = b.batch_id AND bb.division_id = ba.division_id
      WHERE a.version_id = $1 AND (ba.is_whole OR bb.is_whole OR ba.id = bb.id)`,
    [w.versionId]
  );
  assert.equal(batchClash.length, 0, "no division has a whole-class and another session at the same time");
  // and the occupancy table itself has no exclusive-kind overlap (the DB constraint would have refused it anyway)
  const { rows: occOverlap } = await pool.query(
    `SELECT a.id FROM planner_occupancy a JOIN planner_occupancy b ON a.id < b.id AND a.version_id = b.version_id AND a.kind = b.kind
       AND a.resource_id = b.resource_id AND a.weekday = b.weekday AND a.during && b.during
      WHERE a.version_id = $1 AND a.kind <> 'lab_room'`,
    [w.versionId]
  );
  assert.equal(occOverlap.length, 0);
});

// ------------------------------------------------------------------ review amendments (contract 9.9)

test("caps: unit ids up to 64 chars and thousands of unplace ids pass validation (an unknown session is then a 404, not a validation error)", async () => {
  const [C0] = w.rooms.classrooms;
  const r = await apply({ units: [unit("k".repeat(64), pl(XTH1(), MON, H(8, 30), C0))] });
  assert.deepEqual(r.applied_units, ["k".repeat(64)]);
  const ids = Array.from({ length: 6000 }, () => crypto.randomUUID());
  await assert.rejects(apply({ unplace_ids: ids, units: [] }), (e) => e.code === "NOT_FOUND");
});

test("expect on a placement: matches -> applied; null = must be unplaced; a moved session refuses the unit with STALE and nothing changes", async () => {
  const [C0, C1] = w.rooms.classrooms;
  // unplaced + expect:null -> ok
  let r = await apply({ units: [unit("a", { ...pl(XTH1(), MON, H(8, 30), C0), expect: null })] });
  assert.deepEqual(r.applied_units, ["a"]);
  // placed + expect:null -> STALE
  const rev0 = await revOf(w.versionId);
  r = await apply({ units: [unit("b", { ...pl(XTH1(), TUE, H(8, 30), C0), expect: null })] });
  assert.deepEqual(r.applied_units, []);
  assert.deepEqual(r.refused_units.map((x) => [x.unit_id, x.code, x.op_index]), [["b", "STALE", 0]]);
  assert.equal(r.rev, rev0);
  assert.deepEqual(await dbSession(XTH1()), { weekday: MON, start_min: H(8, 30), end_min: H(9, 30), room_id: C0, locked: false });
  // exact expect -> ok; any differing field -> STALE
  r = await apply({ units: [unit("c", { ...pl(XTH1(), TUE, H(8, 30), C0), expect: { weekday: MON, start_min: H(8, 30), room_id: C1 } })] });
  assert.equal(r.refused_units[0].code, "STALE");
  r = await apply({ units: [unit("d", { ...pl(XTH1(), TUE, H(8, 30), C0), expect: { weekday: MON, start_min: H(8, 30), room_id: C0 } })] });
  assert.deepEqual(r.applied_units, ["d"]);
  assert.equal((await dbSession(XTH1())).weekday, TUE);
  // unit-level atomicity: the 2nd placement is stale, the 1st is rolled back
  r = await apply({ units: [unit("e", pl(XTH2(), WED, H(8, 30), C0), { ...pl(XTH1b(), WED, H(10, 45), C0), expect: { weekday: MON, start_min: 600, room_id: C0 } })] });
  assert.deepEqual(r.refused_units.map((x) => [x.code, x.op_index]), [["STALE", 1]]);
  assert.equal((await dbSession(XTH2())).weekday, null);
});

test("expect on unplace_ids: a matching session is unplaced, a moved one is skipped and listed in skipped_stale; plain uuid strings still work", async () => {
  const [C0, C1] = w.rooms.classrooms;
  await apply({ units: [unit("pre", pl(XTH1(), MON, H(8, 30), C0), pl(XTH1b(), TUE, H(8, 30), C0)), unit("pre2", pl(XTH2(), WED, H(8, 30), C1))] });
  const r = await apply({
    unplace_ids: [
      { session_id: XTH1(), expect: { weekday: MON, start_min: H(8, 30), room_id: C0 } }, // matches
      { session_id: XTH1b(), expect: { weekday: THU, start_min: H(8, 30), room_id: C0 } }, // moved by someone
      XTH2(), // plain id: no check
    ],
    units: [],
  });
  assert.deepEqual(r.skipped_stale, [XTH1b()]);
  assert.deepEqual(r.sessions.map((x) => x.id).sort(), [XTH1(), XTH2()].sort());
  assert.equal((await dbSession(XTH1())).weekday, null);
  assert.equal((await dbSession(XTH2())).weekday, null);
  assert.equal((await dbSession(XTH1b())).weekday, TUE, "the stale unplace was skipped");
  // an object without expect is a plain unplace; a duplicate id is de-duplicated (first wins)
  const r2 = await apply({ unplace_ids: [{ session_id: XTH1b() }, XTH1b()], units: [] });
  assert.deepEqual(r2.skipped_stale, []);
  assert.equal((await dbSession(XTH1b())).weekday, null);
});

test("regenerate shape: unplace with expect + re-placement with expect:null; when the unplace is stale the re-placement is refused STALE too", async () => {
  const [C0, C1] = w.rooms.classrooms;
  await apply({ units: [unit("pre", pl(XTH1(), MON, H(8, 30), C0), pl(XTH1b(), TUE, H(8, 30), C0))] });
  const r = await apply({
    unplace_ids: [
      { session_id: XTH1(), expect: { weekday: MON, start_min: H(8, 30), room_id: C0 } },
      { session_id: XTH1b(), expect: { weekday: THU, start_min: H(8, 30), room_id: C0 } }, // stale
    ],
    units: [
      unit("n1", { ...pl(XTH1(), WED, H(10, 45), C1), expect: null }),
      unit("n2", { ...pl(XTH1b(), FRI, H(10, 45), C1), expect: null }),
    ],
  });
  assert.deepEqual(r.applied_units, ["n1"]);
  assert.deepEqual(r.refused_units.map((x) => [x.unit_id, x.code]), [["n2", "STALE"]]);
  assert.deepEqual(r.skipped_stale, [XTH1b()]);
  assert.equal((await dbSession(XTH1())).weekday, WED);
  assert.equal((await dbSession(XTH1b())).weekday, TUE);
});

test("atomic: more units than the chunk size still run as ONE transaction / one rev bump; guard and finalize run inside it", async () => {
  const [C0, C1, C2] = w.rooms.classrooms;
  const rev0 = await revOf(w.versionId);
  const seen = [];
  const r = await apply(
    { units: [unit("a", pl(XTH1(), MON, H(8, 30), C0)), unit("b", pl(XTH1b(), TUE, H(8, 30), C1)), unit("c", pl(XTH2(), WED, H(8, 30), C2)), unit("d", pl(YTH2(), THU, H(8, 30), C2))] },
    { chunk: 1, atomic: true, guard: async (db, v) => seen.push(["guard", v.id]), finalize: async (db, info) => seen.push(["finalize", info.rev]) }
  );
  assert.equal(r.chunks, 1);
  assert.equal(r.rev, rev0 + 1);
  assert.equal(r.applied_units.length, 4);
  assert.deepEqual(seen, [["guard", w.versionId], ["finalize", rev0 + 1]]);
  // without atomic the same size of call is several chunks
  await resetWorld(w);
  const r2 = await apply({ units: [unit("a", pl(XTH1(), MON, H(8, 30), C0)), unit("b", pl(XTH1b(), TUE, H(8, 30), C1))] }, { chunk: 1 });
  assert.equal(r2.chunks, 2);
  // an empty atomic call still runs the guard + finalize once (an undo with nothing restorable still marks the run)
  const seen2 = [];
  const r3 = await apply({ units: [] }, { atomic: true, guard: async () => seen2.push("guard"), finalize: async () => seen2.push("finalize") });
  assert.deepEqual(seen2, ["guard", "finalize"]);
  assert.equal(r3.chunks, 1);
});

test("a throwing guard aborts the whole call: nothing is written", async () => {
  const [C0] = w.rooms.classrooms;
  const rev0 = await revOf(w.versionId);
  await assert.rejects(
    apply({ units: [unit("a", pl(XTH1(), MON, H(8, 30), C0))] }, { atomic: true, guard: async () => { throw new Error("stop"); } }),
    /stop/
  );
  assert.equal(await revOf(w.versionId), rev0);
  assert.equal((await dbSession(XTH1())).weekday, null);
});

test("onChunk reports the sessions THAT chunk changed (additive field), per chunk", async () => {
  const [C0, C1] = w.rooms.classrooms;
  const per = [];
  await apply(
    { units: [unit("a", pl(XTH1(), MON, H(8, 30), C0)), unit("b", pl(XTH1b(), TUE, H(8, 30), C1))] },
    { chunk: 1, onChunk: async (info) => per.push(info.sessions.map((x) => x.id)) }
  );
  assert.deepEqual(per, [[XTH1()], [XTH1b()]]);
});

test("fallback: a refused unit falls back (same transaction) to its fallback placements; a refused fallback leaves the session unplaced; both are reported", async () => {
  const [C0, C1] = w.rooms.classrooms;
  // Y TH1 (teacher A) sits Mon 08:30, so X TH1 (teacher A) cannot go there. X TH1#1 is on Tue 08:30 (C0), X TH1#2 on Wed 08:30 (C0).
  await apply({ units: [unit("pre", pl(YTH1(), MON, H(8, 30), C1), pl(XTH1(), TUE, H(8, 30), C0), pl(XTH1b(), WED, H(8, 30), C0))] });
  const r = await apply(
    {
      unplace_ids: [
        { session_id: XTH1(), expect: { weekday: TUE, start_min: H(8, 30), room_id: C0 } },
        { session_id: XTH1b(), expect: { weekday: WED, start_min: H(8, 30), room_id: C0 } },
      ],
      units: [
        // refused (clash on Mon 08:30) -> the fallback to the old slot (free again after the unplace) is applied
        { unit_id: "r1", placements: [{ ...pl(XTH1(), MON, H(8, 30), C0), expect: null }], fallback: [{ ...pl(XTH1(), TUE, H(8, 30), C0), expect: null }] },
        // refused, and the fallback is refused too (same clash) -> stays unplaced
        { unit_id: "r2", placements: [{ ...pl(XTH1b(), MON, H(8, 30), C0), expect: null }], fallback: [{ ...pl(XTH1b(), MON, H(8, 30), C1), expect: null }] },
      ],
    },
    { atomic: true }
  );
  assert.deepEqual(r.applied_units, []);
  assert.deepEqual(r.refused_units.map((x) => [x.unit_id, x.code, x.fallback_applied]), [["r1", "CLASH", true], ["r2", "CLASH", false]]);
  assert.deepEqual(await dbSession(XTH1()), { weekday: TUE, start_min: H(8, 30), end_min: H(9, 30), room_id: C0, locked: false });
  assert.equal((await dbSession(XTH1b())).weekday, null);
  assert.ok((await occOf(XTH1())).length > 0);
  assert.deepEqual(await occOf(XTH1b()), []);
});
