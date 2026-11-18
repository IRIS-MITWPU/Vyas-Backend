// Real-size run: the Sem 3 + Sem 5 inputs of tests/planner/fixtures/real (949 sessions), default rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generate, buildModel, candidatesFor, suggestionsFor, buildEngineConfig } from '../../../services/planner/engine/index.js';
import { buildWorld } from '../real/lib/world.mjs';
import { loadImportRows, readJson, HAS_REAL, SKIP_REAL } from '../real/lib/fixtures.mjs';

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

// the real inputs give 38 divisions only 23 distinct home rooms (some rooms carry 3 divisions = 42 theory hours a week); with the
// restricted home rooms of contract 10.3 that is a data problem, not an engine one, so the performance world has none
const noHome = (w) => ({ ...w, divisions: w.divisions.map((d) => ({ ...d, home_room_id: null, home_room2_id: null, home_room_ids: [] })) });
const world = HAS_REAL ? noHome(buildWorld({ ...loadImportRows(), rooms: readJson('rooms_snapshot.json') })) : null;
const ms = (t0) => Math.round(performance.now() - t0);
let shared = null; // the single-seed result, reused by the later tests

test('perf: the full real world (949 sessions) generates in well under 60 s with one seed, complete and clash-free', { skip: SKIP_REAL }, () => {
  assert.equal(world.sessions.length, 949);
  const t0 = performance.now();
  const r = generate({ snapshot: world, seed: 1, seeds: 1 });
  const took = ms(t0);
  console.log(`# generate 949 sessions, 1 seed: ${took} ms (stats.duration_ms ${r.stats.duration_ms}); placed ${r.stats.placed}/${r.stats.requested}, repair moves ${r.stats.repair_moves}, score ${r.stats.score}`);
  assert.ok(took < 60000, `took ${took} ms`);
  assert.equal(r.unplaced.length, 0, JSON.stringify(r.unplaced.slice(0, 3)));
  assert.equal(r.stats.placed, 949);
  const { snap, integrity } = judge(world, r);
  assert.deepEqual(integrity.violations, [], 'zero integrity violations (independent judge)');
  assert.equal(integrity.checked.placed, 949);
  assert.ok(r.units.flatMap((u) => u.placements).every((p) => p.room_id));
  shared = { r, snap };
});

test('perf: three seeds (the default of the API) are deterministic and not worse than any single seed', { skip: SKIP_REAL }, () => {
  const t0 = performance.now();
  const r = generate({ snapshot: world, seed: 1, seeds: 3 });
  console.log(`# generate 949 sessions, 3 seeds: ${ms(t0)} ms; best seed ${r.stats.best_seed}, score ${r.stats.score}`);
  assert.equal(r.stats.seeds_tried, 3);
  assert.equal(r.unplaced.length, 0);
  assert.ok(r.stats.score <= shared.r.stats.score);
});

test('perf: candidatesFor / suggestionsFor of one session on the full timetable take well under 100 ms', { skip: SKIP_REAL }, () => {
  const model = buildModel(shared.snap);
  const config = buildEngineConfig([]);
  const sessions = shared.snap.sessions;
  const pick = (n) => sessions.filter((_, i) => i % Math.floor(sessions.length / n) === 0).slice(0, n);
  const times = [];
  for (const s of pick(60)) {
    const t0 = performance.now();
    const c = candidatesFor(model, s.id, config);
    times.push({ ms: performance.now() - t0, kind: s.kind, n: c.length });
  }
  const max = Math.max(...times.map((t) => t.ms));
  const avg = times.reduce((a, t) => a + t.ms, 0) / times.length;
  const labMax = Math.max(...times.filter((t) => t.kind === 'lab').map((t) => t.ms));
  console.log(`# candidatesFor on the full timetable: avg ${avg.toFixed(1)} ms, max ${max.toFixed(1)} ms (labs max ${labMax.toFixed(1)} ms) over ${times.length} sessions`);
  assert.ok(max < 100, `max ${max} ms`);
  const t1 = performance.now();
  const sug = suggestionsFor(model, pick(5)[2].id, config, { limit: 5 });
  console.log(`# suggestionsFor: ${(performance.now() - t1).toFixed(1)} ms, ${sug.suggestions.length} suggestions`);
  assert.ok(performance.now() - t1 < 100);
});

test('perf: regenerate_unlocked on a few divisions of the full timetable keeps everything else untouched', { skip: SKIP_REAL }, () => {
  const full = shared.snap;
  const scope = full.divisions.slice(0, 4).map((d) => d.id);
  const scoped = new Set(full.divisions.slice(0, 4).flatMap((d) => d.batches.map((b) => b.id)));
  const input = clone(full);
  // lock a few sessions inside the scope
  const lockedIds = input.sessions.filter((s) => scoped.has(s.batch_id)).slice(0, 6).map((s) => s.id);
  for (const s of input.sessions) if (lockedIds.includes(s.id)) s.locked = true;
  const t0 = performance.now();
  const r = generate({ snapshot: input, mode: 'regenerate_unlocked', divisionIds: scope, seed: 2 });
  console.log(`# regenerate_unlocked, 4 divisions: ${ms(t0)} ms, ${r.stats.requested} sessions re-planned, unplaced ${r.stats.unplaced}`);
  const after = applyResult(input, r);
  const { integrity } = judge(input, r);
  assert.deepEqual(integrity.violations, []);
  assert.equal(r.unplaced.length, 0);
  for (const s of input.sessions) {
    const a = after.sessions.find((x) => x.id === s.id);
    if (!scoped.has(s.batch_id) || lockedIds.includes(s.id)) assert.deepEqual([a.weekday, a.start_min, a.room_id], [s.weekday, s.start_min, s.room_id], `${s.subject_code} must not move`);
  }
});
