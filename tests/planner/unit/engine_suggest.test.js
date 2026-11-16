import test from 'node:test';
import assert from 'node:assert/strict';
import { generate, buildModel, buildEngineConfig, candidatesFor, suggestionsFor, diagnose } from '../../../services/planner/engine/index.js';
import { checkIntegrity } from '../real/lib/integrity.mjs';
import { mini, sessionOf, roomId, placeIn } from '../real/lib/testkit.mjs';


// ---- helpers (local copy, shared by no other file) ----
const clone = (x) => JSON.parse(JSON.stringify(x));

/** A copy of the snapshot with the generator result applied (unplace_ids first, then every unit's placements). */
function applyResult(snapshot, result) {
  const snap = clone(snapshot);
  const by = new Map(snap.sessions.map((s) => [s.id, s]));
  for (const id of result.unplace_ids || []) Object.assign(by.get(id), { weekday: null, start_min: null, end_min: null, room_id: null });
  for (const u of result.units) {
    for (const p of u.placements) {
      const s = by.get(p.session_id);
      Object.assign(s, { weekday: p.weekday, start_min: p.start_min, end_min: p.start_min + s.duration_min, room_id: p.room_id });
    }
  }
  return snap;
}

const smallWorld = () =>
  mini({
    rooms: [{ name: 'C1', cap: 60 }, { name: 'C2', cap: 60 }, { name: 'LAB1', lab: true, cap: 62 }, { name: 'LAB2', lab: true, cap: 62 }],
    faculty: ['A', 'B', 'C', 'D'],
    subjects: [{ code: 'T1', kind: 'theory', weekly: 3 }, { code: 'T2', kind: 'theory', weekly: 2 }, { code: 'L1', kind: 'lab', weekly: 1 }, { code: 'L2', kind: 'lab', weekly: 1 }],
    divisions: [
      { name: 'X', students: 40, batches: [['X1', 20], ['X2', 20]], home: 'C1' },
      { name: 'Y', students: 40, batches: [['Y1', 20], ['Y2', 20]], home: 'C2' },
    ],
    offerings: [
      { div: 'X', code: 'T1', faculty: 'A' }, { div: 'X', code: 'T2', faculty: 'B' }, { div: 'X', code: 'L1', faculty: 'C' }, { div: 'X', code: 'L2', faculty: 'D' },
      { div: 'Y', code: 'T1', faculty: 'A' }, { div: 'Y', code: 'T2', faculty: 'B' }, { div: 'Y', code: 'L1', faculty: 'C' }, { div: 'Y', code: 'L2', faculty: 'D' },
    ],
  });

/** A complete generated timetable and its model. */
function full() {
  const w = smallWorld();
  const snap = applyResult(w, generate({ snapshot: w, seed: 1 }));
  return { w, snap, model: buildModel(snap), config: buildEngineConfig([]) };
}

/** Applies a candidate/op to a copy of the snapshot and returns the independent verdict. */
function verdict(snap, sid, c) {
  const copy = clone(snap);
  const s = copy.sessions.find((x) => x.id === sid);
  Object.assign(s, { weekday: c.weekday, start_min: c.start_min, end_min: c.end_min ?? c.start_min + s.duration_min, room_id: c.room_id });
  return checkIntegrity(copy);
}

test('candidatesFor: every candidate of a placed theory session is a valid move, ascending score, session untouched', () => {
  const { snap, model, config } = full();
  const sid = sessionOf(snap, 'X', 'T2', 'ALL', 2).id;
  const snapshotOf = () => JSON.stringify([...model.placed].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  const before = snapshotOf();
  const c = candidatesFor(model, sid, config);
  assert.equal(snapshotOf(), before, 'the model is restored exactly');
  assert.ok(c.length > 10);
  assert.deepEqual(Object.keys(c[0]).sort(), ['end_min', 'room_id', 'room_name', 'score', 'start_min', 'weekday']);
  for (let i = 1; i < c.length; i++) assert.ok(c[i - 1].score <= c[i].score, 'ascending');
  for (const x of c) {
    assert.equal(x.end_min, x.start_min + 60);
    assert.ok(x.room_name);
    assert.deepEqual(verdict(snap, sid, x).violations, [], `${x.weekday} ${x.start_min}`);
  }
  // its own slot is a candidate again (it is evaluated as if removed)
  const own = snap.sessions.find((s) => s.id === sid);
  assert.ok(c.some((x) => x.weekday === own.weekday && x.start_min === own.start_min));
  // hard rule: the other T2 session of X is on another day, so no candidate shares its day
  const other = sessionOf(snap, 'X', 'T2', 'ALL', 1);
  assert.ok(c.every((x) => x.weekday !== other.weekday));
});

test('candidatesFor: a lab session is evaluated alone; lab_per_day holds per batch; rooms are labs', () => {
  const { snap, model, config } = full();
  const lab = sessionOf(snap, 'X', 'L1', 'X1');
  const c = candidatesFor(model, lab.id, config);
  assert.ok(c.length > 0);
  const otherLabDay = snap.sessions.find((s) => s.batch_id === lab.batch_id && s.kind === 'lab' && s.id !== lab.id).weekday;
  assert.ok(c.every((x) => x.weekday !== otherLabDay), 'the batch has another lab that day');
  assert.ok(c.every((x) => x.end_min - x.start_min === 120));
  assert.ok(c.every((x) => /^LAB/.test(x.room_name)));
  for (const x of c.slice(0, 25)) assert.deepEqual(verdict(snap, lab.id, x).violations, []);
});

test('candidatesFor: an unplaced session gets every free hard-valid slot', () => {
  const { w, snap, model, config } = full();
  const sid = sessionOf(w, 'Y', 'T1', 'ALL', 3).id;
  model.unplace(sid);
  const c = candidatesFor(model, sid, config);
  assert.ok(c.length > 0);
  assert.equal(model.isPlaced(sid), false, 'still unplaced afterwards');
  void snap;
});

test('suggestionsFor: top N with a human reason and correct ops (move for a placed session, place for an unplaced one)', () => {
  const { w, snap, model, config } = full();
  const sid = sessionOf(snap, 'X', 'T1', 'ALL', 1).id;
  const cur = snap.sessions.find((s) => s.id === sid);
  const r = suggestionsFor(model, sid, config, { limit: 3 });
  assert.equal(r.suggestions.length, 3);
  assert.equal(r.none_reason, undefined);
  for (const s of r.suggestions) {
    assert.ok(!(s.weekday === cur.weekday && s.start_min === cur.start_min), 'the current slot is not suggested');
    assert.ok(typeof s.reason === 'string' && s.reason.length > 10);
    assert.ok(s.reason.includes(s.room_name));
    assert.deepEqual(s.ops, [{ op: 'move', session_id: sid, weekday: s.weekday, start_min: s.start_min, room_id: s.room_id }]);
    assert.deepEqual(verdict(snap, sid, s).violations, []);
  }
  assert.ok(r.suggestions.every((s, i) => i === 0 || r.suggestions[i - 1].score <= s.score));
  assert.match(r.suggestions.map((s) => s.reason).join(' | '), /keeps X in C1/);
  assert.match(r.suggestions[0].reason, /no new idle gap|idle gap/);
  assert.match(r.suggestions[0].reason, /Prof \w (stays at|reaches) [\d.]+ h that day/);
  // unplaced -> place
  model.unplace(sid);
  const p = suggestionsFor(model, sid, config, { limit: 2 });
  assert.equal(p.suggestions.length, 2);
  assert.ok(p.suggestions.every((s) => s.ops[0].op === 'place' && s.ops.length === 1));
  // default limit 5, cap 20
  assert.equal(suggestionsFor(model, sid, config).suggestions.length, 5);
  assert.ok(suggestionsFor(model, sid, config, { limit: 500 }).suggestions.length <= 20);
  void w;
});

test('suggestionsFor: a lab suggestion places that one session only', () => {
  const { snap, model, config } = full();
  const lab = sessionOf(snap, 'Y', 'L2', 'Y2');
  const r = suggestionsFor(model, lab.id, config, { limit: 4 });
  assert.ok(r.suggestions.length > 0);
  for (const s of r.suggestions) {
    assert.equal(s.ops.length, 1);
    assert.equal(s.ops[0].session_id, lab.id);
    assert.match(s.reason, /uses lab LAB\d/);
  }
});

test('suggestionsFor: a locked session gives none_reason LOCKED', () => {
  const { snap, config } = full();
  const copy = clone(snap);
  const s = sessionOf(copy, 'X', 'T1', 'ALL', 1);
  s.locked = true;
  const r = suggestionsFor(buildModel(copy), s.id, config);
  assert.deepEqual(r.suggestions, []);
  assert.equal(r.none_reason.code, 'LOCKED');
  assert.ok(r.none_reason.text && r.none_reason.slots.total > 0);
});

test('none_reason: FACULTY_BUSY / DIVISION_BUSY / NO_ROOM / POLICY_RULES with plain-English texts', () => {
  const reasonFor = (world) => {
    const g = generate({ snapshot: world, seed: 1 });
    const snap = applyResult(world, g);
    assert.ok(g.unplaced.length >= 1);
    const sid = g.unplaced[0].session_id;
    return { none: suggestionsFor(buildModel(snap), sid, buildEngineConfig([])).none_reason, code: g.unplaced[0].code, text: g.unplaced[0].text };
  };
  // one cell a day: two divisions share a teacher -> FACULTY_BUSY
  const fac = mini({
    term: { working_days: [0], day_end_min: 570 },
    rooms: [{ name: 'C1', cap: 60 }, { name: 'C2', cap: 60 }],
    faculty: ['A'],
    subjects: [{ code: 'T1', kind: 'theory', weekly: 1 }],
    divisions: [{ name: 'X', students: 60, home: 'C1' }, { name: 'Y', students: 60, home: 'C2' }],
    offerings: [{ div: 'X', code: 'T1', faculty: 'A' }, { div: 'Y', code: 'T1', faculty: 'A' }],
  });
  let r = reasonFor(fac);
  assert.equal(r.none.code, 'FACULTY_BUSY');
  assert.equal(r.code, 'FACULTY_BUSY', 'same verdict as the run');
  assert.equal(r.none.text, 'Prof A (A) is busy in the only slot.');
  assert.deepEqual(r.none.slots, { total: 1, free: 0, faculty: 1, batch: 0, room: 0 });
  // one cell a day, one division, two subjects with different teachers -> DIVISION_BUSY
  const div = mini({
    term: { working_days: [0], day_end_min: 570 },
    rooms: [{ name: 'C1', cap: 60 }],
    faculty: ['A', 'B'],
    subjects: [{ code: 'T1', kind: 'theory', weekly: 1 }, { code: 'T2', kind: 'theory', weekly: 1 }],
    divisions: [{ name: 'X', students: 60, home: 'C1' }],
    offerings: [{ div: 'X', code: 'T1', faculty: 'A' }, { div: 'X', code: 'T2', faculty: 'B' }],
  });
  r = reasonFor(div);
  assert.equal(r.none.code, 'DIVISION_BUSY');
  assert.match(r.none.text, /^X \(Sem 3\) already has class in the only slot\.$/);
  // one cell a day, one classroom, two divisions with different teachers -> NO_ROOM
  const room = mini({
    term: { working_days: [0], day_end_min: 570 },
    rooms: [{ name: 'C1', cap: 60 }],
    faculty: ['A', 'B'],
    subjects: [{ code: 'T1', kind: 'theory', weekly: 1 }],
    divisions: [{ name: 'X', students: 60, home: 'C1' }, { name: 'Y', students: 60, home: 'C1' }],
    offerings: [{ div: 'X', code: 'T1', faculty: 'A' }, { div: 'Y', code: 'T1', faculty: 'B' }],
  });
  r = reasonFor(room);
  assert.equal(r.none.code, 'NO_ROOM');
  assert.equal(r.none.text, 'no classroom is free in the only slot.');
  // a subject taught 3 times on a one-day week: the third lecture breaks the hard rule -> POLICY_RULES
  const pol = mini({
    term: { working_days: [0], day_end_min: 765 },
    rooms: [{ name: 'C1', cap: 60 }],
    faculty: ['A'],
    subjects: [{ code: 'T1', kind: 'theory', weekly: 3 }],
    divisions: [{ name: 'X', students: 60, home: 'C1' }],
    offerings: [{ div: 'X', code: 'T1', faculty: 'A' }],
  });
  r = reasonFor(pol);
  assert.equal(r.none.code, 'POLICY_RULES');
  assert.match(r.none.text, /free, but each would break a hard rule/);
});

test('diagnose: names the teacher and splits the blocked slots, e.g. "Prof A (A) is busy in 4 of 5 slots; no classroom is free in the other 1."', () => {
  const w = mini({
    term: { working_days: [0], day_end_min: 630 },
    rooms: [{ name: 'C1', cap: 60 }],
    faculty: ['A', 'B'],
    subjects: [{ code: 'T1', kind: 'theory', weekly: 1 }],
    divisions: [{ name: 'X', students: 60, home: 'C1' }, { name: 'Y', students: 60, home: 'C1' }, { name: 'Z', students: 60, home: 'C1' }],
    offerings: [{ div: 'X', code: 'T1', faculty: 'A' }, { div: 'Y', code: 'T1', faculty: 'A' }, { div: 'Z', code: 'T1', faculty: 'B' }],
  });
  placeIn(w, sessionOf(w, 'Y', 'T1'), 0, 510, roomId(w, 'C1')); // teacher A 08:30-09:30 in the only classroom
  placeIn(w, sessionOf(w, 'Z', 'T1'), 0, 570, roomId(w, 'C1')); // 09:30-10:30 in the only classroom
  const m = buildModel(w);
  const d = diagnose(m, sessionOf(w, 'X', 'T1').id);
  assert.equal(d.code, 'FACULTY_BUSY');
  assert.equal(d.text, 'Prof A (A) is busy in 4 of 5 slots; no classroom is free in the other 1.');
  assert.deepEqual(d.slots, { total: 5, free: 0, faculty: 4, batch: 0, room: 1 });
  assert.deepEqual(d.teachers, ['A']);
});
