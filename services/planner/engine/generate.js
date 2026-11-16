// The generator entry point (contract 9.6 "Engine entry"). Pure and deterministic for a given seed: no Math.random,
// no I/O, no Date.now in the plan (duration_ms in the stats is the only wall-clock value).
//
// Port of the phase loop of tests/planner/real/lib/engine.mjs WITHOUT the HTTP dialogue: the decisions come from the
// in-memory model, every placement carries an explicit room chosen by the model. Phases per seed:
//   labs (strict blocks, then single lab sessions relaxed) -> theory (strict, then relaxed) -> final lab sweep ->
//   repair (ejection chains, repair.js) -> one more relaxed sweep.
// Modes: fill_unplaced (placed sessions are fixed obstacles) and regenerate_unlocked (unlocked placed sessions in
// scope start unplaced; locked ones stay fixed). Everything outside `divisionIds` is a fixed obstacle in both modes.
import { OccupancyModel, buildSessionInfo } from './model.js';
import { buildEngineConfig } from './config.js';
import { labBlockCandidates, theoryCandidates, divisionOrder, facultyLoads, scoreOf } from './rank.js';
import { buildLabBlocks } from './rotation.js';
import { repairUnplaced } from './repair.js';
import { diagnose } from './diagnose.js';
import { cmpText } from './time.js';
import { checkPlacement } from '../domain/index.js';

export const MODES = Object.freeze(['fill_unplaced', 'regenerate_unlocked']);

/** Thrown when isCancelled() turned true: the caller must not commit anything. */
export class GenerationCancelled extends Error {
  constructor() {
    super('generation cancelled');
    this.name = 'GenerationCancelled';
    this.code = 'CANCELLED';
  }
}

/** Natural key of a session: stable across re-seeds / re-imports (never a database id). */
export const sessionKey = (i) => `${i.division_key}|${i.subject_code}|${i.batch_name ?? 'ALL'}|#${i.seq}`;

const infoToBlockSession = (i) => ({
  id: i.id, batch_id: i.batch_id, batch_name: i.batch_name, offering_id: i.offering_id, subject_code: i.subject_code, seq: i.seq, faculty_ids: i.faculty_ids,
});

/**
 * @param {object} args
 * @param {object} args.snapshot   GET /versions/:id/snapshot body (never mutated)
 * @param {object[]} [args.rules]  merged rule rows (9.7); missing keys use the defaults
 * @param {'fill_unplaced'|'regenerate_unlocked'} [args.mode]
 * @param {string[]|null} [args.divisionIds]  restrict the scope (null/empty = every division)
 * @param {number} [args.seeds]    how many seeds to try (seed, seed+1, ...); the best result is kept
 * @param {number} [args.seed]     first seed
 * @param {(stage:string, pct:number)=>void} [args.onProgress]  stages loading(5) labs(10-45) theory(45-80) repair(80-85)
 * @param {()=>boolean} [args.isCancelled]  polled between units; true -> GenerationCancelled is thrown
 * @param {object} [args.repair]   {enabled=true, maxAttemptsPerSession=200, maxMoves=500}
 * @param {object} [args.config]   prebuilt buildEngineConfig() result; wins over `rules` (tests / experiments)
 * @param {Function} [args.placementCheck]  the final per-placement validation (default: domain checkPlacement); a seam for tests
 * @returns {{units, unplaced, unplace_ids, unplace, stats}}
 *   units: [{unit_id:'u1'.., key:natural key, kind, placements:[{session_id,weekday,start_min,room_id,expect:null}]}]
 *     (short ids: the commit never depends on long keys; `key` is for reporting). In regenerate_unlocked a session that was
 *     placed in the snapshot is unplaced first (see `unplace`), so its re-placement still says expect:null.
 *   unplace_ids: ids of the sessions the run unplaces first; unplace: the same as [{session_id, expect:{weekday,start_min,room_id}}]
 *     (expect = the snapshot placement; applyPlacements skips an unplace whose session moved in the meantime).
 */
export function generate({ snapshot, rules, mode = 'fill_unplaced', divisionIds = null, seeds = 1, seed = 1, onProgress, isCancelled, repair = {}, config: configOverride, placementCheck = checkPlacement } = {}) {
  if (!MODES.includes(mode)) throw new Error(`unknown generation mode "${mode}"`);
  const t0 = Date.now();
  const progress = (stage, pct) => {
    if (onProgress) onProgress(stage, Math.round(pct * 10) / 10);
  };
  const cancelled = () => !!(isCancelled && isCancelled());
  const check = () => {
    if (cancelled()) throw new GenerationCancelled();
  };
  progress('loading', 5);
  check();

  const config = configOverride || buildEngineConfig(rules); // `config`: a prebuilt engine config (tests / experiments)
  const nSeeds = Math.max(1, Math.floor(Number(seeds)) || 1);
  const firstSeed = Number.isInteger(seed) ? seed : 1;
  const scope = Array.isArray(divisionIds) && divisionIds.length ? new Set(divisionIds) : null;

  // which sessions does this run own?
  const info0 = buildSessionInfo(snapshot).info;
  const inScope = (sid) => !scope || scope.has(info0.get(sid)?.division_id);
  const skipPlaced = new Set(); // regenerate_unlocked: unlocked placed sessions in scope start unplaced
  if (mode === 'regenerate_unlocked') {
    for (const s of snapshot.sessions || []) {
      const placed = s.weekday !== null && s.weekday !== undefined && s.start_min !== null && s.start_min !== undefined;
      if (placed && !s.locked && inScope(s.id)) skipPlaced.add(s.id);
    }
  }

  let best = null;
  for (let k = 0; k < nSeeds; k++) {
    const res = runSeed(firstSeed + k, k, nSeeds);
    if (!best || betterResult(res, best)) best = res;
  }

  // ---- result of the best seed ----------------------------------------------------------------
  const { model } = best;
  const poolRoomIds = new Set((snapshot.rooms || []).map((r) => r.room_id ?? r.id));
  const subjectOf = (i) => ({ duration_min: i.duration });
  const units = [];
  const dropped = new Map(); // sid -> reason text: the unit's placement failed the final domain check (never throws the whole run)
  for (const u of best.units) {
    if (!u.sids.every((s) => model.isPlaced(s))) continue;
    const placements = [];
    let bad = null;
    for (const sid of u.sids) {
      const p = model.placed.get(sid);
      const chk = placementCheck({ term: snapshot.term, subject: subjectOf(model.info.get(sid)), weekday: p.day, start_min: p.start, room_id: p.room_id, poolRoomIds });
      if (!chk.ok || chk.end_min !== p.end) {
        bad = chk.message || `the placement is not valid (${chk.reason ?? 'END_MISMATCH'})`;
        break;
      }
      placements.push({ session_id: sid, weekday: p.day, start_min: p.start, room_id: p.room_id, expect: null });
    }
    if (bad) {
      for (const sid of u.sids) dropped.set(sid, bad);
      continue;
    }
    units.push({ unit_id: `u${units.length + 1}`, key: u.unit_id, kind: u.kind, placements });
  }
  const isPlacedOut = (sid) => model.isPlaced(sid) && !dropped.has(sid);
  const unplaced = [];
  for (const sid of best.requested) {
    if (isPlacedOut(sid)) continue;
    const i = model.info.get(sid);
    if (dropped.has(sid)) {
      unplaced.push({ session_id: sid, key: sessionKey(i), division_id: i.division_id, subject_code: i.subject_code, batch_name: i.batch_name ?? null, kind: i.kind, code: 'SERVER_REFUSED', text: dropped.get(sid) });
      continue;
    }
    const d = diagnose(model, sid, null, config);
    unplaced.push({ session_id: sid, key: sessionKey(i), division_id: i.division_id, subject_code: i.subject_code, batch_name: i.batch_name ?? null, kind: i.kind, code: d.code, text: d.text });
  }
  unplaced.sort((a, b) => cmpText(a.key, b.key));
  const byKind = { lab: { placed: 0, total: 0 }, theory: { placed: 0, total: 0 } };
  for (const sid of best.requested) {
    const i = model.info.get(sid);
    const k = i.kind === 'lab' ? 'lab' : 'theory';
    byKind[k].total += 1;
    if (isPlacedOut(sid)) byKind[k].placed += 1;
  }
  const placedCount = byKind.lab.placed + byKind.theory.placed;
  const stats = {
    requested: best.requested.length,
    placed: placedCount,
    unplaced: unplaced.length,
    seeds_tried: nSeeds,
    best_seed: best.seed,
    score: Math.round(best.score * 100) / 100,
    repair_moves: best.repairMoves,
    duration_ms: Date.now() - t0,
    by_kind: byKind,
  };
  const unplace_ids = [...skipPlaced].sort();
  const snapById = new Map((snapshot.sessions || []).map((x) => [x.id, x]));
  const unplace = unplace_ids.map((id) => {
    const x = snapById.get(id);
    return { session_id: id, expect: { weekday: x.weekday, start_min: x.start_min, room_id: x.room_id ?? null } };
  });
  return { units, unplaced, unplace_ids, unplace, stats };

  // ------------------------------------------------------------------------------------------------
  function runSeed(seedValue, seedIdx, total) {
    // local pct (10..85) -> overall pct, so several seeds keep the progress monotonic
    const report = (stage, local) => progress(stage, 10 + ((seedIdx * 75 + (local - 10)) / total));
    const model = new OccupancyModel(snapshot, { skipPlaced });
    const order = divisionOrder(model);
    const loads = facultyLoads(model);
    const sessionsOf = new Map(order.map((d) => [d.id, []]));
    for (const i of model.info.values()) if (inScope(i.id)) sessionsOf.get(i.division_id)?.push(i);
    const requested = [...model.info.values()].filter((i) => inScope(i.id) && !model.isPlaced(i.id)).map((i) => i.id);

    const units = [];
    const unitOf = new Map();
    const addUnit = (sids, kind, score) => {
      const unit = { unit_id: sids.map((s) => sessionKey(model.info.get(s))).sort().join('+'), kind, sids: [...sids], score };
      units.push(unit);
      for (const s of sids) unitOf.set(s, unit);
      return unit;
    };
    const unplacedOf = (sids) => sids.filter((s) => !model.isPlaced(s) && !model.info.get(s).locked);
    const opts = (strict) => ({ strict, seed: seedValue, config });

    function placeLabBlock(sids, strict) {
      const sessions = sids.map((s) => infoToBlockSession(model.info.get(s)));
      const block = { key: sids.map((s) => sessionKey(model.info.get(s))).join('+'), sessions }; // natural key: stable across re-seeds
      const c = labBlockCandidates(model, block, opts(strict))[0];
      if (!c) return false;
      for (const p of c.plan) model.place(p.sid, c.day, c.start, p.end, p.room_id, p.shared);
      addUnit(sids, 'lab_block', scoreOf(c.parts));
      return true;
    }

    function placeTheory(sid, strict) {
      const c = theoryCandidates(model, sid, opts(strict))[0];
      if (!c) return false;
      model.place(sid, c.day, c.start, c.end, c.room_id, c.shared);
      addUnit([sid], 'theory', scoreOf(c.parts));
      return true;
    }

    const heaviest = (i) => (i.faculty_ids.length ? Math.max(...i.faculty_ids.map((f) => loads.get(f) || 0)) : 0);
    const theoryOrder = (list) => [...list].sort((a, b) => heaviest(b) - heaviest(a) || (b.weekly ?? 0) - (a.weekly ?? 0) || cmpText(a.subject_code, b.subject_code) || a.seq - b.seq);
    const stageOf = (stage, lo, hi, n, d) => report(stage, lo + ((hi - lo) * n) / Math.max(1, d));
    const nDiv = order.length;

    // phase 1: lab blocks (strict) ------------------------------------------------------------------
    order.forEach((d, n) => {
      stageOf('labs', 10, 40, n, nDiv);
      const labs = sessionsOf.get(d.id).filter((i) => i.kind === 'lab' && !model.isPlaced(i.id) && !i.locked);
      if (!labs.length) return;
      for (const b of buildLabBlocks(labs.map(infoToBlockSession))) {
        check();
        const sids = unplacedOf(b.session_ids);
        if (sids.length) placeLabBlock(sids, true);
      }
    });
    // phase 2: lab leftovers, one session at a time, relaxed ----------------------------------------
    order.forEach((d, n) => {
      stageOf('labs', 40, 45, n, nDiv);
      for (const i of sessionsOf.get(d.id).filter((x) => x.kind === 'lab' && !model.isPlaced(x.id) && !x.locked)) {
        check();
        placeLabBlock([i.id], false);
      }
    });
    // phase 3 + 4: theory, strict then relaxed ---------------------------------------------------------
    order.forEach((d, n) => {
      stageOf('theory', 45, 65, n, nDiv);
      for (const i of theoryOrder(sessionsOf.get(d.id).filter((x) => x.kind !== 'lab' && !model.isPlaced(x.id) && !x.locked))) {
        check();
        placeTheory(i.id, true);
      }
    });
    order.forEach((d, n) => {
      stageOf('theory', 65, 78, n, nDiv);
      for (const i of theoryOrder(sessionsOf.get(d.id).filter((x) => x.kind !== 'lab' && !model.isPlaced(x.id) && !x.locked))) {
        check();
        placeTheory(i.id, false);
      }
    });
    // one last relaxed sweep for labs
    order.forEach((d) => {
      for (const i of sessionsOf.get(d.id).filter((x) => x.kind === 'lab' && !model.isPlaced(x.id) && !x.locked)) {
        check();
        placeLabBlock([i.id], false);
      }
    });
    report('theory', 80);

    // repair ------------------------------------------------------------------------------------------
    let repairMoves = 0;
    const stillUnplaced = () => requested.filter((s) => !model.isPlaced(s) && !model.info.get(s).locked).sort((a, b) => cmpText(sessionKey(model.info.get(a)), sessionKey(model.info.get(b))));
    report('repair', 80);
    if (repair.enabled !== false && stillUnplaced().length) {
      const r = repairUnplaced(model, {
        config,
        seed: seedValue,
        unitOf,
        targets: stillUnplaced(),
        addUnit,
        maxAttemptsPerSession: repair.maxAttemptsPerSession,
        maxMoves: repair.maxMoves,
        isCancelled: cancelled,
      });
      check();
      repairMoves = r.moves;
      // freed capacity may let a leftover in: one more relaxed sweep
      for (const sid of stillUnplaced()) {
        const i = model.info.get(sid);
        if (i.kind === 'lab') placeLabBlock([sid], false);
        else placeTheory(sid, false);
      }
    }
    report('repair', 85);

    const live = units.filter((u) => u.sids.every((s) => model.isPlaced(s)));
    const score = live.reduce((a, u) => a + u.score, 0);
    return { seed: seedValue, model, units: live, requested, score, repairMoves, unplacedCount: requested.filter((s) => !model.isPlaced(s)).length };
  }
}

/** Fewer unplaced, then lower penalty score, then lower seed (seeds are tried in ascending order, so ties keep the first). */
function betterResult(a, b) {
  if (a.unplacedCount !== b.unplacedCount) return a.unplacedCount < b.unplacedCount;
  if (a.score !== b.score) return a.score < b.score;
  return a.seed < b.seed;
}
