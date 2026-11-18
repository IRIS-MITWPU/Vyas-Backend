import test from 'node:test';
import assert from 'node:assert/strict';
import { OccupancyModel } from '../../../services/planner/engine/model.js';
import { theoryCandidates, labBlockCandidates, labStartPenalty, divisionOrder } from '../../../services/planner/engine/rank.js';
import { standardStarts, fmt } from '../../../services/planner/engine/time.js';
import { buildEngineConfig } from '../../../services/planner/engine/config.js';
import { mini, sessionOf, roomId } from '../real/lib/testkit.mjs';

const SOFT_IDLE = buildEngineConfig([{ rule_key: 'student_idle_gap', enabled: true, severity: 'soft', weight: 1, params: { max_gap_minutes: 60 } }]); // these tests predate the hard no-idle-time default


const MON = 0;
const rooms = [{ name: 'C1', cap: 60 }, { name: 'C2', cap: 60 }, { name: 'LAB1', lab: true, cap: 62 }, { name: 'LAB2', lab: true, cap: 62 }, { name: 'LAB3', lab: true, cap: 62 }];

function theoryWorld(weekly = 2, extra = {}) {
  return mini({
    rooms,
    faculty: ['A', 'B', 'C'],
    subjects: [{ code: 'T1', kind: 'theory', weekly }, { code: 'T2', kind: 'theory', weekly: 1 }, { code: 'T3', kind: 'theory', weekly: 1 }, { code: 'T4', kind: 'theory', weekly: 1 }],
    divisions: [{ name: 'X', students: 60, home: 'C1' }],
    offerings: [{ div: 'X', code: 'T1', faculty: 'A' }, { div: 'X', code: 'T2', faculty: 'B' }, { div: 'X', code: 'T3', faculty: 'C' }, { div: 'X', code: 'T4', faculty: 'B' }],
    ...extra,
  });
}

function put(m, w, code, seq, day, start) {
  const s = sessionOf(w, 'X', code, 'ALL', seq);
  const e = m.evaluate(s.id, day, start);
  assert.equal(e.ok, true, `${code} ${day} ${fmt(start)}`);
  m.place(s.id, day, start, e.end, e.room_id, e.shared);
  return s;
}

test('rank: theory candidates only use standard cell starts, never a break, and every day of the term', () => {
  const w = theoryWorld();
  const m = new OccupancyModel(w);
  const c = theoryCandidates(m, sessionOf(w, 'X', 'T1', 'ALL', 1).id, { seed: 1 });
  const std = new Set(standardStarts(m.shape, 60));
  assert.ok(c.length > 0);
  assert.equal(new Set(c.map((x) => x.day)).size, 5);
  for (const x of c) {
    assert.ok(std.has(x.start));
    assert.equal(x.end, x.start + 60);
    for (const b of m.shape.breaks) assert.ok(!(x.start < b.end && x.end > b.start));
  }
  assert.ok(c.every((x, i) => i === 0 || c[i - 1].score <= x.score), 'sorted by score');
});

test('rank: working days and breaks come from the term (3-day week, no 15:45 columns)', () => {
  const w = theoryWorld(2, { term: { working_days: [0, 2, 4], day_end_min: 930 } });
  const m = new OccupancyModel(w);
  const c = theoryCandidates(m, sessionOf(w, 'X', 'T1', 'ALL', 1).id, {});
  assert.deepEqual([...new Set(c.map((x) => x.day))].sort(), [0, 2, 4]);
  assert.ok(c.every((x) => x.end <= 930));
});

test('rank: core hours beat the morning, the morning beats 15:45 onwards', () => {
  const w = theoryWorld();
  const m = new OccupancyModel(w);
  const c = theoryCandidates(m, sessionOf(w, 'X', 'T1', 'ALL', 1).id, { seed: 1 });
  const score = (start) => Math.min(...c.filter((x) => x.start === start).map((x) => x.score));
  assert.ok(score(645) < score(510), '10:45 beats 08:30');
  assert.ok(score(810) < score(570), '13:30 beats 09:30');
  assert.ok(score(510) < score(945), '08:30 beats 15:45');
  assert.ok(score(945) < score(1005), '15:45 beats 16:45');
  assert.ok(c[0].start >= 645 && c[0].end <= 930, 'best candidate is inside the core window');
});

test('rank: the least loaded day is preferred', () => {
  const w = theoryWorld();
  const m = new OccupancyModel(w);
  put(m, w, 'T2', 1, MON, 645);
  put(m, w, 'T3', 1, MON, 705);
  const c = theoryCandidates(m, sessionOf(w, 'X', 'T4', 'ALL', 1).id, { seed: 1 });
  assert.notEqual(c[0].day, MON);
  const monBest = Math.min(...c.filter((x) => x.day === MON).map((x) => x.score));
  const tueBest = Math.min(...c.filter((x) => x.day === 1).map((x) => x.score));
  assert.ok(tueBest < monBest);
});

test('rank: a subject is not repeated on the same day (weekly count <= days)', () => {
  const w = theoryWorld(2);
  const m = new OccupancyModel(w);
  put(m, w, 'T1', 1, MON, 645);
  const c = theoryCandidates(m, sessionOf(w, 'X', 'T1', 'ALL', 2).id, {});
  assert.ok(c.every((x) => x.day !== MON), 'strict pass: never the same day');
  const relaxed = theoryCandidates(m, sessionOf(w, 'X', 'T1', 'ALL', 2).id, { strict: false });
  assert.ok(relaxed.every((x) => x.day !== MON), 'hard rule: also in the relaxed pass');
  assert.ok(relaxed.length > c.length, 'the relaxed pass only adds non-standard starts');
});

test('rank: a subject with more weekly slots than days may repeat, but only back to back', () => {
  const w = theoryWorld(6);
  const m = new OccupancyModel(w);
  put(m, w, 'T1', 1, MON, 645);
  const c = theoryCandidates(m, sessionOf(w, 'X', 'T1', 'ALL', 2).id, {});
  const mon = c.filter((x) => x.day === MON).map((x) => x.start).sort((a, b) => a - b);
  assert.deepEqual(mon, [705]); // only 11:45 is adjacent (the cell before 10:45 ends at the 10:30 break)
});

test('rank: runs longer than 3 consecutive hours are penalised, lunch ends a run', () => {
  const w = theoryWorld();
  const m = new OccupancyModel(w);
  put(m, w, 'T2', 1, MON, 510);
  put(m, w, 'T3', 1, MON, 570);
  put(m, w, 'T1', 1, MON, 645); // 08:30-11:45 = 3 h run (short break only)
  const c = theoryCandidates(m, sessionOf(w, 'X', 'T4', 'ALL', 1).id, { strict: false, config: SOFT_IDLE });
  const at = (start) => c.find((x) => x.day === MON && x.start === start);
  assert.ok(at(705).parts.runDivision >= 15, '11:45 would make a 4 h run');
  assert.equal(at(810).parts.runDivision, 0, '13:30 starts a new run after lunch');
});

test('rank: strict pass caps a division day at 6 teaching hours', () => {
  const w = mini({
    rooms,
    faculty: ['A', 'B', 'C', 'D', 'E', 'F', 'G'],
    subjects: ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'].map((code) => ({ code, kind: 'theory', weekly: 1 })),
    divisions: [{ name: 'X', students: 60, home: 'C1' }],
    offerings: ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'].map((code, i) => ({ div: 'X', code, faculty: 'ABCDEFG'[i] })),
  });
  const m = new OccupancyModel(w);
  [510, 570, 645, 705, 810, 870].forEach((s, i) => put(m, w, `T${i + 1}`, 1, MON, s));
  const t7 = sessionOf(w, 'X', 'T7', 'ALL', 1).id;
  assert.ok(theoryCandidates(m, t7, { strict: true }).every((x) => x.day !== MON), 'seventh hour on Monday is refused (strict)');
  assert.ok(theoryCandidates(m, t7, { strict: false }).some((x) => x.day === MON && x.parts.dayOverload > 0), 'but allowed with a penalty in the relaxed pass');
});

test('rank: busy teachers remove slots from the candidate list', () => {
  const w = theoryWorld();
  const m = new OccupancyModel(w);
  put(m, w, 'T2', 1, MON, 645); // teacher B
  const c = theoryCandidates(m, sessionOf(w, 'X', 'T4', 'ALL', 1).id, {}); // T4 is also taught by B
  assert.ok(!c.some((x) => x.day === MON && x.start === 645));
});

test('rank: seeded ranking is deterministic', () => {
  const w = theoryWorld();
  const m = new OccupancyModel(w);
  const id = sessionOf(w, 'X', 'T1', 'ALL', 1).id;
  const a = theoryCandidates(m, id, { seed: 7 }).map((x) => `${x.day}|${x.start}`);
  const b = theoryCandidates(m, id, { seed: 7 }).map((x) => `${x.day}|${x.start}`);
  assert.deepEqual(a, b);
});

function labWorld() {
  return mini({
    rooms,
    faculty: ['A', 'B', 'C', 'D'],
    subjects: [{ code: 'L1', kind: 'lab', weekly: 1 }, { code: 'L2', kind: 'lab', weekly: 1 }, { code: 'T1', kind: 'theory', weekly: 1 }],
    divisions: [{ name: 'X', students: 40, batches: [['X1', 20], ['X2', 20]], home: 'C1' }],
    offerings: [{ div: 'X', code: 'L1', faculty: 'A' }, { div: 'X', code: 'L2', faculty: 'B' }, { div: 'X', code: 'T1', faculty: 'C' }],
  });
}
const blockOf = (w, m) => ({ key: 'b1', sessions: [sessionOf(w, 'X', 'L1', 'X1'), sessionOf(w, 'X', 'L2', 'X2')].map((s) => ({ id: s.id })) });

test('rank: lab blocks start only at 10:45, 13:30, 08:30 or 15:45, in that preference order', () => {
  const w = labWorld();
  const m = new OccupancyModel(w);
  const c = labBlockCandidates(m, blockOf(w, m), { seed: 1 });
  assert.deepEqual([...new Set(c.map((x) => x.start))].sort((a, b) => a - b), [510, 645, 810, 945]);
  const pen = (s) => labStartPenalty(s);
  assert.ok(pen(645) < pen(810) && pen(810) < pen(510) && pen(510) < pen(945));
  const best = (s) => Math.min(...c.filter((x) => x.start === s).map((x) => x.score));
  assert.ok(best(645) < best(810) && best(810) < best(510) && best(510) < best(945));
  assert.equal(c[0].start, 645);
  assert.ok(c.every((x) => x.end - x.start === 120));
});

test('rank: strict lab placement allows at most one lab block per batch per day', () => {
  const w = labWorld();
  const m = new OccupancyModel(w);
  const first = blockOf(w, m);
  const t = m.tryBlock(first.sessions.map((s) => ({ sid: s.id })), MON, 645);
  assert.equal(t.ok, true);
  for (const p of t.plan) m.place(p.sid, MON, 645, p.end, p.room_id, p.shared);
  // a second block of the same division (other subjects) on Monday: refused when strict
  const w2 = mini({
    rooms,
    faculty: ['A', 'B', 'C', 'D'],
    subjects: [{ code: 'L1', kind: 'lab', weekly: 1 }, { code: 'L2', kind: 'lab', weekly: 1 }, { code: 'L3', kind: 'lab', weekly: 1 }, { code: 'L4', kind: 'lab', weekly: 1 }],
    divisions: [{ name: 'X', students: 40, batches: [['X1', 20], ['X2', 20]], home: 'C1' }],
    offerings: ['L1', 'L2', 'L3', 'L4'].map((code, i) => ({ div: 'X', code, faculty: 'ABCD'[i] })),
  });
  const m2 = new OccupancyModel(w2);
  const b1 = { key: 'b1', sessions: [sessionOf(w2, 'X', 'L1', 'X1'), sessionOf(w2, 'X', 'L2', 'X2')].map((s) => ({ id: s.id })) };
  const b2 = { key: 'b2', sessions: [sessionOf(w2, 'X', 'L2', 'X1'), sessionOf(w2, 'X', 'L1', 'X2')].map((s) => ({ id: s.id })) };
  const t1 = m2.tryBlock(b1.sessions.map((s) => ({ sid: s.id })), MON, 645);
  for (const p of t1.plan) m2.place(p.sid, MON, 645, p.end, p.room_id, p.shared);
  assert.ok(labBlockCandidates(m2, b2, { strict: true }).every((x) => x.day !== MON));
  assert.ok(labBlockCandidates(m2, b2, { strict: false }).every((x) => x.day !== MON), 'hard rule: also in the relaxed pass');
});

test('rank: lab candidates need all teachers and all batches free, and a lab room for every batch', () => {
  const w = labWorld();
  const m = new OccupancyModel(w);
  const th = sessionOf(w, 'X', 'T1', 'ALL', 1);
  const e = m.evaluate(th.id, MON, 645);
  m.place(th.id, MON, 645, e.end, e.room_id, e.shared); // whole division busy 10:45-11:45
  const c = labBlockCandidates(m, blockOf(w, m), { config: SOFT_IDLE });
  assert.ok(!c.some((x) => x.day === MON && x.start === 645), 'overlaps the lecture');
  assert.ok(c.some((x) => x.day === MON && x.start === 810));
  // no lab rooms at all -> nothing feasible
  const w2 = mini({ rooms: [{ name: 'C1', cap: 60 }], faculty: ['A', 'B'], subjects: [{ code: 'L1', kind: 'lab', weekly: 1 }, { code: 'L2', kind: 'lab', weekly: 1 }], divisions: [{ name: 'X', students: 40, batches: [['X1', 20], ['X2', 20]] }], offerings: [{ div: 'X', code: 'L1', faculty: 'A' }, { div: 'X', code: 'L2', faculty: 'B' }] });
  const m2 = new OccupancyModel(w2);
  assert.equal(labBlockCandidates(m2, { key: 'b', sessions: [sessionOf(w2, 'X', 'L1', 'X1'), sessionOf(w2, 'X', 'L2', 'X2')].map((s) => ({ id: s.id })) }, {}).length, 0);
  void roomId;
});

test('rank: a lab block plan carries an explicit room for every batch, packed into one shared lab when it fits', () => {
  const w = labWorld();
  const m = new OccupancyModel(w);
  const c = labBlockCandidates(m, blockOf(w, m), {});
  assert.ok(c.length > 0);
  for (const x of c) {
    assert.ok(x.plan.every((p) => p.room_id && p.shared));
    assert.equal(new Set(x.plan.map((p) => p.room_id)).size, 1, '20 + 20 <= 62: both batches in one lab');
  }
});

test('rank: divisions are ordered by the load of their teachers, then by lab subjects', () => {
  const w = mini({
    rooms,
    faculty: ['HEAVY', 'LIGHT', 'L2'],
    subjects: [{ code: 'T1', kind: 'theory', weekly: 5 }, { code: 'T2', kind: 'theory', weekly: 1 }, { code: 'L1', kind: 'lab', weekly: 1 }],
    divisions: [{ name: 'A', students: 60 }, { name: 'B', students: 60 }, { name: 'C', students: 60, batches: [['C1', 30], ['C2', 30]] }],
    offerings: [{ div: 'A', code: 'T2', faculty: 'LIGHT' }, { div: 'B', code: 'T1', faculty: 'HEAVY' }, { div: 'C', code: 'T2', faculty: 'LIGHT' }, { div: 'C', code: 'L1', faculty: 'L2' }],
  });
  const m = new OccupancyModel(w);
  const order = divisionOrder(m).map((d) => d.key.split('|')[1]);
  assert.deepEqual(order, ['B', 'C', 'A']); // heaviest teacher first (B: 5 h), then C (a 4 h lab teacher), then A
});

// ---- per-batch theory (contract 9.9): once-per-day / spread rules compare a session with its OWN batch only ----

/** One division, 3 batches, ONE per-batch theory offering (weekly 2): 6 sessions (2 per batch), all taught by teacher A. */
function perBatchTheoryWorld() {
  const w = mini({
    rooms,
    faculty: ['A'],
    subjects: [{ code: 'T1', kind: 'theory', weekly: 2 }],
    divisions: [{ name: 'X', students: 60, batches: [['X1', 20], ['X2', 20], ['X3', 20]], home: 'C1' }],
    offerings: [{ div: 'X', code: 'T1', faculty: 'A' }],
  });
  const tmpl = w.sessions[0];
  w.offerings.forEach((o) => { o.per_batch = true; });
  const div = w.divisions.find((d) => d.name === 'X');
  w.sessions = [];
  for (const b of div.batches.filter((x) => !x.is_whole)) {
    for (const seq of [1, 2]) w.sessions.push({ ...tmpl, id: `ses-pb-${b.name}-${seq}`, batch_id: b.id, batch_name: b.name, seq, weekday: null, start_min: null, end_min: null, room_id: null });
  }
  return w;
}

test('rank: per-batch theory: a batch is not blocked from a day only because ANOTHER batch of the same offering sits there', () => {
  const w = perBatchTheoryWorld();
  const m = new OccupancyModel(w);
  const sid = (batch, seq) => w.sessions.find((s) => s.batch_name === batch && s.seq === seq).id;
  const e = m.evaluate(sid('X1', 1), MON, 510);
  assert.equal(e.ok, true);
  m.place(sid('X1', 1), MON, 510, e.end, e.room_id, e.shared);
  const days = (id) => new Set(theoryCandidates(m, id, { seed: 1, strict: false }).map((c) => c.day));
  assert.ok(days(sid('X2', 1)).has(MON), 'another batch may use Monday');
  assert.ok(!days(sid('X1', 2)).has(MON), 'the same batch still may not have its second session the same day');
});

test('generate: a 3-batch per-batch theory offering with weekly 2 places all 6 sessions (batches no longer compete for the 5 days)', async () => {
  const { generate } = await import('../../../services/planner/engine/index.js');
  const w = perBatchTheoryWorld();
  const r = generate({ snapshot: w, seed: 1, seeds: 2 });
  assert.equal(r.unplaced.length, 0, JSON.stringify(r.unplaced));
  assert.equal(r.stats.placed, 6);
  const byBatch = new Map();
  for (const p of r.units.flatMap((u) => u.placements)) {
    const s = w.sessions.find((x) => x.id === p.session_id);
    (byBatch.get(s.batch_name) ?? byBatch.set(s.batch_name, []).get(s.batch_name)).push(p.weekday);
  }
  for (const [batch, ds] of byBatch) assert.equal(new Set(ds).size, ds.length, `${batch}: two sessions on different days`);
});

test('diagnose: a session no start time of the week can hold (total slots 0) is NO_ROOM with a dedicated text, not an empty FACULTY_BUSY', async () => {
  const { generate } = await import('../../../services/planner/engine/index.js');
  const w = mini({
    rooms,
    faculty: ['A'],
    subjects: [{ code: 'BIG', kind: 'theory', weekly: 1, dur: 900 }],
    divisions: [{ name: 'X', students: 20, home: 'C1' }],
    offerings: [{ div: 'X', code: 'BIG', faculty: 'A' }],
  });
  const r = generate({ snapshot: w, seed: 1 });
  assert.equal(r.unplaced.length, 1);
  assert.equal(r.unplaced[0].code, 'NO_ROOM');
  assert.match(r.unplaced[0].text, /No time slot of the week is long enough for this 900-minute session/);
});
