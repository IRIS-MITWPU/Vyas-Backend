import test from 'node:test';
import assert from 'node:assert/strict';
import { generate, GenerationCancelled, buildEngineConfig } from '../../../services/planner/engine/index.js';
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

/** Placement of every session by natural key (division|subject|batch|seq), independent of ids. */
function naturalPlacements(snap) {
  const bn = new Map(snap.divisions.flatMap((d) => d.batches.map((b) => [b.id, `${d.semester}|${d.name}`])));
  return snap.sessions
    .filter((s) => s.weekday !== null)
    .map((s) => `${bn.get(s.batch_id)}|${s.subject_code}|${s.batch_name}|${s.seq}:${s.weekday}:${s.start_min}`)
    .sort()
    .join('|');
}

const smallWorld = (term = {}) =>
  mini({
    term,
    rooms: [{ name: 'C1', cap: 60 }, { name: 'C2', cap: 60 }, { name: 'LAB1', lab: true, cap: 62 }, { name: 'LAB2', lab: true, cap: 62 }],
    faculty: ['A', 'B', 'C', 'D', 'E'],
    subjects: [{ code: 'T1', kind: 'theory', weekly: 3 }, { code: 'T2', kind: 'theory', weekly: 2 }, { code: 'L1', kind: 'lab', weekly: 1 }, { code: 'L2', kind: 'lab', weekly: 1 }],
    divisions: [
      { name: 'X', students: 40, batches: [['X1', 20], ['X2', 20]], home: 'C1' },
      { name: 'Y', students: 40, batches: [['Y1', 20], ['Y2', 20]], home: 'C2' },
    ],
    offerings: [
      { div: 'X', code: 'T1', faculty: 'A' }, { div: 'X', code: 'T2', faculty: 'B' }, { div: 'X', code: 'L1', faculty: 'C' }, { div: 'X', code: 'L2', faculty: 'D|E' },
      { div: 'Y', code: 'T1', faculty: 'A' }, { div: 'Y', code: 'T2', faculty: 'B' }, { div: 'Y', code: 'L1', faculty: 'C' }, { div: 'Y', code: 'L2', faculty: 'D' },
    ],
  });

const strip = (r) => ({ units: r.units, unplaced: r.unplaced, unplace_ids: r.unplace_ids, stats: { ...r.stats, duration_ms: 0 } });

test('generate: a small world is placed completely and clash-free (independent judge)', () => {
  const w = smallWorld();
  const r = generate({ snapshot: w, seed: 3 });
  assert.equal(r.unplaced.length, 0);
  assert.equal(r.stats.requested, w.sessions.length);
  assert.equal(r.stats.placed, w.sessions.length);
  const { snap, integrity } = judge(w, r);
  assert.deepEqual(integrity.violations, []);
  assert.ok(snap.sessions.every((s) => s.weekday !== null));
  // a batch never has two lab subjects on one day
  const perBatchDay = new Map();
  for (const s of snap.sessions.filter((x) => x.kind === 'lab')) perBatchDay.set(`${s.batch_id}|${s.weekday}`, (perBatchDay.get(`${s.batch_id}|${s.weekday}`) || 0) + 1);
  assert.ok([...perBatchDay.values()].every((n) => n === 1));
});

test('generate: output shape, explicit rooms, short unit ids + natural keys, lab blocks carry one placement per batch', () => {
  const w = smallWorld();
  const r = generate({ snapshot: w, seed: 1 });
  assert.ok(r.units.some((u) => u.kind === 'lab_block' && u.placements.length === 2));
  assert.ok(r.units.some((u) => u.kind === 'theory' && u.placements.length === 1));
  const ids = new Set();
  for (const u of r.units) {
    assert.ok(!ids.has(u.unit_id), 'unit ids are unique');
    ids.add(u.unit_id);
    assert.match(u.unit_id, /^u\d+$/, 'short unit id');
    assert.ok(/^\d+\|/.test(u.key) && !/ses-|div-|off-/.test(u.key), `natural key: ${u.key}`);
    for (const p of u.placements) {
      assert.deepEqual(Object.keys(p).sort(), ['expect', 'room_id', 'session_id', 'start_min', 'weekday']);
      assert.ok(p.room_id, 'explicit room for every placement');
    }
    if (u.kind === 'lab_block') assert.ok(u.placements.every((p) => p.weekday === u.placements[0].weekday && p.start_min === u.placements[0].start_min));
  }
  assert.deepEqual(Object.keys(r.stats).sort(), ['best_seed', 'by_kind', 'duration_ms', 'placed', 'repair_moves', 'requested', 'score', 'seeds_tried', 'unplaced']);
  assert.deepEqual(r.stats.by_kind, { lab: { placed: 8, total: 8 }, theory: { placed: 10, total: 10 } });
});

test('generate: deterministic for a given seed, and the input snapshot is never mutated', () => {
  const w = smallWorld();
  const before = JSON.stringify(w);
  const a = strip(generate({ snapshot: w, seed: 5 }));
  const b = strip(generate({ snapshot: w, seed: 5 }));
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(w), before);
  assert.notDeepEqual(naturalPlacements(applyResult(w, generate({ snapshot: w, seed: 5 }))), naturalPlacements(applyResult(w, generate({ snapshot: w, seed: 6 }))), 'another seed gives another plan');
});

test('generate: the result does not depend on ids or snapshot order (stable across re-imports)', () => {
  const w = smallWorld();
  const a = applyResult(w, generate({ snapshot: w, seed: 4 }));
  const swap = (id) => `zz-${id}`;
  const renamed = JSON.parse(JSON.stringify(w), (k, v) => (typeof v === 'string' && /^(ses|off|div|fac|sub|room|tr)-/.test(v) ? swap(v) : v));
  renamed.sessions.reverse();
  renamed.faculty.reverse();
  renamed.divisions.reverse();
  renamed.rooms.reverse();
  const rb = generate({ snapshot: renamed, seed: 4 });
  const b = applyResult(renamed, rb);
  assert.equal(naturalPlacements(a), naturalPlacements(b));
  assert.deepEqual(rb.units.map((u) => u.key).sort(), generate({ snapshot: w, seed: 4 }).units.map((u) => u.key).sort());
});

test('generate: seeds N tries seed..seed+N-1 and keeps the best (fewest unplaced, then lowest score, then lowest seed)', () => {
  const w = smallWorld();
  const singles = [7, 8, 9, 10].map((s) => generate({ snapshot: w, seed: s, seeds: 1 }));
  const multi = generate({ snapshot: w, seed: 7, seeds: 4 });
  assert.equal(multi.stats.seeds_tried, 4);
  const rank = (r) => [r.stats.unplaced, r.stats.score, r.stats.best_seed];
  const bestSingle = [...singles].sort((a, b) => a.stats.unplaced - b.stats.unplaced || a.stats.score - b.stats.score || a.stats.best_seed - b.stats.best_seed)[0];
  assert.deepEqual(rank(multi), rank(bestSingle));
  assert.deepEqual(multi.units, bestSingle.units);
  assert.ok(multi.stats.best_seed >= 7 && multi.stats.best_seed <= 10);
});

test('generate: progress stages are announced in order with a monotonic percentage', () => {
  const w = smallWorld();
  const seen = [];
  generate({ snapshot: w, seed: 1, seeds: 2, onProgress: (stage, pct) => seen.push([stage, pct]) });
  const stages = [...new Set(seen.map((x) => x[0]))];
  assert.deepEqual(stages.slice(0, 1), ['loading']);
  for (const s of ['labs', 'theory', 'repair']) assert.ok(stages.includes(s), s);
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i][1] >= seen[i - 1][1], `monotonic at ${i}: ${seen[i - 1]} -> ${seen[i]}`);
  assert.equal(seen[0][1], 5);
  assert.ok(seen.every(([, p]) => p >= 5 && p <= 85));
  assert.ok(seen.filter(([s]) => s === 'labs').every(([, p]) => p >= 10 && p <= 85));
});

test('generate: isCancelled is polled between units and throws GenerationCancelled', () => {
  const w = smallWorld();
  let polls = 0;
  assert.throws(
    () => generate({ snapshot: w, isCancelled: () => ++polls > 3 }),
    (e) => e instanceof GenerationCancelled && e.code === 'CANCELLED',
  );
  assert.ok(polls >= 4 && polls < 60, `polled ${polls} times`);
});

test('generate: unknown mode is rejected', () => {
  assert.throws(() => generate({ snapshot: smallWorld(), mode: 'everything' }), /unknown generation mode/);
});

// ---- modes and scope ---------------------------------------------------------------------------------

test('fill_unplaced: pre-placed sessions are fixed obstacles and appear in no unit', () => {
  const w = smallWorld();
  const pre = sessionOf(w, 'X', 'T1', 'ALL', 1);
  placeIn(w, pre, 2, 645, roomId(w, 'C1'));
  const pre2 = sessionOf(w, 'Y', 'T2', 'ALL', 1);
  placeIn(w, pre2, 0, 510, roomId(w, 'C2'));
  const r = generate({ snapshot: w, seed: 2 });
  assert.deepEqual(r.unplace_ids, []);
  const touched = new Set(r.units.flatMap((u) => u.placements.map((p) => p.session_id)));
  assert.ok(!touched.has(pre.id) && !touched.has(pre2.id));
  assert.equal(r.stats.requested, w.sessions.length - 2);
  const { snap, integrity } = judge(w, r);
  assert.deepEqual(integrity.violations, []);
  const after = snap.sessions.find((s) => s.id === pre.id);
  assert.deepEqual([after.weekday, after.start_min, after.room_id], [2, 645, roomId(w, 'C1')]);
  // nothing else may use the pre-placed slot of its teacher / division
  assert.equal(r.unplaced.length, 0);
});

test('fill_unplaced on a complete timetable plans nothing', () => {
  const w = smallWorld();
  const full = applyResult(w, generate({ snapshot: w, seed: 1 }));
  const r = generate({ snapshot: full, seed: 1 });
  assert.deepEqual([r.units.length, r.unplaced.length, r.stats.requested], [0, 0, 0]);
});

test('regenerate_unlocked: locked sessions stay, unlocked ones in scope are re-planned (unplace_ids lists them)', () => {
  const w = smallWorld();
  const first = applyResult(w, generate({ snapshot: w, seed: 1 }));
  const locked = sessionOf(first, 'X', 'T1', 'ALL', 1);
  locked.locked = true;
  const lockedPos = [locked.weekday, locked.start_min, locked.room_id];
  const r = generate({ snapshot: first, mode: 'regenerate_unlocked', seed: 9 });
  assert.ok(!r.unplace_ids.includes(locked.id));
  assert.equal(r.unplace_ids.length, first.sessions.length - 1);
  assert.ok(!r.units.some((u) => u.placements.some((p) => p.session_id === locked.id)));
  assert.equal(r.unplaced.length, 0);
  const { snap, integrity } = judge(first, r);
  assert.deepEqual(integrity.violations, []);
  const after = snap.sessions.find((s) => s.id === locked.id);
  assert.deepEqual([after.weekday, after.start_min, after.room_id], lockedPos);
  assert.notEqual(naturalPlacements(first), naturalPlacements(snap), 'another seed re-plans the unlocked sessions');
});

test('regenerate_unlocked: a locked but unplaced session is reported LOCKED, not placed', () => {
  const w = smallWorld();
  sessionOf(w, 'X', 'T2', 'ALL', 1).locked = true;
  const r = generate({ snapshot: w, mode: 'regenerate_unlocked' });
  assert.equal(r.unplaced.length, 1);
  assert.equal(r.unplaced[0].code, 'LOCKED');
  assert.equal(r.unplaced[0].subject_code, 'T2');
  assert.deepEqual(Object.keys(r.unplaced[0]).sort(), ['batch_name', 'code', 'division_id', 'key', 'kind', 'session_id', 'subject_code', 'text']);
});

test('divisionIds: other divisions are fixed obstacles (untouched, not even reported)', () => {
  const w = smallWorld();
  const x = w.divisions.find((d) => d.name === 'X');
  const y = w.divisions.find((d) => d.name === 'Y');
  const first = applyResult(w, generate({ snapshot: w, seed: 1 }));
  // fill: only X is empty, Y is complete and fixed
  const partial = clone(first);
  const xBatches = new Set(x.batches.map((b) => b.id));
  for (const s of partial.sessions) if (xBatches.has(s.batch_id)) Object.assign(s, { weekday: null, start_min: null, end_min: null, room_id: null });
  const r = generate({ snapshot: partial, divisionIds: [x.id], seed: 3 });
  assert.equal(r.unplaced.length, 0);
  const xSessions = new Set(partial.sessions.filter((s) => xBatches.has(s.batch_id)).map((s) => s.id));
  assert.ok(r.units.every((u) => u.placements.every((p) => xSessions.has(p.session_id))));
  assert.deepEqual(judge(partial, r).integrity.violations, []);
  // regenerate: scope = Y; X (complete, unlocked) must not be cleared
  const g = generate({ snapshot: first, mode: 'regenerate_unlocked', divisionIds: [y.id], seed: 4 });
  const yBatches = new Set(y.batches.map((b) => b.id));
  assert.ok(g.unplace_ids.every((id) => yBatches.has(first.sessions.find((s) => s.id === id).batch_id)));
  assert.ok(g.units.every((u) => u.placements.every((p) => yBatches.has(first.sessions.find((s) => s.id === p.session_id).batch_id))));
  const after = judge(first, g);
  assert.deepEqual(after.integrity.violations, []);
  for (const s of first.sessions.filter((q) => xBatches.has(q.batch_id))) {
    const a = after.snap.sessions.find((q) => q.id === s.id);
    assert.deepEqual([a.weekday, a.start_min, a.room_id], [s.weekday, s.start_min, s.room_id]);
  }
});

test('unplaced sessions are diagnosed in plain English with the teacher named', () => {
  // one working day, two cells (08:30, 09:30), three divisions with the same teacher: one session cannot be placed
  const w = mini({
    term: { working_days: [0], day_end_min: 630 },
    rooms: [{ name: 'C1', cap: 60 }, { name: 'C2', cap: 60 }, { name: 'C3', cap: 60 }],
    faculty: ['A'],
    subjects: [{ code: 'T1', kind: 'theory', weekly: 1 }],
    divisions: [{ name: 'X', students: 60, home: 'C1' }, { name: 'Y', students: 60, home: 'C2' }, { name: 'Z', students: 60, home: 'C3' }],
    offerings: ['X', 'Y', 'Z'].map((d) => ({ div: d, code: 'T1', faculty: 'A' })),
  });
  const r = generate({ snapshot: w });
  assert.equal(r.stats.placed, 2);
  assert.equal(r.unplaced.length, 1);
  assert.equal(r.unplaced[0].code, 'FACULTY_BUSY');
  assert.match(r.unplaced[0].text, /^Prof A \(A\) is busy in all 5 slots\.$/);
  assert.deepEqual(judge(w, r).integrity.violations, []);
});

test('hard rules hold in every pass: a session that only fits by breaking one stays unplaced with POLICY_RULES', () => {
  const w = mini({
    term: { working_days: [0], day_end_min: 765 },
    rooms: [{ name: 'C1', cap: 60 }],
    faculty: ['A'],
    subjects: [{ code: 'T1', kind: 'theory', weekly: 3 }],
    divisions: [{ name: 'X', students: 60, home: 'C1' }],
    offerings: [{ div: 'X', code: 'T1', faculty: 'A' }],
  });
  const r = generate({ snapshot: w });
  assert.equal(r.unplaced.length, 1);
  assert.equal(r.unplaced[0].code, 'POLICY_RULES');
  const placed = applyResult(w, r).sessions.filter((s) => s.weekday !== null).sort((a, b) => a.start_min - b.start_min);
  assert.equal(placed.length, 2);
  assert.equal(placed[0].end_min, placed[1].start_min, 'the allowed repeat is back to back');
});

// ---- 9.1.5: the 32 h teacher -----------------------------------------------------------------------------

const heavyTeacherWorld = () =>
  mini({
    rooms: Array.from({ length: 8 }, (_, n) => ({ name: `C${n + 1}`, cap: 60 })),
    faculty: ['A'],
    subjects: [{ code: 'T1', kind: 'theory', weekly: 4 }],
    divisions: Array.from({ length: 8 }, (_, n) => ({ name: `D${n + 1}`, students: 60, home: `C${n + 1}` })),
    offerings: Array.from({ length: 8 }, (_, n) => ({ div: `D${n + 1}`, code: 'T1', faculty: 'A' })),
  });

const perDay = (snap) => {
  const m = new Map();
  for (const s of snap.sessions.filter((x) => x.weekday !== null)) m.set(s.weekday, (m.get(s.weekday) || 0) + 1);
  return [...m.values()];
};

test('a 32 h/week teacher is 100% placed under the default config (default_max_hours is only a penalty)', () => {
  const w = heavyTeacherWorld();
  assert.equal(w.sessions.length, 32);
  const r = generate({ snapshot: w, seed: 1 });
  assert.equal(r.unplaced.length, 0);
  const { snap, integrity } = judge(w, r);
  assert.deepEqual(integrity.violations, []);
  assert.ok(Math.max(...perDay(snap)) > 6, 'the week cannot fit into 6 h days: the soft limit is exceeded, on purpose');
});

test('...but the same teacher is capped when faculty_daily_load is set to hard', () => {
  const w = heavyTeacherWorld();
  const rules = [{ rule_key: 'faculty_daily_load', enabled: true, severity: 'hard', weight: 1, params: { default_max_hours: 6 } }];
  const r = generate({ snapshot: w, rules, seed: 1 });
  const { snap, integrity } = judge(w, r);
  assert.deepEqual(integrity.violations, []);
  assert.ok(Math.max(...perDay(snap)) <= 6);
  assert.ok(r.unplaced.length >= 2);
  assert.ok(r.unplaced.every((u) => u.code === 'POLICY_RULES'));
});

test('an explicit faculty.max_per_day is always a hard cap, whatever the rules say', () => {
  const w = heavyTeacherWorld();
  w.faculty[0].max_per_day = 5;
  const r = generate({ snapshot: w, seed: 1 });
  const { snap, integrity } = judge(w, r);
  assert.deepEqual(integrity.violations, []);
  assert.ok(Math.max(...perDay(snap)) <= 5);
  assert.equal(r.stats.placed, 25);
  assert.equal(r.unplaced.length, 7);
  assert.ok(r.unplaced.every((u) => u.code === 'POLICY_RULES'));
  // a disabled daily-load rule does not lift the explicit cap
  const off = generate({ snapshot: w, rules: [{ rule_key: 'faculty_daily_load', enabled: false, severity: 'soft', weight: 1, params: {} }], seed: 1 });
  assert.ok(Math.max(...perDay(judge(w, off).snap)) <= 5);
});

test('rule weights steer the plan: a heavier faculty_daily_load penalty never makes the busiest day worse', () => {
  const w = heavyTeacherWorld();
  const busiest = (rules) => Math.max(...perDay(judge(w, generate({ snapshot: w, rules, seed: 1 })).snap));
  const off = busiest([{ rule_key: 'faculty_daily_load', enabled: false, severity: 'soft', weight: 0, params: {} }]);
  const heavy = busiest([{ rule_key: 'faculty_daily_load', enabled: true, severity: 'soft', weight: 10, params: { default_max_hours: 6 } }]);
  assert.ok(heavy <= off, `${heavy} <= ${off}`);
  assert.ok(heavy <= 7, 'with the over-limit penalty the week is spread to at most 7 h/day (32 h over 5 days)');
});

test('buildEngineConfig is accepted by generate as a prebuilt config', () => {
  const w = smallWorld();
  const cfg = buildEngineConfig([]);
  assert.deepEqual(strip(generate({ snapshot: w, seed: 2, config: cfg })), strip(generate({ snapshot: w, seed: 2 })));
});

// ---- review amendments (contract 9.9) ----

test('generate: units get short deterministic ids u1..un (the commit never depends on long keys); the natural key stays in `key`; placements carry expect:null', () => {
  const w = smallWorld();
  const r = generate({ snapshot: w, seed: 2 });
  assert.deepEqual(r.units.map((u) => u.unit_id), r.units.map((_, k) => `u${k + 1}`));
  assert.ok(r.units.every((u) => u.unit_id.length <= 64 && /^\d+\|/.test(u.key)));
  assert.ok(r.units.every((u) => u.placements.every((p) => p.expect === null)));
  assert.deepEqual(r.units.map((u) => u.unit_id), generate({ snapshot: w, seed: 2 }).units.map((u) => u.unit_id));
});

test('regenerate_unlocked: `unplace` carries one {session_id, expect = the snapshot placement} per unplace id; fill mode has none', () => {
  const w = smallWorld();
  const first = applyResult(w, generate({ snapshot: w, seed: 1 }));
  const r = generate({ snapshot: first, mode: 'regenerate_unlocked', seed: 9 });
  assert.deepEqual(r.unplace.map((e) => e.session_id), r.unplace_ids);
  const by = new Map(first.sessions.map((s) => [s.id, s]));
  for (const e of r.unplace) {
    const s = by.get(e.session_id);
    assert.deepEqual(e.expect, { weekday: s.weekday, start_min: s.start_min, room_id: s.room_id });
  }
  assert.deepEqual(generate({ snapshot: w, seed: 1 }).unplace, []);
});

test('generate: a placement that fails the final domain check drops only ITS unit into `unplaced` (SERVER_REFUSED) and the run goes on', () => {
  const w = smallWorld();
  const victim = sessionOf(w, 'X', 'T2', 'ALL', 1);
  const base = generate({ snapshot: w, seed: 3 });
  // reject exactly the victim's slot (identified by its position in the plan)
  const slot = base.units.flatMap((u) => u.placements).find((p) => p.session_id === victim.id);
  const stub = (a) => (a.weekday === slot.weekday && a.start_min === slot.start_min && a.room_id === slot.room_id
    ? { ok: false, reason: 'OUTSIDE_HOURS', message: 'The start time is outside the working hours.' }
    : { ok: true, end_min: a.start_min + a.subject.duration_min });
  const r = generate({ snapshot: w, seed: 3, placementCheck: stub });
  const dropped = r.unplaced.filter((u) => u.code === 'SERVER_REFUSED');
  assert.ok(dropped.length >= 1);
  assert.ok(dropped.some((u) => u.session_id === victim.id));
  assert.ok(dropped.every((u) => u.text === 'The start time is outside the working hours.'));
  assert.equal(r.stats.unplaced, r.unplaced.length);
  assert.equal(r.stats.placed + r.stats.unplaced, r.stats.requested);
  const placedIds = new Set(r.units.flatMap((u) => u.placements.map((p) => p.session_id)));
  assert.ok(!placedIds.has(victim.id));
  assert.ok(r.units.length >= base.units.length - dropped.length);
  assert.deepEqual(r.units.map((u) => u.unit_id), r.units.map((_, k) => `u${k + 1}`));
});
