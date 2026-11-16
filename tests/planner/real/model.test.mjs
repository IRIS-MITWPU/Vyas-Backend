import test from 'node:test';
import assert from 'node:assert/strict';
import { OccupancyModel } from './lib/model.mjs';
import { mini, sessionOf, roomId, placeIn } from './lib/testkit.mjs';

const MON = 0;
const TUE = 1;
const rooms = [
  { name: 'C1', cap: 60 },
  { name: 'C2', cap: 60 },
  { name: 'LAB-SMALL', lab: true, cap: 32 },
  { name: 'LAB-BIG', lab: true, cap: 62 },
  { name: 'LAB-UNKNOWN', lab: true, cap: null },
];
const world = () =>
  mini({
    rooms,
    faculty: ['A', 'B', 'C', 'D'],
    subjects: [{ code: 'TH1', kind: 'theory', weekly: 2 }, { code: 'TH2', kind: 'theory', weekly: 1 }, { code: 'LB', kind: 'lab', weekly: 1 }, { code: 'LB2', kind: 'lab', weekly: 1 }],
    divisions: [
      { name: 'X', students: 60, batches: [['X1', 20], ['X2', 20], ['X3', 20]], home: 'C1' },
      { name: 'Y', students: 60, batches: [['Y1', 30], ['Y2', 30]], home: 'C1' },
    ],
    offerings: [
      { div: 'X', code: 'TH1', faculty: 'A' },
      { div: 'X', code: 'TH2', faculty: 'B' },
      { div: 'X', code: 'LB', faculty: 'C' },
      { div: 'X', code: 'LB2', faculty: 'D' },
      { div: 'Y', code: 'TH1', faculty: 'A' },
      { div: 'Y', code: 'LB', faculty: 'C' },
    ],
  });

test('model: faculty clash is detected, other days and other teachers are free', () => {
  const w = world();
  const m = new OccupancyModel(w);
  const a = sessionOf(w, 'X', 'TH1', 'ALL', 1);
  const b = sessionOf(w, 'Y', 'TH1', 'ALL', 1);
  const ev = m.evaluate(a.id, MON, 510);
  assert.equal(ev.ok, true);
  m.place(a.id, MON, 510, ev.end, ev.room_id, ev.shared);
  assert.deepEqual([m.evaluate(b.id, MON, 510).why, m.evaluate(b.id, MON, 510).detail.length], ['faculty', 1]);
  assert.equal(m.evaluate(b.id, MON, 570).ok, true); // next hour
  assert.equal(m.evaluate(b.id, TUE, 510).ok, true);
  m.unplace(a.id);
  assert.equal(m.evaluate(b.id, MON, 510).ok, true);
});

test('model: a whole-division lecture blocks every batch lab of that division, batch labs of one division do not block each other', () => {
  const w = world();
  const m = new OccupancyModel(w);
  const th = sessionOf(w, 'X', 'TH2', 'ALL', 1);
  const l1 = sessionOf(w, 'X', 'LB', 'X1');
  const l2 = sessionOf(w, 'X', 'LB2', 'X2');
  const e = m.evaluate(th.id, MON, 645);
  m.place(th.id, MON, 645, e.end, e.room_id, e.shared);
  assert.equal(m.evaluate(l1.id, MON, 645).why, 'batch'); // 10:45-12:45 overlaps the 10:45 lecture
  const e1 = m.evaluate(l1.id, MON, 810); // 13:30: free
  assert.equal(e1.ok, true);
  m.place(l1.id, MON, 810, e1.end, e1.room_id, e1.shared);
  assert.equal(m.evaluate(l2.id, MON, 810).ok, true); // other batch, other teacher, other lab subject
  // and the whole-division lecture is refused at the lab slot
  assert.equal(m.evaluate(th.id, MON, 810).why, 'batch');
});

test('model: classrooms are exclusive; the home room goes first, then the smallest free classroom', () => {
  const w = world();
  const m = new OccupancyModel(w);
  const x = sessionOf(w, 'X', 'TH1', 'ALL', 1);
  const y = sessionOf(w, 'Y', 'TH1', 'ALL', 1);
  const y2 = sessionOf(w, 'Y', 'TH1', 'ALL', 2);
  const ex = m.evaluate(x.id, MON, 510);
  assert.equal(ex.room_id, roomId(w, 'C1')); // home room
  m.place(x.id, MON, 510, ex.end, ex.room_id, false);
  // Y's teacher is A as well, so use another day/time pair where only the room matters: place Y TH1 on Tue and a second on Mon later
  const ey = m.evaluate(y.id, MON, 570);
  assert.equal(ey.room_id, roomId(w, 'C1')); // different time: home room is free again
  m.place(y.id, MON, 570, ey.end, ey.room_id, false);
  // same slot as an occupied home room, different teacher: use X TH2 (teacher B) vs Y... both divisions' home is C1
  const th2 = sessionOf(w, 'X', 'TH2', 'ALL', 1);
  const e2 = m.evaluate(th2.id, MON, 570);
  assert.equal(e2.ok, true);
  assert.equal(e2.room_id, roomId(w, 'C2'), 'home room busy -> smallest free classroom (name order)');
  m.place(th2.id, MON, 570, e2.end, e2.room_id, false);
  void y2;
});

test('model: no room left -> evaluate says room', () => {
  const w = mini({ rooms: [{ name: 'C1', cap: 60 }], faculty: ['A', 'B'], subjects: [{ code: 'T1', kind: 'theory', weekly: 1 }], divisions: [{ name: 'X', students: 60, home: 'C1' }, { name: 'Y', students: 60, home: 'C1' }], offerings: [{ div: 'X', code: 'T1', faculty: 'A' }, { div: 'Y', code: 'T1', faculty: 'B' }] });
  const m = new OccupancyModel(w);
  const x = sessionOf(w, 'X', 'T1');
  const y = sessionOf(w, 'Y', 'T1');
  const ex = m.evaluate(x.id, MON, 510);
  m.place(x.id, MON, 510, ex.end, ex.room_id, false);
  const ey = m.evaluate(y.id, MON, 510);
  assert.deepEqual([ey.ok, ey.why], [false, 'room']);
});

test('model: lab capacity sweep with concurrent sessions in one room', () => {
  const w = mini({
    rooms: [{ name: 'LAB-BIG', lab: true, cap: 62 }],
    faculty: ['A', 'B', 'C', 'D'],
    subjects: [{ code: 'L1', kind: 'lab', weekly: 1 }, { code: 'L2', kind: 'lab', weekly: 1 }, { code: 'L3', kind: 'lab', weekly: 1 }, { code: 'L4', kind: 'lab', weekly: 1 }],
    divisions: [
      { name: 'P', students: 60, batches: [['P1', 20], ['P2', 20], ['P3', 20]] },
      { name: 'Q', students: 60, batches: [['Q1', 20], ['Q2', 20], ['Q3', 20]] },
    ],
    offerings: [
      { div: 'P', code: 'L1', faculty: 'A', batch: 'P1' },
      { div: 'P', code: 'L2', faculty: 'B', batch: 'P2' },
      { div: 'P', code: 'L3', faculty: 'C', batch: 'P3' },
      { div: 'Q', code: 'L4', faculty: 'D', batch: 'Q1' },
    ],
  });
  const m = new OccupancyModel(w);
  const big = roomId(w, 'LAB-BIG');
  const [s1, s2, s3] = [sessionOf(w, 'P', 'L1', 'P1'), sessionOf(w, 'P', 'L2', 'P2'), sessionOf(w, 'P', 'L3', 'P3')];
  for (const s of [s1, s2, s3]) {
    // batches of one division are independent resources, teachers differ: all three may share the lab at once
    const e = m.evaluate(s.id, MON, 510, { room_id: big });
    assert.equal(e.ok, true, 'three 20-student batches fit a 62-seat lab');
    m.place(s.id, MON, 510, e.end, big, e.shared);
  }
  const q1 = sessionOf(w, 'Q', 'L4', 'Q1');
  const over = m.evaluate(q1.id, MON, 510, { room_id: big });
  assert.deepEqual([over.ok, over.why, over.detail], [false, 'room', 'ROOM_CAPACITY']); // 60 + 20 > 62
  assert.equal(m.evaluate(q1.id, MON, 645, { room_id: big }).ok, true); // later, nobody there
  assert.equal(m.evaluate(q1.id, MON, 570, { room_id: big }).ok, false); // overlaps 08:30-10:30 only partly: still 80 students
  m.unplace(s3.id);
  assert.equal(m.evaluate(q1.id, MON, 510, { room_id: big }).ok, true, '40 + 20 = 60 <= 62');
});

test('model: pickRoom packs labs into the fullest room that still fits (smallest capacity first when empty)', () => {
  const w = mini({
    rooms: [{ name: 'LAB-SMALL', lab: true, cap: 32 }, { name: 'LAB-BIG', lab: true, cap: 62 }, { name: 'LAB-UNKNOWN', lab: true, cap: null }],
    faculty: ['A', 'B', 'C'],
    subjects: [{ code: 'L1', kind: 'lab', weekly: 1 }],
    divisions: [{ name: 'P', students: 60, batches: [['P1', 20], ['P2', 20], ['P3', 20]] }, { name: 'Q', students: 60, batches: [['Q1', 30], ['Q2', 30]] }],
    offerings: [
      { div: 'P', code: 'L1', faculty: 'A', batch: 'P1' },
      { div: 'P', code: 'L1', faculty: 'B', batch: 'P2' },
      { div: 'P', code: 'L1', faculty: 'C', batch: 'P3' },
      { div: 'Q', code: 'L1', faculty: 'A', batch: 'Q1' },
    ],
  });
  const m = new OccupancyModel(w);
  const small = roomId(w, 'LAB-SMALL');
  const big = roomId(w, 'LAB-BIG');
  const [p1, p2, p3] = ['P1', 'P2', 'P3'].map((b) => sessionOf(w, 'P', 'L1', b));
  const e1 = m.evaluate(p1.id, MON, 510);
  assert.equal(e1.room_id, small, 'empty rooms: smallest capacity that fits');
  m.place(p1.id, MON, 510, e1.end, e1.room_id, e1.shared);
  const e2 = m.evaluate(p2.id, MON, 510);
  assert.equal(e2.room_id, big, '20 + 20 = 40 does not fit the 32 seater, so the 62 seater');
  m.place(p2.id, MON, 510, e2.end, e2.room_id, e2.shared);
  const e3 = m.evaluate(p3.id, MON, 510);
  assert.equal(e3.room_id, big, 'fullest room that still fits (62 seater holds 20, +20 = 40)');
  assert.equal(e3.joined, true);
  m.place(p3.id, MON, 510, e3.end, e3.room_id, e3.shared);
  // unknown capacity is only used when nothing with a known capacity fits
  const only = mini({ rooms: [{ name: 'LAB-UNKNOWN', lab: true, cap: null }], faculty: ['A'], subjects: [{ code: 'L1', kind: 'lab', weekly: 1 }], divisions: [{ name: 'P', students: 40, batches: [['P1', 20], ['P2', 20]] }], offerings: [{ div: 'P', code: 'L1', faculty: 'A', batch: 'P1' }] });
  const mo = new OccupancyModel(only);
  const r = mo.evaluate(sessionOf(only, 'P', 'L1', 'P1').id, MON, 510);
  assert.deepEqual([r.ok, r.shared], [true, false]);
});

test('model: sharedLabs=false makes labs exclusive', () => {
  const w = mini({
    rooms: [{ name: 'LAB-BIG', lab: true, cap: 62 }],
    faculty: ['A', 'B'],
    subjects: [{ code: 'L1', kind: 'lab', weekly: 1 }],
    divisions: [{ name: 'P', students: 40, batches: [['P1', 20], ['P2', 20]] }],
    offerings: [{ div: 'P', code: 'L1', faculty: 'A', batch: 'P1' }, { div: 'P', code: 'L1', faculty: 'B', batch: 'P2' }],
  });
  const [p1, p2] = ['P1', 'P2'].map((b) => sessionOf(w, 'P', 'L1', b));
  for (const [shared, expectOk] of [[true, true], [false, false]]) {
    const m = new OccupancyModel(w, { sharedLabs: shared });
    const e = m.evaluate(p1.id, MON, 510);
    m.place(p1.id, MON, 510, e.end, e.room_id, e.shared);
    assert.equal(m.evaluate(p2.id, MON, 510).ok, expectOk);
  }
});

test('model: placed sessions of the snapshot are loaded (resume) and tryBlock rolls back', () => {
  const w = world();
  const th = sessionOf(w, 'X', 'TH1', 'ALL', 1);
  placeIn(w, th, MON, 510, roomId(w, 'C1'));
  const m = new OccupancyModel(w);
  assert.equal(m.isPlaced(th.id), true);
  const other = sessionOf(w, 'Y', 'TH1', 'ALL', 1);
  assert.equal(m.evaluate(other.id, MON, 510).why, 'faculty');
  const l1 = sessionOf(w, 'X', 'LB', 'X1');
  const l2 = sessionOf(w, 'X', 'LB2', 'X2');
  const t = m.tryBlock([{ sid: l1.id }, { sid: l2.id }], MON, 645);
  assert.equal(t.ok, true);
  assert.equal(t.plan.length, 2);
  assert.equal(m.isPlaced(l1.id), false, 'tentative placement is rolled back');
  const bad = m.tryBlock([{ sid: l1.id }, { sid: l2.id }], MON, 510); // theory at 08:30 holds all batches
  assert.deepEqual([bad.ok, bad.why], [false, 'batch']);
  assert.equal(m.placed.size, 1);
});

test('model: invalid grid / break placements are refused with the placement reason', () => {
  const w = world();
  const m = new OccupancyModel(w);
  const a = sessionOf(w, 'X', 'TH1', 'ALL', 1);
  assert.deepEqual([m.evaluate(a.id, MON, 615).why, m.evaluate(a.id, MON, 615).detail], ['placement', 'OVERLAPS_BREAK']);
  assert.equal(m.evaluate(a.id, 5, 510).detail, 'NOT_WORKING_DAY');
  assert.equal(m.evaluate(a.id, MON, 1050).detail, 'OUTSIDE_HOURS');
});
