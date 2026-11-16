import test from 'node:test';
import assert from 'node:assert/strict';
import { generate, OccupancyModel, theoryCandidates, repairUnplaced } from '../../../services/planner/engine/index.js';
import { mini, sessionOf, roomId, placeIn } from '../real/lib/testkit.mjs';

import { checkIntegrity } from '../real/lib/integrity.mjs';

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

/** Independent judge: applies the result and recomputes every clash with integrity.mjs. */
function judge(snapshot, result) {
  const snap = applyResult(snapshot, result);
  return { snap, integrity: checkIntegrity(snap) };
}

// ---- theory: a dead end that only an ejection chain resolves ------------------------------------------------
// One working day with two cells (08:30, 09:30). Teacher A teaches b (division X) and U (division Y). Division Y is
// already busy at 09:30 (a fixed session of teacher C), so U can only go to 08:30. Greedy places b first and, for about
// half of the seeds, puts it on 08:30: U is then stranded. Repair moves b to 09:30.
const deadEnd = () => {
  const w = mini({
    term: { working_days: [0], day_end_min: 630 },
    rooms: [{ name: 'C1', cap: 60 }, { name: 'C2', cap: 60 }],
    faculty: ['A', 'C'],
    subjects: [{ code: 'T1', kind: 'theory', weekly: 1 }, { code: 'T2', kind: 'theory', weekly: 1 }, { code: 'T3', kind: 'theory', weekly: 1 }],
    divisions: [{ name: 'X', students: 60, home: 'C1' }, { name: 'Y', students: 60, home: 'C2' }],
    offerings: [{ div: 'X', code: 'T1', faculty: 'A' }, { div: 'Y', code: 'T2', faculty: 'A' }, { div: 'Y', code: 'T3', faculty: 'C' }],
  });
  placeIn(w, sessionOf(w, 'Y', 'T3'), 0, 570, roomId(w, 'C2'));
  return w;
};

test('repair: greedy alone strands U for some seeds; the ejection chain places it by moving the blocker', () => {
  const w = deadEnd();
  const u = sessionOf(w, 'Y', 'T2').id;
  const b = sessionOf(w, 'X', 'T1').id;
  let stranded = 0;
  for (let seed = 1; seed <= 16; seed++) {
    const without = generate({ snapshot: w, seed, repair: { enabled: false } });
    const withRepair = generate({ snapshot: w, seed });
    assert.equal(withRepair.unplaced.length, 0, `seed ${seed}: repair places everything`);
    assert.deepEqual(judge(w, withRepair).integrity.violations, []);
    if (without.unplaced.length) {
      stranded += 1;
      assert.deepEqual(without.unplaced.map((x) => x.session_id), [u]);
      assert.equal(without.unplaced[0].code, 'FACULTY_BUSY');
      assert.equal(withRepair.stats.repair_moves, 1, `seed ${seed}`);
      const snap = judge(w, withRepair).snap;
      const sb = snap.sessions.find((s) => s.id === b);
      const su = snap.sessions.find((s) => s.id === u);
      assert.equal(su.start_min, 510);
      assert.equal(sb.start_min, 570, 'the blocker moved to the other cell');
    } else assert.equal(withRepair.stats.repair_moves, 0);
  }
  assert.ok(stranded >= 1 && stranded < 16, `the setup strands greedy for some seeds (${stranded}/16)`);
});

test('repair: directly on a constructed greedy state (U has no candidate before, one after)', () => {
  const w = deadEnd();
  const u = sessionOf(w, 'Y', 'T2').id;
  const b = sessionOf(w, 'X', 'T1').id;
  const m = new OccupancyModel(w);
  const e = m.evaluate(b, 0, 510);
  m.place(b, 0, 510, e.end, e.room_id, e.shared);
  assert.equal(theoryCandidates(m, u, { strict: false }).length, 0, 'greedy cannot place U');
  const unit = { unit_id: 'b', kind: 'theory', sids: [b], score: 0 };
  const unitOf = new Map([[b, unit]]);
  const added = [];
  const r = repairUnplaced(m, { config: undefined, seed: 1, unitOf, targets: [u], addUnit: (sids, kind, score) => { const x = { unit_id: sids.join('+'), kind, sids, score }; added.push(x); unitOf.set(sids[0], x); return x; } });
  assert.equal(r.moves, 1);
  assert.deepEqual(r.repaired, [u]);
  assert.equal(m.placed.get(u).start, 510);
  assert.equal(m.placed.get(b).start, 570);
  assert.equal(added.length, 1);
});

test('repair: a fixed (pre-placed) blocker is never moved, a locked one neither', () => {
  const w = deadEnd();
  const b = sessionOf(w, 'X', 'T1');
  placeIn(w, b, 0, 510, roomId(w, 'C1')); // pre-placed: fixed in fill_unplaced
  const r = generate({ snapshot: w, seed: 1 });
  assert.equal(r.stats.repair_moves, 0);
  assert.equal(r.unplaced.length, 1);
  assert.equal(r.unplaced[0].subject_code, 'T2');
  // regenerate_unlocked with a locked blocker: the locked session is never touched (Y/T3 is unlocked and re-planned)
  b.locked = true;
  const g = generate({ snapshot: w, seed: 1, mode: 'regenerate_unlocked' });
  assert.deepEqual(g.unplace_ids, [sessionOf(w, 'Y', 'T3').id]);
  assert.ok(!g.units.some((u) => u.placements.some((p) => p.session_id === b.id)));
  const j = judge(w, g);
  assert.deepEqual(j.integrity.violations, []);
  assert.equal(j.snap.sessions.find((s) => s.id === b.id).start_min, 510);
  assert.equal(g.unplaced.length, 0);
});

test('repair is bounded and switchable (maxMoves 0, enabled false)', () => {
  const w = deadEnd();
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const plain = generate({ snapshot: w, seed, repair: { enabled: false } });
    if (!plain.unplaced.length) continue;
    assert.equal(generate({ snapshot: w, seed, repair: { maxMoves: 0 } }).unplaced.length, 1);
    assert.equal(generate({ snapshot: w, seed, repair: { maxAttemptsPerSession: 0 } }).unplaced.length, 1);
    assert.equal(generate({ snapshot: w, seed }).unplaced.length, 0);
    return;
  }
  assert.fail('no stranded seed found');
});

// ---- labs: a whole block is moved, the rotation invariants survive ---------------------------------------------
// Day of two lab cells (08:30, 10:45). Block B1 = X1/L1 (teacher P) + X2/L1 (teacher Q) in parallel, preferred at 10:45.
// Y1/L1 (teacher P) can only run at 10:45 because a fixed lecture holds Y at 08:30. Repair moves the whole block to 08:30.
const labDeadEnd = () => {
  const w = mini({
    term: { working_days: [0], day_end_min: 765 },
    rooms: [{ name: 'C1', cap: 60 }, { name: 'LAB1', lab: true, cap: 62 }, { name: 'LAB2', lab: true, cap: 62 }],
    faculty: ['P', 'Q', 'R'],
    subjects: [{ code: 'L1', kind: 'lab', weekly: 1 }, { code: 'T9', kind: 'theory', weekly: 1 }],
    divisions: [{ name: 'X', students: 40, batches: [['X1', 20], ['X2', 20]], home: 'C1' }, { name: 'Y', students: 20, batches: [['Y1', 20]], home: 'C1' }],
    offerings: [
      { div: 'X', code: 'L1', faculty: 'P', batch: 'X1' }, { div: 'X', code: 'L1', faculty: 'Q', batch: 'X2' },
      { div: 'Y', code: 'L1', faculty: 'P', batch: 'Y1' }, { div: 'Y', code: 'T9', faculty: 'R' },
    ],
  });
  placeIn(w, sessionOf(w, 'Y', 'T9'), 0, 510, roomId(w, 'C1'));
  return w;
};

test('repair: a lab block moves as a whole unit and keeps its invariants (one session per batch, parallel, disjoint teachers)', () => {
  const w = labDeadEnd();
  const plain = generate({ snapshot: w, seed: 1, repair: { enabled: false } });
  assert.equal(plain.unplaced.length, 1, 'greedy strands Y1/L1');
  assert.equal(plain.unplaced[0].subject_code, 'L1');
  const r = generate({ snapshot: w, seed: 1 });
  assert.equal(r.unplaced.length, 0);
  assert.equal(r.stats.repair_moves, 1);
  const { snap, integrity } = judge(w, r);
  assert.deepEqual(integrity.violations, []);
  const at = (div, code, batch) => snap.sessions.find((s) => s.id === sessionOf(w, div, code, batch).id);
  const x1 = at('X', 'L1', 'X1');
  const x2 = at('X', 'L1', 'X2');
  const y1 = at('Y', 'L1', 'Y1');
  assert.deepEqual([x1.weekday, x1.start_min], [x2.weekday, x2.start_min], 'the block still runs in parallel');
  assert.equal(x1.start_min, 510);
  assert.equal(y1.start_min, 645);
  const labUnit = r.units.filter((u) => u.kind === 'lab_block');
  assert.ok(labUnit.some((u) => u.placements.length === 2), 'the moved block is still one unit of two placements');
  assert.equal(new Set(r.units.map((u) => u.unit_id)).size, r.units.length);
  assert.ok(r.units.flatMap((u) => u.placements).every((p) => p.room_id));
});

test('repair is deterministic', () => {
  const w = labDeadEnd();
  const a = generate({ snapshot: w, seed: 1 });
  const b = generate({ snapshot: w, seed: 1 });
  assert.deepEqual(a.units, b.units);
  assert.deepEqual(applyResult(w, a).sessions.map((s) => s.start_min), applyResult(w, b).sessions.map((s) => s.start_min));
});
