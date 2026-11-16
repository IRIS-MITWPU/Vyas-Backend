import test from 'node:test';
import assert from 'node:assert/strict';
import { autoplace, FatalApiError } from './lib/engine.mjs';
import { FakeServer } from './lib/fakeServer.mjs';
import { checkIntegrity } from './lib/integrity.mjs';
import { buildWorld } from './lib/world.mjs';
import { makeAffinityLookup } from './lib/labrooms.mjs';
import { loadImportRows, readJson, HAS_REAL, SKIP_REAL } from './lib/fixtures.mjs';
import { mini, sessionOf, roomId } from './lib/testkit.mjs';

const run = (world, { server = {}, options = {}, send } = {}) => {
  const fake = new FakeServer(world, server);
  return autoplace({
    snapshot: world,
    send: send ?? ((ops, cid) => fake.send({ client_id: cid, ops })),
    refetch: async () => fake.snapshot(),
    options,
  }).then((result) => ({ result, fake }));
};

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

test('engine: a small world is placed completely and clash-free through the ops API', async () => {
  const w = smallWorld();
  const { result, fake } = await run(w, { options: { seed: 3 } });
  assert.equal(result.unplaced.length, 0);
  assert.equal(result.stats.model_mismatches, 0, 'the model predicted every server answer');
  assert.equal(checkIntegrity(fake.snapshot()).ok, true);
  assert.equal(fake.snapshot().sessions.every((s) => s.weekday !== null), true);
  // lab blocks: both batches of a division in parallel, a batch never has two lab subjects the same day
  const labs = fake.snapshot().sessions.filter((s) => s.kind === 'lab');
  const byBatchDay = new Map();
  for (const s of labs) byBatchDay.set(`${s.batch_id}|${s.weekday}`, (byBatchDay.get(`${s.batch_id}|${s.weekday}`) || 0) + 1);
  assert.ok([...byBatchDay.values()].every((n) => n === 1));
  // teachers on a two-teacher lab session are both on the session
  const two = fake.snapshot().sessions.find((s) => s.subject_code === 'L2' && s.faculty.length === 2);
  assert.ok(two && two.weekday !== null);
});

test('engine: ops requests carry several ops for a lab block and one for theory, with a stable client_id', async () => {
  const w = smallWorld();
  const seen = [];
  const fake = new FakeServer(w);
  const { result } = await run(w, {
    options: { clientId: 'real-test-1' },
    send: (ops, cid) => {
      seen.push({ n: ops.length, cid, kinds: ops.map((o) => o.op) });
      return fake.send({ client_id: cid, ops });
    },
  });
  assert.equal(result.unplaced.length, 0);
  assert.ok(seen.every((r) => r.cid === 'real-test-1' && r.kinds.every((k) => k === 'place')));
  assert.ok(seen.some((r) => r.n === 2), 'a lab block of two batches in one request');
  assert.ok(seen.some((r) => r.n === 1));
  assert.ok(seen.every((r) => r.n <= 50));
});

test('engine: lab room ids are not sent in auto mode, theory never gets a room_id', async () => {
  const w = smallWorld();
  const bodies = [];
  const fake = new FakeServer(w);
  await run(w, { send: (ops, cid) => { bodies.push(...ops); return fake.send({ client_id: cid, ops }); } });
  assert.ok(bodies.every((o) => o.room_id === undefined));
});

test('engine: deterministic for a given seed', async () => {
  const snap = async (seed) => (await run(smallWorld(), { options: { seed } })).fake.snapshot().sessions.map((s) => `${s.id}:${s.weekday}:${s.start_min}:${s.room_id}`).join(',');
  assert.equal(await snap(5), await snap(5));
});

test('engine: the result does not depend on ids or snapshot order (stable across --reset re-seeds)', async () => {
  const natural = (snap) => {
    const bn = new Map(snap.divisions.flatMap((d) => d.batches.map((b) => [b.id, `${d.semester}|${d.name}`])));
    return snap.sessions.map((s) => `${bn.get(s.batch_id)}|${s.subject_code}|${s.batch_name}|${s.seq}:${s.weekday}:${s.start_min}`).sort().join('|');
  };
  const a = (await run(smallWorld(), { options: { seed: 4 } })).fake.snapshot();
  const w = smallWorld();
  const swap = (id) => `zz-${id}`;
  const renamed = JSON.parse(JSON.stringify(w), (k, v) => (typeof v === 'string' && /^(ses|off|div|fac|sub|room|tr)-/.test(v) ? swap(v) : v));
  renamed.sessions.reverse();
  renamed.faculty.reverse();
  const b = (await run(renamed, { options: { seed: 4 } })).fake.snapshot();
  assert.equal(natural(a), natural(b));
});

test('engine: server refusals are recorded, the next candidate is tried, nothing is lost', async () => {
  const w = smallWorld();
  const { result, fake } = await run(w, { server: { failEvery: 3 } });
  assert.equal(result.unplaced.length, 0);
  assert.ok(result.stats.rejected.CLASH > 0);
  assert.equal(result.rejections.length, result.stats.rejected.CLASH);
  assert.ok(result.rejections.every((r) => r.code === 'CLASH' && r.status === 409 && r.message));
  assert.ok(result.stats.model_mismatches > 0);
  assert.equal(checkIntegrity(fake.snapshot()).ok, true);
});

test('engine: placement grid errors (422) are recorded and skipped', async () => {
  const w = smallWorld();
  const fake = new FakeServer(w);
  let first = true;
  const { result } = await run(w, {
    send: (ops, cid) => {
      if (first) {
        first = false;
        return Promise.resolve({ status: 422, body: { success: false, code: 'PLACEMENT_INVALID', error: 'nope', details: { op_index: 0, reason: 'OFF_GRID' } } });
      }
      return fake.send({ client_id: cid, ops });
    },
  });
  assert.equal(result.stats.rejected.PLACEMENT_INVALID, 1);
  assert.equal(result.unplaced.length, 0);
});

test('engine: unexpected statuses are fatal (VALIDATION_ERROR, NOT_DRAFT, 5xx)', async () => {
  const w = smallWorld();
  for (const [status, code] of [[400, 'VALIDATION_ERROR'], [409, 'NOT_DRAFT'], [500, 'INTERNAL'], [403, 'REAUTH_REQUIRED']]) {
    await assert.rejects(
      () => run(w, { send: () => Promise.resolve({ status, body: { success: false, code, error: 'x' } }) }),
      (e) => e instanceof FatalApiError && e.message.includes('unexpected response') && e.res.status === status,
    );
  }
});

test('engine: an over-subscribed teacher leaves sessions unplaced with a clear reason', async () => {
  // one working day, two cells (08:30, 09:30), three divisions with the same teacher -> one session cannot be placed
  const w = mini({
    term: { working_days: [0], day_end_min: 630 },
    rooms: [{ name: 'C1', cap: 60 }, { name: 'C2', cap: 60 }, { name: 'C3', cap: 60 }],
    faculty: ['A'],
    subjects: [{ code: 'T1', kind: 'theory', weekly: 1 }],
    divisions: [{ name: 'X', students: 60, home: 'C1' }, { name: 'Y', students: 60, home: 'C2' }, { name: 'Z', students: 60, home: 'C3' }],
    offerings: ['X', 'Y', 'Z'].map((d) => ({ div: d, code: 'T1', faculty: 'A' })),
  });
  const { result, fake } = await run(w);
  assert.equal(result.stats.ok_requests, 2);
  assert.equal(result.unplaced.length, 1);
  const u = result.unplaced[0];
  assert.equal(u.code, 'FACULTY_BUSY');
  assert.deepEqual(u.teachers, ['A']);
  assert.match(u.text, /teacher\(s\) A busy in 5, division\/batch busy in 0, no room in 0/);
  assert.deepEqual(u.slots, { total: 5, free: 0, faculty: 5, batch: 0, room: 0 });
  assert.equal(checkIntegrity(fake.snapshot()).ok, true);
});

test('engine: the hard rules hold in every pass; a session that only fits by breaking one stays unplaced with POLICY_RULES', async () => {
  // one working day with four cells; a subject taught 3 times a week may appear at most twice that day (back to back)
  const w = mini({
    term: { working_days: [0], day_end_min: 765 },
    rooms: [{ name: 'C1', cap: 60 }],
    faculty: ['A'],
    subjects: [{ code: 'T1', kind: 'theory', weekly: 3 }],
    divisions: [{ name: 'X', students: 60, home: 'C1' }],
    offerings: [{ div: 'X', code: 'T1', faculty: 'A' }],
  });
  const { result, fake } = await run(w);
  assert.equal(result.unplaced.length, 1);
  assert.equal(result.unplaced[0].code, 'POLICY_RULES');
  const placed = fake.snapshot().sessions.filter((s) => s.weekday !== null).sort((a, b) => a.start_min - b.start_min);
  assert.equal(placed.length, 2);
  assert.equal(placed[0].end_min, placed[1].start_min, 'the allowed repeat is back to back');
});

test('engine: a batch never gets a second lab block on one day, even when that leaves a lab unplaced', async () => {
  // one working day, 3 lab subjects for one batch: only one lab can be placed that day
  const w = mini({
    term: { working_days: [0] },
    rooms: [{ name: 'LAB1', lab: true, cap: 62 }],
    faculty: ['A', 'B', 'C'],
    subjects: ['L1', 'L2', 'L3'].map((code) => ({ code, kind: 'lab', weekly: 1 })),
    divisions: [{ name: 'X', students: 40, batches: [['X1', 20], ['X2', 20]] }],
    offerings: ['L1', 'L2', 'L3'].map((code, i) => ({ div: 'X', code, faculty: 'ABC'[i] })),
  });
  const { result, fake } = await run(w);
  const placedLabs = fake.snapshot().sessions.filter((s) => s.weekday !== null);
  const perBatch = new Map();
  for (const s of placedLabs) perBatch.set(s.batch_id, (perBatch.get(s.batch_id) || 0) + 1);
  assert.ok([...perBatch.values()].every((n) => n === 1), 'at most one lab per batch that day');
  assert.equal(result.unplaced.length, 4);
  assert.ok(result.unplaced.every((u) => u.code === 'POLICY_RULES'));
});

test('engine: a fatal answer carries the partial stats so the caller can still write a run log', async () => {
  const w = smallWorld();
  const fake = new FakeServer(w);
  let n = 0;
  await assert.rejects(
    () => run(w, { send: (ops, cid) => (++n === 3 ? Promise.resolve({ status: 500, body: { success: false, code: 'INTERNAL', error: 'db down' } }) : fake.send({ client_id: cid, ops })) }),
    (e) => e instanceof FatalApiError && e.partial.stats.ok_requests === 2 && Array.isArray(e.partial.rejections),
  );
});

test('engine: locked sessions are left alone, placed sessions are kept (resume)', async () => {
  const w = smallWorld();
  sessionOf(w, 'X', 'T2', 'ALL', 1).locked = true;
  const pre = sessionOf(w, 'X', 'T1', 'ALL', 1);
  Object.assign(pre, { weekday: 2, start_min: 645, end_min: 705, room_id: roomId(w, 'C1') });
  const { result, fake } = await run(w);
  assert.equal(result.unplaced.length, 1);
  assert.equal(result.unplaced[0].code, 'LOCKED');
  const after = fake.snapshot().sessions.find((s) => s.id === pre.id);
  assert.deepEqual([after.weekday, after.start_min], [2, 645]);
});

test('engine: a pre-8.7 server (exclusive labs) is detected and the model adapts', async () => {
  const w = mini({
    rooms: [{ name: 'C1', cap: 60 }, { name: 'LAB1', lab: true, cap: 62 }, { name: 'LAB2', lab: true, cap: 62 }, { name: 'LAB3', lab: true, cap: 62 }],
    faculty: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'],
    subjects: ['L1', 'L2', 'L3', 'L4'].map((code) => ({ code, kind: 'lab', weekly: 1 })),
    divisions: ['P', 'Q', 'R', 'S'].map((n) => ({ name: n, students: 40, batches: [[`${n}1`, 20], [`${n}2`, 20]] })),
    offerings: ['P', 'Q', 'R', 'S'].flatMap((n, i) => [{ div: n, code: 'L1', faculty: 'ABCDEFGH'[i * 2] }, { div: n, code: 'L2', faculty: 'ABCDEFGH'[i * 2 + 1] }]),
  });
  const { result, fake } = await run(w, { server: { sharedLabs: false } });
  assert.equal(result.stats.shared_labs_disabled, true);
  assert.equal(result.unplaced.length, 0);
  assert.equal(checkIntegrity(fake.snapshot(), { sharedLabs: false }).ok, true);
});

// ---- the real data, against the in-process fake server -------------------------------------------

const rows = HAS_REAL ? loadImportRows() : null;
const rooms = HAS_REAL ? readJson('rooms_snapshot.json') : null;

test('engine: the real Sem 3 + Sem 5 data places completely with zero model mismatches (auto lab rooms)', { skip: SKIP_REAL }, async () => {
  const w = buildWorld({ ...rows, rooms });
  const { result, fake } = await run(w, { options: { seed: 1 } });
  const snap = fake.snapshot();
  assert.equal(snap.sessions.length, w.sessions.length);
  assert.equal(result.unplaced.length, 0, JSON.stringify(result.unplaced.slice(0, 3)));
  assert.equal(result.stats.model_mismatches, 0);
  assert.ok(result.stats.requests < 1200, `requests: ${result.stats.requests}`);
  const integ = checkIntegrity(snap);
  assert.deepEqual(integ.violations, []);
  // second run on the finished snapshot places nothing and sends nothing
  const again = await run(snap, { options: { seed: 1 } });
  assert.equal(again.result.stats.requests, 0);
});

test('engine: the real data with affinity lab rooms uses the mapped rooms where it can', { skip: SKIP_REAL }, async () => {
  const w = buildWorld({ ...rows, rooms });
  const lk = makeAffinityLookup(readJson('lab_rooms.json'), w.rooms);
  const { result, fake } = await run(w, { options: { seed: 2, labRooms: 'affinity', roomsFor: lk.roomsFor } });
  assert.equal(result.unplaced.length, 0);
  assert.deepEqual(checkIntegrity(fake.snapshot()).violations, []);
  let mapped = 0;
  let inAffinityRoom = 0;
  const info = result.model.info;
  for (const s of fake.snapshot().sessions) {
    if (s.kind !== 'lab') continue;
    const want = lk.roomsFor(info.get(s.id));
    if (!want) continue;
    mapped += 1;
    if (want.includes(s.room_id)) inAffinityRoom += 1;
  }
  assert.ok(mapped > 300);
  assert.ok(inAffinityRoom / mapped > 0.9, `${inAffinityRoom}/${mapped} lab sessions in their lab_rooms.json room`);
  assert.ok(result.stats.affinity_unmapped_sessions > 0, 'rooms that are not in the Vyas table (VY126, KS...) fall back to auto');
});
