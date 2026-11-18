// Parity of the production engine with the test harness (tests/planner/real/lib/engine.mjs run through the offline
// fake server). Same seed => same placements, provided the engine uses the harness-equivalent config.
//
// Known, intended deviation: the production config adds `facultyOverDefault` (contract 9.2, 8 per hour a teacher's day
// exceeds faculty_daily_load.default_max_hours). The harness has no such penalty, so for the exact comparison it is
// switched off (harnessConfig below); a second test runs the true default config and only requires a complete,
// clash-free plan (the number of differing placements is printed).
import test from 'node:test';
import assert from 'node:assert/strict';
import { autoplace } from '../real/lib/engine.mjs';
import { FakeServer } from '../real/lib/fakeServer.mjs';
import { WEIGHTS as HARNESS_WEIGHTS, DEFAULTS as HARNESS_DEFAULTS } from '../real/lib/rank.mjs';
import { buildWorld } from '../real/lib/world.mjs';
import { loadImportRows, readJson, HAS_REAL, SKIP_REAL } from '../real/lib/fixtures.mjs';
import { mini } from '../real/lib/testkit.mjs';
import { generate, buildEngineConfig, defaultEngineConfig } from '../../../services/planner/engine/index.js';

import { checkIntegrity } from '../real/lib/integrity.mjs';

// ---- helpers (local copy, shared by no other file) ----
// Contract 10.3: a division with a home classroom is RESTRICTED to it in production; the harness only prefers it. The parity worlds
// therefore carry no home rooms (the restricted behaviour has its own tests).
const withoutHomeRooms = (w) => ({ ...w, divisions: w.divisions.map((d) => ({ ...d, home_room_id: null, home_room2_id: null, home_room_ids: [] })) });
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

const placementMap = (snap) => new Map(snap.sessions.map((s) => [s.id, `${s.weekday}:${s.start_min}:${s.room_id}`]));

const harnessConfig = () => {
  const c = defaultEngineConfig();
  // the harness has no hard idle-gap filter either (the production default is hard/0 since contract 10.1)
  return { ...c, weights: { ...c.weights, facultyOverDefault: 0 }, hard: { ...c.hard, divisionIdleGapMinutes: null } };
};

async function harness(world, seed) {
  const fake = new FakeServer(world);
  const result = await autoplace({ snapshot: world, send: (ops, cid) => fake.send({ client_id: cid, ops }), refetch: async () => fake.snapshot(), options: { seed } });
  return { fake, result, snap: fake.snapshot() };
}

function diff(a, b) {
  const pa = placementMap(a);
  const pb = placementMap(b);
  let n = 0;
  for (const [id, v] of pa) if (pb.get(id) !== v) n += 1;
  return n;
}

test('parity: the default config reproduces the harness WEIGHTS / DEFAULTS (plus the documented additions)', () => {
  const c = defaultEngineConfig();
  for (const [k, v] of Object.entries(HARNESS_WEIGHTS)) assert.deepEqual(c.weights[k], v, `weights.${k}`);
  for (const [k, v] of Object.entries(HARNESS_DEFAULTS)) assert.deepEqual(c.defaults[k], v, `defaults.${k}`);
  assert.deepEqual(Object.keys(c.weights).filter((k) => !(k in HARNESS_WEIGHTS)), ['facultyOverDefault']);
  assert.equal(c.weights.facultyOverDefault, 8);
  assert.equal(c.defaults.maxRunFaculty, 3);
  assert.equal(c.defaults.maxRunDivision, 3);
  assert.deepEqual(buildEngineConfig([]), c, 'no rows = the defaults');
  assert.deepEqual(buildEngineConfig(undefined), c);
});

const small = () =>
  mini({
    rooms: [{ name: 'C1', cap: 60 }, { name: 'C2', cap: 60 }, { name: 'C3', cap: 40 }, { name: 'LAB1', lab: true, cap: 62 }, { name: 'LAB2', lab: true, cap: 62 }, { name: 'LAB3', lab: true, cap: 32 }, { name: 'LABU', lab: true, cap: null }],
    faculty: ['A', 'B', 'C', 'D', 'E', 'F'],
    subjects: [{ code: 'T1', kind: 'theory', weekly: 3 }, { code: 'T2', kind: 'theory', weekly: 2 }, { code: 'T3', kind: 'theory', weekly: 6 }, { code: 'L1', kind: 'lab', weekly: 1 }, { code: 'L2', kind: 'lab', weekly: 1 }, { code: 'L3', kind: 'lab', weekly: 1 }],
    divisions: [
      { name: 'X', students: 60, batches: [['X1', 20], ['X2', 20], ['X3', 20]], home: 'C1' },
      { name: 'Y', students: 40, batches: [['Y1', 20], ['Y2', 20]], home: 'C2' },
      { name: 'Z', students: 60, home: 'C1' },
    ],
    offerings: [
      { div: 'X', code: 'T1', faculty: 'A' }, { div: 'X', code: 'T2', faculty: 'B' }, { div: 'X', code: 'L1', faculty: 'C' }, { div: 'X', code: 'L2', faculty: 'D|E' }, { div: 'X', code: 'L3', faculty: 'F' },
      { div: 'Y', code: 'T1', faculty: 'A' }, { div: 'Y', code: 'T3', faculty: 'B' }, { div: 'Y', code: 'L1', faculty: 'C' }, { div: 'Y', code: 'L2', faculty: 'D' },
      { div: 'Z', code: 'T1', faculty: 'A' }, { div: 'Z', code: 'T2', faculty: 'B' },
    ],
  });

test('parity: small worlds, several seeds -> identical day / start / room for every session', async () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const w = withoutHomeRooms(small());
    const h = await harness(w, seed);
    assert.equal(h.result.unplaced.length, 0);
    const mine = judge(w, generate({ snapshot: w, seed, config: harnessConfig() }));
    assert.deepEqual(mine.integrity.violations, []);
    assert.equal(diff(h.snap, mine.snap), 0, `seed ${seed}`);
  }
});

const rows = HAS_REAL ? loadImportRows() : null;
const rooms = HAS_REAL ? readJson('rooms_snapshot.json') : null;

test('parity: the real Sem 3 + Sem 5 data, seed 1 -> identical placements as the harness (harness-equivalent config)', { skip: SKIP_REAL }, async () => {
  const w = withoutHomeRooms(buildWorld({ ...rows, rooms }));
  const h = await harness(w, 1);
  assert.equal(h.result.unplaced.length, 0);
  const r = generate({ snapshot: w, seed: 1, config: harnessConfig() });
  const mine = judge(w, r);
  assert.deepEqual(mine.integrity.violations, []);
  assert.equal(r.unplaced.length, 0);
  assert.equal(r.stats.repair_moves, 0);
  assert.equal(diff(h.snap, mine.snap), 0, 'every session in the same slot and room as the harness');
});

test('parity: the true default config (with facultyOverDefault) still places everything clash-free; differing placements are reported', { skip: SKIP_REAL }, async () => {
  const w = withoutHomeRooms(buildWorld({ ...rows, rooms }));
  const h = await harness(w, 1);
  const r = generate({ snapshot: w, seed: 1 });
  const mine = judge(w, r);
  const n = diff(h.snap, mine.snap);
  console.log(`# parity (default config vs harness): ${n} of ${w.sessions.length} sessions differ; unplaced ${r.unplaced.length}, repair moves ${r.stats.repair_moves}`);
  assert.equal(r.unplaced.length, 0);
  assert.deepEqual(mine.integrity.violations, []);
  assert.ok(applyResult(w, r).sessions.every((s) => s.weekday !== null));
});
