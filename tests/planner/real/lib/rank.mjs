// Candidate generation and ranking (pure). Candidates are only generated when the in-memory model says the
// placement is feasible (faculty, batch resources, room); the penalty score then orders them. Lower = better.
//
// Every weight below is documented in PLACEMENT_STRATEGY.md.
import { dayStats, standardStarts, allStarts, hash01, cmpText } from './time.mjs';

export const DEFAULTS = {
  maxRunHours: 3, // consecutive teaching hours (division / teacher) before the run penalty applies
  maxDayHours: 6, // teaching hours per day for a division (strict pass)
  coreStart: 645, // 10:45
  coreEnd: 930, // 15:30
  lateStart: 945, // 15:45
};

export const WEIGHTS = {
  earlyTheory: 3, // theory starting before the core window (08:30-10:30)
  lateTheory: 12, // theory starting at/after 15:45
  veryLateTheory: 4, // extra when starting at/after 16:45
  dayLoad: 2.0, // per hour already taught to the division that day (prefer the least loaded day)
  sameSubjectSameDay: 6, // (the hard rule makes this unreachable except for the allowed back-to-back repeat)
  sameSubjectNextDay: 1.5, // per session of the same subject on an adjacent day
  runDivision: 15, // per hour a division's run exceeds maxRunHours (delta caused by this placement)
  runFaculty: 10, // same for the most affected teacher
  idleHour: 3, // per hour of new idle gap in the division's day
  facultyLoad: 1.0, // per hour already taught by the busiest involved teacher that day
  notHomeRoom: 0.5, // theory predicted outside the division's home room
  nonStandardStart: 5, // relaxed pass: start not on the standard cell grid
  dayOverload: 20, // per hour over maxDayHours (relaxed pass)
  labStart: { 645: 0, 810: 1, 510: 2, 945: 8 }, // 10:45, 13:30, 08:30, 15:45
  labStartOther: 6,
  labAdjacentDay: 1.5, // another lab block of the division on an adjacent day
  labSameDay: 8, // another batch of the division already has a lab block that day
  jitter: 0.3,
};

const excess = (h, max) => Math.max(0, h - max);

function deltaStats(model, intervals, add) {
  const before = dayStats(model.shape, intervals);
  const after = dayStats(model.shape, intervals.concat([add]));
  return { before, after };
}

/** Shared penalties for any placement of sessions `sids` (one session or a lab block) at day/start/end. */
function commonPenalty(model, divId, facultyIds, day, start, end, W, D, parts) {
  const divInt = model.divisionDay(divId, day);
  const { before, after } = deltaStats(model, divInt, { start, end });
  parts.dayLoad = W.dayLoad * before.hours;
  parts.runDivision = W.runDivision * (excess(after.maxRun, D.maxRunHours) - excess(before.maxRun, D.maxRunHours));
  parts.idle = W.idleHour * ((after.idle - before.idle) / 60);
  let worstRun = 0;
  let worstLoad = 0;
  for (const f of facultyIds) {
    const fi = model.facultyDay(f, day);
    const d = deltaStats(model, fi, { start, end });
    worstRun = Math.max(worstRun, excess(d.after.maxRun, D.maxRunHours) - excess(d.before.maxRun, D.maxRunHours));
    worstLoad = Math.max(worstLoad, d.before.hours);
  }
  parts.runFaculty = W.runFaculty * worstRun;
  parts.facultyLoad = W.facultyLoad * worstLoad;
  if (after.hours > D.maxDayHours) parts.dayOverload = W.dayOverload * (after.hours - D.maxDayHours);
  return after;
}

const sum = (parts) => Object.values(parts).reduce((a, b) => a + b, 0);

function dayIndexDistance(model, d1, d2) {
  return Math.abs(model.shape.days.indexOf(d1) - model.shape.days.indexOf(d2));
}

/**
 * Ranked feasible candidates for one theory session.
 * opts: {seed, strict=true, weights, defaults}. strict: standard cell starts only and division <= maxDayHours.
 * Hard in EVERY pass: a subject at most once a day (a second lecture only back to back, and only when its weekly count
 * exceeds the working days), teacher max_per_day.
 * -> [{day, start, end, score, room_id, shared, parts}]
 */
export function theoryCandidates(model, sid, opts = {}) {
  const W = { ...WEIGHTS, ...(opts.weights || {}) };
  const D = { ...DEFAULTS, ...(opts.defaults || {}) };
  const strict = opts.strict !== false;
  const seed = opts.seed ?? 0;
  const i = model.info.get(sid);
  const shape = model.shape;
  const standard = new Set(standardStarts(shape, i.duration));
  const starts = strict ? [...standard] : allStarts(shape, i.duration);
  const div = model.divisions.get(i.division_id);
  const others = model.offeringPlacements(i.offering_id).filter((p) => p.sid !== sid);
  const out = [];
  for (const day of shape.days) {
    const sameDay = others.filter((p) => p.day === day);
    for (const start of starts) {
      const end = start + i.duration;
      if (sameDay.length) {
        const manyPerWeek = i.weekly !== null && i.weekly > shape.days.length;
        const adjacent = sameDay.some((p) => p.end === start || p.start === end);
        if (!(manyPerWeek && sameDay.length === 1 && adjacent)) continue;
      }
      const ev = model.evaluate(sid, day, start);
      if (!ev.ok) continue;
      if (!hardFacultyCap(model, sid, day)) continue;
      const parts = {};
      const after = commonPenalty(model, i.division_id, i.faculty_ids, day, start, end, W, D, parts);
      if (strict && after.hours > D.maxDayHours) continue;
      parts.time = start >= D.lateStart ? W.lateTheory + (start >= D.lateStart + 60 ? W.veryLateTheory : 0) : start >= D.coreStart && end <= D.coreEnd ? 0 : W.earlyTheory;
      let spread = 0;
      for (const p of others) {
        if (p.day === day) spread += W.sameSubjectSameDay;
        else if (dayIndexDistance(model, p.day, day) === 1) spread += W.sameSubjectNextDay;
      }
      parts.spread = spread;
      if (!standard.has(start)) parts.nonStandard = W.nonStandardStart;
      if (div?.home_room_id && ev.room_id !== div.home_room_id) parts.notHome = W.notHomeRoom;
      parts.jitter = W.jitter * hash01(`${seed}|${i.division_key}|${i.subject_code}|${i.seq}|${day}|${start}`);
      out.push({ day, start, end, score: sum(parts), room_id: ev.room_id, shared: ev.shared, parts });
    }
  }
  return out.sort(byScore);
}

/** Teacher max_per_day (from the snapshot faculty rows) must never be exceeded, in either pass. */
function hardFacultyCap(model, sid, day) {
  const i = model.info.get(sid);
  for (const f of i.faculty_ids) {
    const cap = model.faculty.get(f)?.max_per_day;
    if (!cap) continue;
    if (model.facultyDay(f, day).length + 1 > cap) return false;
  }
  return true;
}

const byScore = (a, b) => a.score - b.score || a.day - b.day || a.start - b.start;

/** Lab start preference (contract of the strategy): 10:45, 13:30, 08:30, then 15:45, anything else last. */
export function labStartPenalty(start, W = WEIGHTS) {
  return Object.prototype.hasOwnProperty.call(W.labStart, start) ? W.labStart[start] : W.labStartOther;
}

/**
 * Ranked feasible candidates for a lab block (all its sessions start together).
 * block: {key, sessions:[{id,...}]}; opts.affinity: Map(session id -> [room ids]) to force rooms (otherwise the server auto-picks).
 * strict: standard starts only (preference list 10:45 13:30 08:30 15:45) and division <= maxDayHours. Hard in every pass: at most one lab
 * block per batch per day (a batch never has two lab subjects the same day).
 */
export function labBlockCandidates(model, block, opts = {}) {
  const W = { ...WEIGHTS, ...(opts.weights || {}) };
  const D = { ...DEFAULTS, ...(opts.defaults || {}) };
  const strict = opts.strict !== false;
  const seed = opts.seed ?? 0;
  const sids = block.sessions.map((s) => s.id);
  const first = model.info.get(sids[0]);
  const duration = Math.max(...sids.map((s) => model.info.get(s).duration));
  const shape = model.shape;
  const standard = new Set(standardStarts(shape, duration));
  const starts = strict ? [...standard] : allStarts(shape, duration);
  const faculty = [...new Set(sids.flatMap((s) => model.info.get(s).faculty_ids))];
  const out = [];
  for (const day of shape.days) {
    // lab sessions of the involved batches that day (batch resource includes whole-batch theory, so filter by kind)
    let batchHasLab = false;
    for (const s of sids) {
      const bm = model.batOcc.get(model.info.get(s).batch_id);
      if (!bm) continue;
      for (const [os, r] of bm) if (r.day === day && model.info.get(os).kind === 'lab') batchHasLab = true;
    }
    if (batchHasLab) continue; // hard in every pass: one lab block per batch per day (so never two lab subjects a day)
    // lab blocks of the division on adjacent days (spread)
    const divLabDays = divisionLabDays(model, first.division_id);
    for (const start of starts) {
      const end = start + duration;
      const items = block.sessions.map((s) => {
        const rooms = opts.affinity?.get(s.id);
        return rooms && rooms.length ? { sid: s.id, rooms } : { sid: s.id };
      });
      const t = model.tryBlock(items, day, start);
      if (!t.ok) continue;
      if (!block.sessions.every((s) => hardFacultyCap(model, s.id, day))) continue;
      const parts = {};
      const after = commonPenalty(model, first.division_id, faculty, day, start, end, W, D, parts);
      if (strict && after.hours > D.maxDayHours) continue;
      parts.time = labStartPenalty(start, W);
      let adj = 0;
      for (const d2 of divLabDays) {
        if (d2 === day) adj += W.labSameDay;
        else if (dayIndexDistance(model, d2, day) === 1) adj += W.labAdjacentDay;
      }
      parts.labSpread = adj;
      if (!standard.has(start)) parts.nonStandard = W.nonStandardStart;
      parts.jitter = W.jitter * hash01(`${seed}|${first.division_key}|${block.key}|${day}|${start}`);
      out.push({ day, start, end, score: sum(parts), plan: t.plan, parts });
    }
  }
  return out.sort(byScore);
}

/** Days (distinct, with repeats per block) on which a division already has lab sessions. */
function divisionLabDays(model, divId) {
  const seen = new Set();
  const m = model.divOcc.get(divId);
  if (m) for (const [sid, r] of m) if (model.info.get(sid).kind === 'lab') seen.add(`${r.day}|${r.start}`);
  return [...seen].map((k) => Number(k.split('|')[0]));
}

/**
 * Orders divisions "most constrained first": by the mean (weighted by session hours) of the heaviest teacher's
 * weekly load per session, then by the number of lab subjects, then by key. Pure; works on model.info.
 */
export function divisionOrder(model) {
  const load = new Map();
  for (const i of model.info.values()) for (const f of i.faculty_ids) load.set(f, (load.get(f) || 0) + i.duration / 60);
  const per = new Map();
  for (const i of model.info.values()) {
    const heavy = i.faculty_ids.length ? Math.max(...i.faculty_ids.map((f) => load.get(f))) : 0;
    let p = per.get(i.division_id);
    if (!p) per.set(i.division_id, (p = { id: i.division_id, key: i.division_key, w: 0, h: 0, labSubjects: new Set() }));
    p.w += heavy * (i.duration / 60);
    p.h += i.duration / 60;
    if (i.kind === 'lab') p.labSubjects.add(i.subject_id);
  }
  return [...per.values()]
    .map((p) => ({ id: p.id, key: p.key, load: p.h ? p.w / p.h : 0, labSubjects: p.labSubjects.size }))
    .sort((a, b) => b.load - a.load || b.labSubjects - a.labSubjects || cmpText(a.key, b.key));
}

/** Weekly teaching hours per faculty id (all sessions of the snapshot). */
export function facultyLoads(model) {
  const load = new Map();
  for (const i of model.info.values()) for (const f of i.faculty_ids) load.set(f, (load.get(f) || 0) + i.duration / 60);
  return load;
}
