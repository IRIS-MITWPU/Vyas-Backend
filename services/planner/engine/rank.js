// Candidate generation and ranking (pure). Production port of tests/planner/real/lib/rank.mjs.
//
// Candidates are only generated when the in-memory model says the placement is feasible (faculty, batch resources,
// room); the penalty score then orders them. Lower = better. Weights, limits and hard filters come from the engine
// config (config.js); the default config reproduces the harness numbers exactly (see PLACEMENT_STRATEGY.md).
//
// Differences from the harness (all config driven, identical results with the default config):
//   * separate run limits for teachers and divisions (config.defaults.maxRunFaculty / maxRunDivision);
//   * `facultyOverDefault`: penalty per hour a teacher's day exceeds faculty_daily_load.default_max_hours
//     (only for teachers WITHOUT an explicit max_per_day; the explicit cap stays a hard filter);
//   * hard filters from rules whose severity the admin set to 'hard' (config.hard) and the generalised
//     `subjectPerDayMax` / `labPerDayMax` limits (1 = the harness behaviour, back-to-back exception included);
//   * the per-slot functions (theoryCandidateAt / labBlockCandidateAt) are exported for the repair pass and the
//     suggestions; the list functions are loops over them.
import { dayStats, standardStarts, allStarts, hash01, cmpText } from './time.js';
import { defaultEngineConfig, BASE_WEIGHTS } from './config.js';
import { homeRoomIds } from '../domain/index.js';

let DEFAULT_CONFIG = null;
const defaultConfig = () => DEFAULT_CONFIG || (DEFAULT_CONFIG = defaultEngineConfig());

export const WEIGHTS = BASE_WEIGHTS;
export const DEFAULTS = Object.freeze({ maxRunHours: 3, maxDayHours: 6, coreStart: 645, coreEnd: 930, lateStart: 945 });

const excess = (h, max) => Math.max(0, h - max);

/** Resolves {config, weights, defaults, strict, seed} (harness style overrides still work) into {W, D, H, strict, seed}. */
export function resolveOpts(opts = {}) {
  const cfg = opts.config || defaultConfig();
  const W = { ...cfg.weights, ...(opts.weights || {}) };
  const D = { ...cfg.defaults, ...(opts.defaults || {}) };
  if (opts.defaults && opts.defaults.maxRunHours !== undefined) {
    if (opts.defaults.maxRunFaculty === undefined) D.maxRunFaculty = opts.defaults.maxRunHours;
    if (opts.defaults.maxRunDivision === undefined) D.maxRunDivision = opts.defaults.maxRunHours;
  }
  return { W, D, H: cfg.hard, strict: opts.strict !== false, seed: opts.seed ?? 0 };
}

function deltaStats(model, intervals, add) {
  const before = dayStats(model.shape, intervals);
  const after = dayStats(model.shape, intervals.concat([add]));
  return { before, after };
}

const hasExplicitCap = (model, f) => !!model.faculty.get(f)?.max_per_day;

/**
 * Shared penalties for any placement of sessions (one session or a lab block) at day/start/end.
 * Fills `parts`; returns {after, hardFail, meta}. meta feeds the human reasons of suggest.js.
 */
function commonPenalty(model, divId, facultyIds, day, start, end, R, parts) {
  const { W, D, H, strict } = R;
  const divInt = model.divisionDay(divId, day);
  const { before, after } = deltaStats(model, divInt, { start, end });
  let hardFail = false;
  parts.dayLoad = W.dayLoad * before.hours;
  parts.runDivision = W.runDivision * (excess(after.maxRun, D.maxRunDivision) - excess(before.maxRun, D.maxRunDivision));
  parts.idle = W.idleHour * ((after.idle - before.idle) / 60);
  if (H.divisionRunHours !== null && after.maxRun > H.divisionRunHours && after.maxRun > before.maxRun) hardFail = true;
  if (H.divisionIdleGapMinutes !== null) {
    if (after.idle > H.divisionIdleGapMinutes && after.idle > before.idle) hardFail = true;
  }
  let worstRun = 0;
  let worstLoad = 0;
  let worstOver = 0;
  let worstFaculty = null;
  let worstHoursAfter = 0;
  for (const f of facultyIds) {
    const fi = model.facultyDay(f, day);
    const d = deltaStats(model, fi, { start, end });
    worstRun = Math.max(worstRun, excess(d.after.maxRun, D.maxRunFaculty) - excess(d.before.maxRun, D.maxRunFaculty));
    worstLoad = Math.max(worstLoad, d.before.hours);
    if (d.after.hours > worstHoursAfter || worstFaculty === null) {
      worstHoursAfter = d.after.hours;
      worstFaculty = f;
    }
    if (!hasExplicitCap(model, f)) {
      worstOver = Math.max(worstOver, excess(d.after.hours, D.facultyDefaultMaxHours) - excess(d.before.hours, D.facultyDefaultMaxHours));
      if (H.facultyDayHours !== null && d.after.hours > H.facultyDayHours) hardFail = true;
    }
    if (H.facultyRunHours !== null && d.after.maxRun > H.facultyRunHours && d.after.maxRun > d.before.maxRun) hardFail = true;
  }
  parts.runFaculty = W.runFaculty * worstRun;
  parts.facultyLoad = W.facultyLoad * worstLoad;
  if (worstOver > 0 && W.facultyOverDefault) parts.facultyOver = W.facultyOverDefault * worstOver;
  if (after.hours > D.maxDayHours) {
    parts.dayOverload = W.dayOverload * (after.hours - D.maxDayHours);
    if (strict) hardFail = true;
  }
  if (H.divisionDayHours !== null && after.hours > H.divisionDayHours) hardFail = true;
  const meta = { idleAddedMin: after.idle - before.idle, divisionHoursAfter: after.hours, facultyId: worstFaculty, facultyHoursAfter: worstHoursAfter };
  return { after, hardFail, meta };
}

const sum = (parts) => Object.values(parts).reduce((a, b) => a + b, 0);
/** Score without the seeded jitter (used to compare seeds and to rank suggestions). */
export const scoreOf = (parts) => sum(parts) - (parts.jitter || 0);

function dayIndexDistance(model, d1, d2) {
  return Math.abs(model.shape.days.indexOf(d1) - model.shape.days.indexOf(d2));
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

// ------------------------------------------------------------------ theory

/** Per-session constants of the theory candidate loop. */
export function prepTheory(model, sid, R) {
  const i = model.info.get(sid);
  const standard = new Set(standardStarts(model.shape, i.duration));
  const starts = R.strict ? [...standard] : allStarts(model.shape, i.duration);
  // A per-batch theory offering has one session series PER BATCH: the once-per-day / spread rules compare a session with the
  // placements of its own batch only (whole-batch offerings have a single series, so nothing changes for them).
  const others = model.offeringPlacements(i.offering_id).filter((p) => p.sid !== sid && model.info.get(p.sid).batch_id === i.batch_id);
  return { i, standard, starts, div: model.divisions.get(i.division_id), others };
}

/** One (day, start) slot of a theory session -> candidate or null. Every hard rule of every pass is applied here. */
export function theoryCandidateAt(model, sid, day, start, R, pre = prepTheory(model, sid, R)) {
  const { W, D, H } = R;
  const { i, standard, div, others } = pre;
  const end = start + i.duration;
  const sameDay = others.filter((p) => p.day === day);
  if (sameDay.length >= H.subjectPerDayMax) {
    const manyPerWeek = i.weekly !== null && i.weekly > model.shape.days.length;
    const adjacent = sameDay.some((p) => p.end === start || p.start === end);
    if (!(H.subjectPerDayMax === 1 && manyPerWeek && sameDay.length === 1 && adjacent)) return null;
  }
  if (H.theoryCoreWindow && !(start >= H.theoryCoreWindow.start && end <= H.theoryCoreWindow.end)) return null;
  const ev = model.evaluate(sid, day, start);
  if (!ev.ok) return null;
  if (!hardFacultyCap(model, sid, day)) return null;
  const parts = {};
  const { hardFail, meta } = commonPenalty(model, i.division_id, i.faculty_ids, day, start, end, R, parts);
  if (hardFail) return null;
  parts.time = start >= D.lateStart ? W.lateTheory + (start >= D.lateStart + 60 ? W.veryLateTheory : 0) : start >= D.coreStart && end <= D.coreEnd ? 0 : W.earlyTheory;
  let spread = 0;
  for (const p of others) {
    if (p.day === day) spread += W.sameSubjectSameDay;
    else if (dayIndexDistance(model, p.day, day) === 1) spread += W.sameSubjectNextDay;
  }
  parts.spread = spread;
  if (!standard.has(start)) parts.nonStandard = W.nonStandardStart;
  // contract 10.3: a division with home classrooms never leaves them (the room pick refuses any other room), so there is
  // no "not home" penalty any more; `home` only feeds the suggestion text ("keeps X in room")
  const home = homeRoomIds(div).includes(ev.room_id);
  parts.jitter = W.jitter * hash01(`${R.seed}|${i.division_key}|${i.subject_code}|${i.seq}|${day}|${start}`);
  return { day, start, end, score: sum(parts), room_id: ev.room_id, shared: ev.shared, parts, meta: { ...meta, home } };
}

/**
 * Ranked feasible candidates for one theory session.
 * opts: {seed, strict=true, config, weights, defaults}. strict: standard cell starts only and division <= maxDayHours.
 * Hard in EVERY pass: a subject at most subjectPerDayMax times a day (default 1; a second lecture only back to back, and only
 * when its weekly count exceeds the working days), teacher max_per_day, plus every rule the admin made 'hard'.
 * -> [{day, start, end, score, room_id, shared, parts, meta}]
 */
export function theoryCandidates(model, sid, opts = {}) {
  const R = resolveOpts(opts);
  const pre = prepTheory(model, sid, R);
  const out = [];
  for (const day of model.shape.days) {
    for (const start of pre.starts) {
      const c = theoryCandidateAt(model, sid, day, start, R, pre);
      if (c) out.push(c);
    }
  }
  return out.sort(byScore);
}

// ------------------------------------------------------------------ labs

/** Lab start preference (contract of the strategy): 10:45, 13:30, 08:30, then 15:45, anything else last. */
export function labStartPenalty(start, W = BASE_WEIGHTS) {
  return Object.prototype.hasOwnProperty.call(W.labStart, start) ? W.labStart[start] : W.labStartOther;
}

/** Hard in every pass: a batch has at most `labPerDayMax` lab blocks per day (lab sessions of the batch that day, not whole-batch theory). */
export function labDayOk(model, sids, day, R) {
  for (const s of sids) {
    const bm = model.batOcc.get(model.info.get(s).batch_id);
    if (!bm) continue;
    let n = 0;
    for (const [os, r] of bm) if (r.day === day && model.info.get(os).kind === 'lab') n += 1;
    if (n >= R.H.labPerDayMax) return false;
  }
  return true;
}

/** Days (distinct, with repeats per block) on which a division already has lab sessions. */
function divisionLabDays(model, divId) {
  const seen = new Set();
  const m = model.divOcc.get(divId);
  if (m) for (const [sid, r] of m) if (model.info.get(sid).kind === 'lab') seen.add(`${r.day}|${r.start}`);
  return [...seen].map((k) => Number(k.split('|')[0]));
}

/** Per-block constants of the lab candidate loop. */
export function prepLab(model, block, R) {
  const sids = block.sessions.map((s) => s.id);
  const first = model.info.get(sids[0]);
  const duration = Math.max(...sids.map((s) => model.info.get(s).duration));
  const standard = new Set(standardStarts(model.shape, duration));
  const starts = R.strict ? [...standard] : allStarts(model.shape, duration);
  const faculty = [...new Set(sids.flatMap((s) => model.info.get(s).faculty_ids))];
  return { sids, first, duration, standard, starts, faculty };
}

/** One (day, start) slot of a lab block -> candidate or null. The day-level rule (labDayOk) is checked by the caller. */
export function labBlockCandidateAt(model, block, day, start, R, pre = prepLab(model, block, R), divLabDays = divisionLabDays(model, pre.first.division_id)) {
  const { W } = R;
  const { sids, first, duration, standard, faculty } = pre;
  const end = start + duration;
  const items = block.sessions.map((s) => ({ sid: s.id }));
  const t = model.tryBlock(items, day, start);
  if (!t.ok) return null;
  if (!sids.every((s) => hardFacultyCap(model, s, day))) return null;
  const parts = {};
  const { hardFail, meta } = commonPenalty(model, first.division_id, faculty, day, start, end, R, parts);
  if (hardFail) return null;
  parts.time = labStartPenalty(start, W);
  let adj = 0;
  for (const d2 of divLabDays) {
    if (d2 === day) adj += W.labSameDay;
    else if (dayIndexDistance(model, d2, day) === 1) adj += W.labAdjacentDay;
  }
  parts.labSpread = adj;
  if (!standard.has(start)) parts.nonStandard = W.nonStandardStart;
  parts.jitter = W.jitter * hash01(`${R.seed}|${first.division_key}|${block.key}|${day}|${start}`);
  return { day, start, end, score: sum(parts), plan: t.plan, parts, meta };
}

/**
 * Ranked feasible candidates for a lab block (all its sessions start together).
 * block: {key, sessions:[{id,...}]}. strict: standard starts only (preference list 10:45 13:30 08:30 15:45) and
 * division <= maxDayHours. Hard in every pass: at most labPerDayMax lab blocks per batch per day.
 */
export function labBlockCandidates(model, block, opts = {}) {
  const R = resolveOpts(opts);
  const pre = prepLab(model, block, R);
  const out = [];
  for (const day of model.shape.days) {
    if (!labDayOk(model, pre.sids, day, R)) continue;
    const divLabDays = divisionLabDays(model, pre.first.division_id);
    for (const start of pre.starts) {
      const c = labBlockCandidateAt(model, block, day, start, R, pre, divLabDays);
      if (c) out.push(c);
    }
  }
  return out.sort(byScore);
}

// ------------------------------------------------------------------ ordering

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
