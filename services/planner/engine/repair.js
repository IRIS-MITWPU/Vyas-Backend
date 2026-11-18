// Ejection-chain repair (pure, deterministic). Runs after the greedy phases for every session that is still unplaced.
//
// For an unplaced session U the pass looks for a slot where U is blocked, through a teacher or a batch resource, by
// exactly ONE movable unit (a unit = a theory session or a whole lab block; movable = placed by this run, unlocked,
// in scope, i.e. present in ctx.unitOf). It then
//   1. removes that unit from the model,
//   2. places U at the slot (re-validated through the candidate functions, relaxed pass, so every hard rule still holds:
//      lab per day, subject per day, teacher max_per_day, rules the admin set to 'hard'),
//   3. looks for another slot for the removed unit (same candidate functions, with U in place) and puts it there.
// With the hard no-idle-time rule on, a chain that would leave ANY division day with more idle time than before (taking the
// unit out of the middle of a day opens a hole there) is rolled back too.
// If any step fails, everything is rolled back exactly (placement records incl. room and shared flag). Whole units
// only: a lab block always moves as a block, so the rotation invariants (one session per batch, disjoint teachers,
// one block per batch per day) are kept by the candidate validation.
//
// Bounded: at most `maxAttemptsPerSession` (default 200) tried (slot, blocker) pairs per unplaced session and at most
// `maxMoves` (default 500) accepted moves in total.
import { allStarts, standardStarts, validPlacement, dayStats } from './time.js';
import { theoryCandidateAt, theoryCandidates, labBlockCandidateAt, labBlockCandidates, labDayOk, prepTheory, prepLab, resolveOpts, scoreOf } from './rank.js';

/**
 * @param model   OccupancyModel (already holding the greedy result)
 * @param ctx     { config, seed, unitOf: Map(sid -> unit), targets: [sid], addUnit(sids) -> unit,
 *                  maxAttemptsPerSession, maxMoves, isCancelled }
 *                unit = {unit_id, kind:'lab_block'|'theory', sids:[...], score}; addUnit(sids, kind, score) registers the unit of a repaired session
 * @returns { moves, repaired:[sid], attempts }
 */
export function repairUnplaced(model, ctx) {
  const maxAttempts = ctx.maxAttemptsPerSession ?? 200;
  const maxMoves = ctx.maxMoves ?? 500;
  const R = resolveOpts({ config: ctx.config, strict: false, seed: ctx.seed });
  let moves = 0;
  let attempts = 0;
  const repaired = [];

  for (const U of ctx.targets) {
    if (ctx.isCancelled && ctx.isCancelled()) break;
    if (model.isPlaced(U) || model.info.get(U).locked) continue;
    if (moves >= maxMoves) break;
    if (repairOne(U)) {
      repaired.push(U);
      moves += 1;
    }
  }
  return { moves, repaired, attempts };

  function slotOrder(sid) {
    const i = model.info.get(sid);
    const std = new Set(standardStarts(model.shape, i.duration));
    const starts = allStarts(model.shape, i.duration);
    const ordered = [...starts.filter((s) => std.has(s)), ...starts.filter((s) => !std.has(s))];
    const out = [];
    for (const day of model.shape.days) for (const start of ordered) out.push({ day, start });
    return out;
  }

  /** Candidate of U at (day,start) with the blocker already removed, or null. */
  function candidateFor(U, day, start) {
    const i = model.info.get(U);
    if (i.kind !== 'lab') return theoryCandidateAt(model, U, day, start, R, prepTheory(model, U, R));
    if (!labDayOk(model, [U], day, R)) return null;
    const block = { key: U, sessions: [{ id: U }] };
    return labBlockCandidateAt(model, block, day, start, R, prepLab(model, block, R));
  }

  function put(c, sids) {
    if (c.plan) for (const p of c.plan) model.place(p.sid, c.day, c.start, p.end, p.room_id, p.shared);
    else model.place(sids[0], c.day, c.start, c.end, c.room_id, c.shared);
  }

  /** Idle minutes of every (division, day) of the given divisions, now. */
  function idleMap(divIds) {
    const m = new Map();
    for (const d of new Set(divIds)) for (const day of model.shape.days) m.set(`${d}|${day}`, dayStats(model.shape, model.divisionDay(d, day)).idle);
    return m;
  }

  /** True when no division day of `before` has more idle time now than max(limit, what it had before). */
  function noNewIdle(before) {
    const limit = R.H.divisionIdleGapMinutes;
    for (const [key, was] of before) {
      const [d, day] = key.split('|');
      if (dayStats(model.shape, model.divisionDay(d, Number(day))).idle > Math.max(limit, was)) return false;
    }
    return true;
  }

  /** Best slot for a whole unit (all its sessions) with the current model, or null. */
  function bestFor(unit) {
    if (unit.kind === 'theory') return theoryCandidates(model, unit.sids[0], { config: ctx.config, strict: false, seed: ctx.seed })[0] ?? null;
    const block = { key: unit.unit_id, sessions: unit.sids.map((id) => ({ id })) };
    return labBlockCandidates(model, block, { config: ctx.config, strict: false, seed: ctx.seed })[0] ?? null;
  }

  function repairOne(U) {
    const i = model.info.get(U);
    let tried = 0;
    for (const { day, start } of slotOrder(U)) {
      if (tried >= maxAttempts) break;
      const pv = validPlacement(model.shape, i.duration, day, start);
      if (!pv.ok) continue;
      const holders = model.holders(U, day, start, pv.end);
      if (!holders.length) continue; // free of teacher/batch blockers: greedy already knew about this slot
      const units = new Set(holders.map((h) => ctx.unitOf.get(h) ?? null));
      if (units.size !== 1 || units.has(null)) continue; // not exactly one movable blocker
      const unit = [...units][0];
      if (unit.sids.some((s) => model.info.get(s).locked || !model.isPlaced(s))) continue;
      tried += 1;
      attempts += 1;
      const saved = unit.sids.map((s) => model.recordOf(s));
      const idleBefore = R.H.divisionIdleGapMinutes === null ? null : idleMap([i.division_id, model.info.get(unit.sids[0]).division_id]);
      for (const s of unit.sids) model.unplace(s);
      const rollback = () => {
        model.unplace(U);
        for (const s of unit.sids) model.unplace(s);
        for (const r of saved) model.restore(r);
      };
      const cu = candidateFor(U, day, start);
      if (!cu) {
        rollback();
        continue;
      }
      put(cu, [U]);
      const cb = bestFor(unit);
      if (!cb) {
        rollback();
        continue;
      }
      put(cb, unit.sids);
      if (idleBefore && !noNewIdle(idleBefore)) {
        rollback();
        continue;
      }
      unit.score = scoreOf(cb.parts); // the moved unit's penalty (best-of-N scoring)
      ctx.addUnit([U], i.kind === 'lab' ? 'lab_block' : 'theory', scoreOf(cu.parts));
      return true;
    }
    return false;
  }
}
